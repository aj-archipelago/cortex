#!/usr/bin/env node

import "dotenv/config";
import { MongoClient } from "mongodb";
import {
    classifyBlankOrphanEntities,
    getEntitySignals,
    resolveCanonicalPersonalEntity,
    summarizeEntity,
} from "./lib/personalEntityCleanup.js";

const DEFAULT_LOCAL_URI = "mongodb://127.0.0.1:27017/cortex";

function getArgValue(flag) {
    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return null;
    }
    return process.argv[index + 1] || null;
}

function getArgValues(flag) {
    const values = [];
    for (let index = 0; index < process.argv.length; index += 1) {
        if (process.argv[index] === flag && process.argv[index + 1]) {
            values.push(process.argv[index + 1]);
        }
    }
    return values;
}

const shouldApply = process.argv.includes("--apply");
const asJson = process.argv.includes("--json");
const uri = getArgValue("--uri") || process.env.MONGO_URI || DEFAULT_LOCAL_URI;
const explicitDbName = getArgValue("--db") || null;
const defaultAiName = getArgValue("--default-ai-name") || "Jarvis";
const defaultEntityNames = getArgValues("--default-name");
const cleanupOptions = {
    defaultAiName,
    defaultEntityNames: defaultEntityNames.length
        ? defaultEntityNames
        : [defaultAiName],
};

async function loadCollections(db) {
    const [users, entities] = await Promise.all([
        db.collection("users")
            .find(
                {},
                {
                    projection: {
                        userId: 1,
                        username: 1,
                        name: 1,
                        contextId: 1,
                        aiName: 1,
                        personalEntityId: 1,
                    },
                },
            )
            .toArray(),
        db.collection("entities").find({}).toArray(),
    ]);

    return { users, entities };
}

function buildPlan(users, entities, options) {
    const resolutions = users
        .map((user) => resolveCanonicalPersonalEntity(user, entities, options))
        .filter((result) => result.status !== "no-related-entities");

    const resolved = resolutions.filter((result) => result.status === "resolved");
    const unresolved = resolutions.filter(
        (result) => result.status === "unresolved",
    );

    const userPersonalEntityUpdates = [];
    const canonicalEntityRepairs = [];
    const duplicateEntityDeletes = [];
    const futureReferencedEntityIds = new Set();

    for (const result of resolved) {
        const { user, canonical, orphanableDuplicates } = result;
        const canonicalSignals = getEntitySignals(user, canonical, options);
        futureReferencedEntityIds.add(canonical.id);

        if (user.personalEntityId !== canonical.id) {
            userPersonalEntityUpdates.push({
                userId: user._id,
                username: user.username,
                from: user.personalEntityId || null,
                to: canonical.id,
            });
        }

        if (!canonicalSignals.owned || !canonicalSignals.associated) {
            canonicalEntityRepairs.push({
                entityId: canonical.id,
                username: user.username,
                contextId: user.contextId,
                personalOwnerIdBefore: canonical.personalOwnerId || null,
                createdByBefore: canonical.createdBy || null,
                assocUserIdsBefore: Array.isArray(canonical.assocUserIds)
                    ? canonical.assocUserIds
                    : [],
            });
        } else if (canonical.personalOwnerId !== user.contextId) {
            canonicalEntityRepairs.push({
                entityId: canonical.id,
                username: user.username,
                contextId: user.contextId,
                personalOwnerIdBefore: canonical.personalOwnerId || null,
                createdByBefore: canonical.createdBy || null,
                assocUserIdsBefore: Array.isArray(canonical.assocUserIds)
                    ? canonical.assocUserIds
                    : [],
            });
        }

        for (const duplicate of orphanableDuplicates) {
            duplicateEntityDeletes.push({
                entityId: duplicate.id,
                username: user.username,
                canonicalEntityId: canonical.id,
                summary: summarizeEntity(duplicate, user, options),
            });
        }
    }

    const orphanDeletes = classifyBlankOrphanEntities(
        entities,
        [...futureReferencedEntityIds],
        options,
    )
        .filter(
            (entity) =>
                !duplicateEntityDeletes.some(
                    (candidate) => candidate.entityId === entity.id,
                ),
        )
        .map((entity) => ({
            entityId: entity.id,
            summary: summarizeEntity(entity, null, options),
        }));

    return {
        resolved,
        unresolved,
        userPersonalEntityUpdates,
        canonicalEntityRepairs,
        duplicateEntityDeletes,
        orphanDeletes,
    };
}

