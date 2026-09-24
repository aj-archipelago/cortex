import { createHash } from 'node:crypto';

export function isPersonalEntity(entity, userId) {
    return Boolean(userId && entity?.personalOwnerId === userId && entity.kind !== 'colleague');
}

export function canAccessEntity(entity, userId) {
    if (!entity || !userId || entity.isSystem) return false;
    if (entity.requiredEnvVars?.some(key => !process.env[key])) return false;
    if (entity.kind === 'colleague') {
        if (!entity.colleagueOwnerId || entity.assocUserIds?.length !== 1 || entity.assocUserIds[0] !== entity.colleagueOwnerId) return false;
        return Boolean(entity.colleagueOwnerId === userId || entity.assistantVisibility === 'public' || entity.assistantAccess?.some(entry => entry.userId === userId));
    }
    if (entity.personalOwnerId) return isPersonalEntity(entity, userId);
    return !entity.assocUserIds?.length || entity.assocUserIds.includes(userId);
}

// Personal memory keeps its existing address. Every other entity has a separate
// memory address for each user, including shared/catalog entities.
export function entityMemoryContextId(entity, userId) {
    if (!canAccessEntity(entity, userId)) throw new Error('Entity not available');
    if (isPersonalEntity(entity, userId)) return userId;
    return `entity-memory-${createHash('sha256').update(JSON.stringify([userId, entity.id])).digest('hex')}`;
}

export function preferenceId(entityId, userId) {
    return createHash('sha256').update(JSON.stringify([userId, entityId])).digest('hex');
}

export async function getEntityPreferences(store, entityId, userId) {
    if (!store.entityPreferences) return {};
    return (await (await store.entityPreferences()).findOne({ _id: preferenceId(entityId, userId) })) || {};
}

export async function getEntityPreferencesBatch(store, entityIds, userId) {
    if (!store.entityPreferences || !entityIds.length) return new Map();
    const collection = await store.entityPreferences();
    const records = await collection.find({ _id: { $in: entityIds.map(id => preferenceId(id, userId)) } }).toArray();
    const byId = new Map(records.map(row => [row._id, row]));
    return new Map(entityIds.map(id => [id, byId.get(preferenceId(id, userId)) || {}]));
}

export async function saveEntityPreferences(store, entityId, userId, changes) {
    if (!Object.keys(changes).length) return;
    const collection = await store.entityPreferences();
    await collection.updateOne(
        { _id: preferenceId(entityId, userId) },
        { $set: { ...changes, entityId, userId, updatedAt: new Date() } },
        { upsert: true },
    );
}

export function validateEntityPreferences(input, isValidModel = () => true) {
    const result = {};
    if (input.model !== undefined) {
        if (input.model !== null && (typeof input.model !== 'string' || !input.model || input.model.length > 128 || !isValidModel(input.model))) throw new Error('Model is not available');
        result.model = input.model;
    }
    if (input.reasoningEffort !== undefined) {
        if (!['none', 'low', 'medium', 'high'].includes(input.reasoningEffort)) throw new Error('Invalid reasoning effort');
        result.reasoningEffort = input.reasoningEffort;
    }
    if (input.memoryLearning !== undefined) {
        if (typeof input.memoryLearning !== 'boolean') throw new Error('Invalid memory setting');
        result.memoryLearning = input.memoryLearning;
    }
    return result;
}

export function memoryArgs(args) {
    return { ...args, contextId: args.memoryContextId || args.contextId };
}
