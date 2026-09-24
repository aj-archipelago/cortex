import { canAccessEntity } from './entityPreferences.js';

export const DIRECTORY_LIMIT = 50;
export const DIRECTORY_MAX_LIMIT = 100;
export const DIRECTORY_PROJECTION = {
    id: 1, name: 1, description: 1, isDefault: 1, isSystem: 1,
    kind: 1, avatar: 1, colleagueOwnerId: 1, personalOwnerId: 1,
    assocUserIds: 1, colleagueStatus: 1, assistantVisibility: 1,
    assistantAccess: 1, assistantMaterials: 1, assistantMaterialsContext: 1,
    modelOverride: 1, reasoningEffort: 1, useMemory: 1, requiredEnvVars: 1,
};

export function directoryOptions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid directory options');
    const options = { ...input };
    options.limit = Math.min(DIRECTORY_MAX_LIMIT, Math.max(1, Math.trunc(Number(input.limit)) || DIRECTORY_LIMIT));
    options.offset = Math.min(1000000, Math.max(0, Math.trunc(Number(input.offset)) || 0));
    options.query = String(input.query || '').trim().slice(0, 200);
    options.sort = ['name', 'description', 'status'].includes(input.sort) ? input.sort : 'name';
    options.descending = input.descending === true;
    if (input.ids !== undefined) {
        if (!Array.isArray(input.ids) || input.ids.length > DIRECTORY_MAX_LIMIT || input.ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Invalid assistant IDs');
        options.ids = [...new Set(input.ids)];
    }
    return options;
}

export function assistantAccessQuery(userId) {
    if (!userId) throw new Error('User context is required');
    return { $or: [
        { kind: 'colleague', colleagueOwnerId: { $type: 'string', $ne: '' }, $expr: { $eq: ['$assocUserIds', ['$colleagueOwnerId']] }, $or: [{ colleagueOwnerId: userId }, { assistantVisibility: 'public' }, { 'assistantAccess.userId': userId }] },
        { kind: { $ne: 'colleague' }, $or: [{ personalOwnerId: userId }, { personalOwnerId: null, $or: [{ assocUserIds: userId }, { assocUserIds: { $exists: false } }, { assocUserIds: { $size: 0 } }] }] },
    ] };
}

export function assistantDirectoryQuery(userId, options) {
    const clauses = [assistantAccessQuery(userId), { isSystem: { $ne: true } }];
    if (!options.includeDefault) clauses.push({ isDefault: { $ne: true } });
    if (options.ids) clauses.push({ id: { $in: options.ids } });
    if (options.materialsContext) clauses.push({ assistantMaterialsContext: options.materialsContext });
    if (options.query) {
        const regex = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        clauses.push({ $or: [{ name: { $regex: regex, $options: 'i' } }, { description: { $regex: regex, $options: 'i' } }, { id: options.query }] });
    }
    if (options.status === 'active') clauses.push({ colleagueStatus: { $nin: ['paused', 'archived'] } });
    else if (['paused', 'archived'].includes(options.status)) clauses.push({ colleagueStatus: options.status });
    else if (options.status !== 'all') clauses.push({ colleagueStatus: { $ne: 'archived' } });
    const owned = { $or: [{ personalOwnerId: userId }, { colleagueOwnerId: userId }] };
    if (options.access === 'mine') clauses.push(owned);
    if (options.access === 'shared') clauses.push({ $nor: [owned], assistantVisibility: { $ne: 'public' } });
    if (options.access === 'public') clauses.push({ $nor: [owned], assistantVisibility: 'public' });
    // Keep unavailable deployments out before pagination, as well as checking
    // authorization on returned records. No secrets or prompts enter this query.
    clauses.push({ requiredEnvVars: { $not: { $elemMatch: { $nin: Object.keys(process.env).filter(key => process.env[key]) } } } });
    return { $and: clauses };
}

export async function findAssistantPage(store, userId, input = {}) {
    const options = directoryOptions(input);
    const collection = await store._getCollection();
    const query = assistantDirectoryQuery(userId, options);
    const sortField = options.sort === 'status' ? 'colleagueStatus' : options.sort;
    const sort = { [sortField]: options.descending ? -1 : 1, id: options.descending ? -1 : 1 };
    const [records, total] = await Promise.all([
        collection.find(query, { projection: DIRECTORY_PROJECTION }).sort(sort).skip(options.offset).limit(options.limit).toArray(),
        collection.countDocuments(query),
    ]);
    return {
        entities: records.filter(entity => canAccessEntity(entity, userId)),
        total, offset: options.offset, limit: options.limit,
        nextOffset: options.offset + options.limit < total ? options.offset + options.limit : null,
    };
}
