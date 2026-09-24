import { createHash } from 'node:crypto';

// Run at deployment, never on a directory request. Existing identities and
// permissions remain unchanged; only deterministic lookup metadata is added.
export async function migrateAssistantDirectory(collection) {
    const indexes = [
        { id: 1 },
        { name: 1, id: 1 }, { description: 1, id: 1 }, { colleagueStatus: 1, id: 1 },
        { assocUserIds: 1, name: 1, id: 1 },
        { colleagueOwnerId: 1, name: 1, id: 1 },
        { assistantVisibility: 1, name: 1, id: 1 },
        { 'assistantAccess.userId': 1, name: 1, id: 1 },
        { assistantMaterialsContext: 1 },
    ];
    const existing = await collection.listIndexes().toArray().catch(error => {
        if (error.code === 26) return []; // A new deployment has no collection yet.
        throw error;
    });
    for (const index of indexes) {
        // Preserve the unique ID index where it exists; older deployments may
        // have disabled automatic index creation and still need a lookup index.
        if (!existing.some(entry => JSON.stringify(entry.key) === JSON.stringify(index))) {
            await collection.createIndex(index, { background: true });
        }
    }
    let batch = [], updated = 0;
    const flush = async () => { if (batch.length) { const result = await collection.bulkWrite(batch, { ordered: false }); updated += result.modifiedCount; batch = []; } };
    for await (const entity of collection.find({ kind: 'colleague', assistantMaterialsContext: { $exists: false } }, { projection: { id: 1 } }).batchSize(200)) {
        if (!entity.id) continue;
        batch.push({ updateOne: { filter: { _id: entity._id, assistantMaterialsContext: { $exists: false } }, update: { $set: { assistantMaterialsContext: `applet-shared:${createHash('sha256').update(`assistant-materials:${entity.id}`).digest('hex').slice(0, 24)}` } } } });
        if (batch.length >= 200) await flush();
    }
    await flush();
    return { updated };
}