async function applyPlan(db, plan) {
    const users = db.collection("users");
    const entities = db.collection("entities");
    const applied = {
        userPersonalEntityUpdates: 0,
        canonicalEntityRepairs: 0,
        duplicateEntityDeletes: 0,
        orphanDeletes: 0,
    };

    for (const update of plan.userPersonalEntityUpdates) {
        await users.updateOne(
            { _id: update.userId },
            { $set: { personalEntityId: update.to } },
        );
        applied.userPersonalEntityUpdates += 1;
    }

    for (const repair of plan.canonicalEntityRepairs) {
        await entities.updateOne(
            { id: repair.entityId },
            {
                $set: {
                    personalOwnerId: repair.contextId,
                    createdBy: repair.contextId,
                },
                $addToSet: {
                    assocUserIds: repair.contextId,
                },
            },
        );
        applied.canonicalEntityRepairs += 1;
    }

    for (const deletion of plan.duplicateEntityDeletes) {
        await entities.deleteOne({ id: deletion.entityId });
        applied.duplicateEntityDeletes += 1;
    }

    for (const deletion of plan.orphanDeletes) {
        await entities.deleteOne({ id: deletion.entityId });
        applied.orphanDeletes += 1;
    }

    return applied;
}

function formatReport(uriValue, dbName, plan, options) {
    return {
        target: { uri: uriValue, db: dbName },
        options,
        summary: {
            resolvedUsers: plan.resolved.length,
            unresolvedUsers: plan.unresolved.length,
            userPersonalEntityUpdates: plan.userPersonalEntityUpdates.length,
            canonicalEntityRepairs: plan.canonicalEntityRepairs.length,
            duplicateEntityDeletes: plan.duplicateEntityDeletes.length,
            orphanDeletes: plan.orphanDeletes.length,
        },
        resolved: plan.resolved.map((result) => ({
            username: result.user.username,
            aiName: result.user.aiName || null,
            currentPersonalEntityId: result.user.personalEntityId || null,
            canonical: summarizeEntity(result.canonical, result.user, options),
            related: result.related.map((entity) =>
                summarizeEntity(entity, result.user, options),
            ),
            orphanableDuplicates: result.orphanableDuplicates.map((entity) =>
                summarizeEntity(entity, result.user, options),
            ),
        })),
        unresolved: plan.unresolved.map((result) => ({
            username: result.user.username,
            aiName: result.user.aiName || null,
            reason: result.reason,
            currentPersonalEntityId: result.user.personalEntityId || null,
            related: result.related.map((entity) =>
                summarizeEntity(entity, result.user, options),
            ),
            candidates: result.candidates.map((entity) =>
                summarizeEntity(entity, result.user, options),
            ),
        })),
        actions: {
            userPersonalEntityUpdates: plan.userPersonalEntityUpdates,
            canonicalEntityRepairs: plan.canonicalEntityRepairs,
            duplicateEntityDeletes: plan.duplicateEntityDeletes,
            orphanDeletes: plan.orphanDeletes,
        },
    };
}

async function main() {
    const client = new MongoClient(uri);
    await client.connect();

    try {
        const db = explicitDbName ? client.db(explicitDbName) : client.db();
        const { users, entities } = await loadCollections(db);
        const plan = buildPlan(users, entities, cleanupOptions);
        const report = formatReport(uri, db.databaseName, plan, cleanupOptions);

        if (asJson) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            console.log(`Target: ${report.target.uri} (${report.target.db})`);
            console.log(shouldApply ? "Mode: APPLY" : "Mode: DRY RUN");
            console.log(
                `Resolved users: ${report.summary.resolvedUsers}, unresolved: ${report.summary.unresolvedUsers}`,
            );
            console.log(
                `User pointer updates: ${report.summary.userPersonalEntityUpdates}`,
            );
            console.log(
                `Canonical entity repairs: ${report.summary.canonicalEntityRepairs}`,
            );
            console.log(
                `Duplicate entity deletes: ${report.summary.duplicateEntityDeletes}`,
            );
            console.log(`Blank orphan deletes: ${report.summary.orphanDeletes}`);
            console.log();

            if (report.actions.userPersonalEntityUpdates.length > 0) {
                console.log("User personalEntityId updates:");
                for (const update of report.actions.userPersonalEntityUpdates) {
                    console.log(
                        `  - ${update.username}: ${update.from || "<unset>"} -> ${update.to}`,
                    );
                }
                console.log();
            }

            if (report.actions.duplicateEntityDeletes.length > 0) {
                console.log("Duplicate entity deletes:");
                for (const deletion of report.actions.duplicateEntityDeletes) {
                    console.log(
                        `  - ${deletion.username}: delete ${deletion.entityId} (${deletion.summary.name})`,
                    );
                }
                console.log();
            }

            if (report.unresolved.length > 0) {
                console.log("Unresolved users:");
                for (const unresolved of report.unresolved) {
                    console.log(
                        `  - ${unresolved.username}: ${unresolved.reason} (${unresolved.related.length} related entities)`,
                    );
                }
                console.log();
            }
        }

        if (!shouldApply) {
            return;
        }

        const applied = await applyPlan(db, plan);
        if (asJson) {
            console.log(JSON.stringify({ applied }, null, 2));
        } else {
            console.log("Applied:");
            console.log(
                `  userPersonalEntityUpdates=${applied.userPersonalEntityUpdates}`,
            );
            console.log(
                `  canonicalEntityRepairs=${applied.canonicalEntityRepairs}`,
            );
            console.log(
                `  duplicateEntityDeletes=${applied.duplicateEntityDeletes}`,
            );
            console.log(`  orphanDeletes=${applied.orphanDeletes}`);
        }
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
});
