const DEFAULT_AI_NAME = "Jarvis";

function normalizeDefaultNames(options = {}) {
    const names = options.defaultEntityNames?.length
        ? options.defaultEntityNames
        : [options.defaultAiName || DEFAULT_AI_NAME];

    return new Set(names.map(normalizeName).filter(Boolean));
}

export function normalizeName(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

export function hasMeaningfulWorkspace(workspace) {
    if (!workspace || typeof workspace !== "object") {
        return false;
    }

    return Boolean(
        workspace.shareName ||
            workspace.containerId ||
            workspace.url ||
            workspace.secret ||
            workspace.bootstrapSecret ||
            workspace.status,
    );
}

export function hasMeaningfulEntityState(entity) {
    return Boolean(
        hasMeaningfulWorkspace(entity?.workspace) ||
            (entity?.resources || []).length > 0 ||
            Object.keys(entity?.customTools || {}).length > 0 ||
            Object.keys(entity?.secrets || {}).length > 0,
    );
}

export function getEntitySignals(user, entity, options = {}) {
    const aiName = normalizeName(user?.aiName || options.defaultAiName || DEFAULT_AI_NAME);
    const entityName = normalizeName(entity?.name);
    const assocUserIds = Array.isArray(entity?.assocUserIds)
        ? entity.assocUserIds
        : [];
    const defaultNames = normalizeDefaultNames(options);

    return {
        referenced:
            Boolean(user?.personalEntityId) && entity?.id === user.personalEntityId,
        personalOwner:
            Boolean(user?.contextId) && entity?.personalOwnerId === user.contextId,
        owned: Boolean(user?.contextId) && entity?.createdBy === user.contextId,
        associated:
            Boolean(user?.contextId) && assocUserIds.includes(user.contextId),
        aiNameMatch: Boolean(aiName) && entityName === aiName,
        knownDefaultName: defaultNames.has(entityName),
        meaningfulState: hasMeaningfulEntityState(entity),
        blank: !hasMeaningfulEntityState(entity),
    };
}

export function getRelatedEntitiesForUser(user, entities, options = {}) {
    return entities
        .filter((entity) => !entity?.isSystem)
        .filter((entity) => {
            const signals = getEntitySignals(user, entity, options);
            return (
                signals.referenced ||
                signals.personalOwner ||
                signals.owned ||
                signals.associated
            );
        });
}

function isLikelyPersonalCandidate(user, entity, relatedCount, options) {
    const signals = getEntitySignals(user, entity, options);
    return (
        signals.referenced ||
        signals.personalOwner ||
        signals.aiNameMatch ||
        (relatedCount === 1 && (signals.owned || signals.associated))
    );
}

function scoreCandidate(user, entity, options) {
    const signals = getEntitySignals(user, entity, options);
    let score = 0;

    if (signals.personalOwner) score += 800;
    if (signals.owned) score += 500;
    if (signals.associated) score += 250;
    if (signals.referenced) score += 200;
    if (signals.aiNameMatch) score += 50;
    if (signals.meaningfulState) score += 80;
    if (!entity?.isSystem) score += 10;

    return score;
}

function compareByRecency(a, b) {
    const updatedA = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const updatedB = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return updatedB - updatedA;
}

function isLikelyPersonalDuplicate(user, entity, options) {
    const signals = getEntitySignals(user, entity, options);
    return (
        signals.referenced ||
        signals.personalOwner ||
        signals.aiNameMatch ||
        signals.knownDefaultName
    );
}

export function resolveCanonicalPersonalEntity(user, entities, options = {}) {
    const related = getRelatedEntitiesForUser(user, entities, options);
    if (related.length === 0) {
        return {
            status: "no-related-entities",
            user,
            related: [],
            candidates: [],
            duplicates: [],
            orphanableDuplicates: [],
        };
    }

    let candidates = related.filter((entity) =>
        isLikelyPersonalCandidate(user, entity, related.length, options),
    );

    if (candidates.length === 0 && related.length === 1) {
        candidates = [...related];
    }

    if (candidates.length === 0) {
        return {
            status: "unresolved",
            reason: "no-likely-personal-candidates",
            user,
            related,
            candidates: [],
            duplicates: [],
            orphanableDuplicates: [],
        };
    }

    const ranked = [...candidates].sort((left, right) => {
        const scoreDiff =
            scoreCandidate(user, right, options) - scoreCandidate(user, left, options);
        return scoreDiff !== 0 ? scoreDiff : compareByRecency(left, right);
    });

    const top = ranked[0];
    const second = ranked[1] || null;
    const topSignals = getEntitySignals(user, top, options);
    const statefulCandidates = ranked.filter(
        (entity) => getEntitySignals(user, entity, options).meaningfulState,
    );
    const scoreGap =
        second == null
            ? Number.POSITIVE_INFINITY
            : scoreCandidate(user, top, options) - scoreCandidate(user, second, options);

    const hasStateConflict =
        !topSignals.meaningfulState &&
        ranked.some((entity) => {
            if (entity.id === top.id) {
                return false;
            }
            return getEntitySignals(user, entity, options).meaningfulState;
        });

    const hasStrongIdentity =
        (topSignals.personalOwner || topSignals.owned) &&
        topSignals.owned &&
        topSignals.associated &&
        (topSignals.aiNameMatch || topSignals.referenced);

    if (statefulCandidates.length > 1) {
        return {
            status: "unresolved",
            reason: "multiple-stateful-candidates",
            user,
            related,
            candidates: ranked,
            duplicates: [],
            orphanableDuplicates: [],
        };
    }

    if (hasStateConflict) {
        return {
            status: "unresolved",
            reason: "stateful-conflict",
            user,
            related,
            candidates: ranked,
            duplicates: [],
            orphanableDuplicates: [],
        };
    }

    if (second && scoreGap < 100 && !hasStrongIdentity) {
        return {
            status: "unresolved",
            reason: "ambiguous-score-gap",
            user,
            related,
            candidates: ranked,
            duplicates: [],
            orphanableDuplicates: [],
        };
    }

    const duplicates = related.filter((entity) => entity.id !== top.id);
    const orphanableDuplicates = duplicates.filter(
        (entity) =>
            isLikelyPersonalDuplicate(user, entity, options) &&
            !getEntitySignals(user, entity, options).meaningfulState,
    );

    return {
        status: "resolved",
        user,
        canonical: top,
        related,
        candidates: ranked,
        duplicates,
        orphanableDuplicates,
    };
}

export function classifyBlankOrphanEntities(
    entities,
    referencedEntityIds,
    options = {},
) {
    const referenced = new Set(referencedEntityIds.filter(Boolean));

    return entities.filter((entity) => {
        const signals = getEntitySignals({}, entity, options);
        const assocUserIds = Array.isArray(entity?.assocUserIds)
            ? entity.assocUserIds
            : [];

        return (
            !entity?.isSystem &&
            !entity?.isDefault &&
            !referenced.has(entity?.id) &&
            !entity?.personalOwnerId &&
            !entity?.createdBy &&
            assocUserIds.length === 0 &&
            !signals.meaningfulState &&
            signals.knownDefaultName
        );
    });
}

export function summarizeEntity(entity, user = null, options = {}) {
    const signals = getEntitySignals(user || {}, entity, options);
    return {
        id: entity?.id || null,
        name: entity?.name || null,
        personalOwnerId: entity?.personalOwnerId || null,
        createdBy: entity?.createdBy || null,
        assocUserIds: Array.isArray(entity?.assocUserIds)
            ? entity.assocUserIds
            : [],
        workspace: hasMeaningfulWorkspace(entity?.workspace),
        resources: (entity?.resources || []).length,
        customTools: Object.keys(entity?.customTools || {}).length,
        secrets: Object.keys(entity?.secrets || {}).length,
        signals,
    };
}
