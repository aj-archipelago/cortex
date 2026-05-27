import test from "ava";
import {
    classifyBlankOrphanEntities,
    resolveCanonicalPersonalEntity,
} from "../../scripts/lib/personalEntityCleanup.js";

test("resolveCanonicalPersonalEntity prefers the owned aiName match over a stale referenced default", (t) => {
    const user = {
        username: "lana@example.com",
        contextId: "ctx-1",
        aiName: "Lana",
        personalEntityId: "stale-jarvis",
    };
    const entities = [
        {
            id: "stale-jarvis",
            name: "Jarvis",
            createdBy: null,
            assocUserIds: [],
        },
        {
            id: "real-lana",
            name: "Lana",
            createdBy: "ctx-1",
            assocUserIds: ["ctx-1"],
        },
    ];

    const result = resolveCanonicalPersonalEntity(user, entities);

    t.is(result.status, "resolved");
    t.is(result.canonical.id, "real-lana");
    t.deepEqual(
        result.orphanableDuplicates.map((entity) => entity.id),
        ["stale-jarvis"],
    );
});

test("resolveCanonicalPersonalEntity leaves conflicting stateful candidates unresolved", (t) => {
    const user = {
        username: "lana@example.com",
        contextId: "ctx-1",
        aiName: "Lana",
        personalEntityId: "stale-jarvis",
    };
    const entities = [
        {
            id: "stale-jarvis",
            name: "Jarvis",
            createdBy: null,
            assocUserIds: [],
            workspace: { shareName: "workspace-old" },
        },
        {
            id: "real-lana",
            name: "Lana",
            createdBy: "ctx-1",
            assocUserIds: ["ctx-1"],
        },
    ];

    const result = resolveCanonicalPersonalEntity(user, entities);

    t.is(result.status, "unresolved");
    t.is(result.reason, "stateful-conflict");
});

test("classifyBlankOrphanEntities only returns blank unowned default-name orphans", (t) => {
    const entities = [
        { id: "jarvis-1", name: "Jarvis", assocUserIds: [], createdBy: null },
        {
            id: "lana-1",
            name: "Lana",
            assocUserIds: [],
            createdBy: null,
        },
        {
            id: "jarvis-2",
            name: "Jarvis",
            assocUserIds: [],
            createdBy: null,
            workspace: { shareName: "workspace-old" },
        },
    ];

    const result = classifyBlankOrphanEntities(entities, []);

    t.deepEqual(
        result.map((entity) => entity.id),
        ["jarvis-1"],
    );
});

test("default names can be configured for non-default deployments", (t) => {
    const entities = [
        { id: "custom-1", name: "CustomBot", assocUserIds: [], createdBy: null },
        { id: "jarvis-1", name: "Jarvis", assocUserIds: [], createdBy: null },
    ];

    const result = classifyBlankOrphanEntities(entities, [], {
        defaultAiName: "CustomBot",
    });

    t.deepEqual(
        result.map((entity) => entity.id),
        ["custom-1"],
    );
});
