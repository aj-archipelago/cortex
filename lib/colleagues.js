import { findAssistantPage } from './assistantDirectory.js';
import { randomUUID, createHash } from 'node:crypto';
import { canAccessEntity, isPersonalEntity, entityMemoryContextId, getEntityPreferences, getEntityPreferencesBatch, saveEntityPreferences, validateEntityPreferences } from './entityPreferences.js';
import { assistantExecutionUser } from './assistantExecution.js';

export const COLLEAGUE_STATES = ['active', 'paused', 'archived'];
export const COLLEAGUE_AVATARS = [
    'orbit',
    'sprout',
    'prism',
    'spark',
    'wave',
    'compass',
];
export function colleagueDirectory(id) {
    return `/workspace/colleagues/${createHash('sha256').update(String(id)).digest('hex').slice(0, 24)}`;
}
export function isOwnedColleague(entity, userId) {
    return Boolean(
        userId &&
            entity?.kind === 'colleague' &&
            entity.colleagueOwnerId === userId &&
            entity.assocUserIds?.length === 1 &&
            entity.assocUserIds[0] === userId,
    );
}
export function canEditColleague(entity, userId) {
    return Boolean(isOwnedColleague(entity, userId) || (canAccessEntity(entity, userId) && entity.assistantAccess?.some(entry => entry.userId === userId && entry.role === 'editor')));
}
export function assistantMaterialContext(id) {
    return `applet-shared:${createHash('sha256').update(`assistant-materials:${id}`).digest('hex').slice(0, 24)}`;
}
export function publicColleague(entity, userId = entity.colleagueOwnerId, preferences = {}) {
    const personal = isPersonalEntity(entity, userId);
    const owned = personal || isOwnedColleague(entity, userId);
    return {
        id: entity.id,
        name: entity.name,
        description: entity.description || '',
        instructions: owned || canEditColleague(entity, userId) ? entity.identity || '' : '',
        avatar: personal ? 'personal' : entity.avatar || 'orbit',
        status: entity.colleagueStatus || 'active',
        kind: personal ? 'personal' : entity.kind === 'colleague' ? 'colleague' : 'shared',
        editable: owned || canEditColleague(entity, userId),
        isOwner: owned,
        visibility: entity.assistantVisibility || 'private',
        access: isOwnedColleague(entity, userId) ? entity.assistantAccess || [] : undefined,
        defaultModel: entity.modelOverride || null,
        agentContext: entity.kind === 'colleague' && entity.assistantMaterials ? assistantMaterialContext(entity.id) : null,
        materialsContext: entity.kind === 'colleague' ? assistantMaterialContext(entity.id) : null,
        model: preferences.model || entity.modelOverride || null,
        reasoningEffort: preferences.reasoningEffort || entity.reasoningEffort || null,
        memoryLearning: preferences.memoryLearning ?? null,
        useMemory: entity.useMemory !== false,
        memoryContextId: entityMemoryContextId(entity, userId),
        directory: personal ? '/workspace' : colleagueDirectory(entity.id),
    };
}
export function validateColleagueInput(input, { personal = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid colleague settings');
    const result = {};
    for (const [field, max] of Object.entries({
        name: 80,
        description: 500,
        instructions: 12000,
    })) {
        if (input[field] === undefined) continue;
        if (typeof input[field] !== 'string' || input[field].length > max)
            throw new Error(`Invalid ${field}`);
        result[field === 'instructions' ? 'identity' : field] =
            input[field].trim();
    }
    if ('name' in result && !result.name) throw new Error('Name is required');
    if (input.status !== undefined) {
        if (!COLLEAGUE_STATES.includes(input.status))
            throw new Error('Invalid status');
        result.colleagueStatus = input.status;
    }
    if (input.avatar !== undefined) {
        if (personal && input.avatar !== 'personal')
            throw new Error('Your personal Wisp uses the reserved gold portrait');
        if (!personal && !COLLEAGUE_AVATARS.includes(input.avatar))
            throw new Error('Invalid avatar');
        result.avatar = input.avatar;
    }
    return result;
}
export async function manageColleagues(
    store,
    { userId, action = 'list', entityId, settings = '{}' },
    resolvePersonal,
    isValidModel,
) {
    if (!userId || typeof userId !== 'string')
        throw new Error('User context is required');
    if (action === 'get') {
        const entity = await store.getEntity(entityId, { fresh: true, throwOnError: true });
        if (!canAccessEntity(entity, userId) || entity.isDefault) throw new Error('Colleague not found');
        return publicColleague(entity, userId, await getEntityPreferences(store, entity.id, userId));
    }
    if (action === 'list') {
        if (resolvePersonal) await resolvePersonal(userId);
        const page = await findAssistantPage(store, userId, JSON.parse(settings));
        const preferences = await getEntityPreferencesBatch(store, page.entities.map(e => e.id), userId);
        const { entities, ...pagination } = page;
        return { ...pagination, colleagues: entities.map(entity => {
            const { instructions, access, ...summary } = publicColleague(entity, userId, preferences.get(entity.id));
            return summary;
        }) };
    }
    if (!['create', 'update'].includes(action))
        throw new Error('Unknown action');
    const input = JSON.parse(settings);
    const entity = action === 'update' ? await store.getEntity(entityId, { fresh: true }) : null;
    if (action === 'update' && (!canAccessEntity(entity, userId) || entity.isDefault))
        throw new Error('Colleague not found');
    const changes = validateColleagueInput(input, { personal: action === 'update' && isPersonalEntity(entity, userId) });
    const preferences = validateEntityPreferences(input, isValidModel);
    if (input.defaultModel !== undefined) {
        if (input.defaultModel !== null && (!isValidModel?.(input.defaultModel))) throw new Error('Model is not available');
        changes.modelOverride = input.defaultModel;
    }
    if (input.materialsEnabled !== undefined) {
        if (typeof input.materialsEnabled !== 'boolean') throw new Error('Invalid materials setting');
        changes.assistantMaterials = input.materialsEnabled;
    }
    if (input.visibility !== undefined || input.access !== undefined) {
        if (action !== 'update' || !isOwnedColleague(entity, userId)) throw new Error('Only the assistant owner can change sharing');
        if (input.visibility !== undefined) {
            if (!['private', 'public'].includes(input.visibility)) throw new Error('Invalid visibility');
            changes.assistantVisibility = input.visibility;
        }
        if (input.access !== undefined) {
            if (!Array.isArray(input.access) || input.access.length > 100 || input.access.some(e => !e || typeof e.userId !== 'string' || !e.userId || e.userId.length > 200 || !['viewer', 'editor'].includes(e.role))) throw new Error('Invalid sharing recipients');
            if (new Set(input.access.map(e => e.userId)).size !== input.access.length) throw new Error('Duplicate sharing recipients');
            changes.assistantAccess = input.access.filter(e => e.userId !== userId).map(({ userId, role }) => ({ userId, role }));
        }
    }
    if (action === 'create') {
        if (!changes.name) throw new Error('Name is required');
        const creationKey = input.creationKey;
        if (creationKey !== undefined && (typeof creationKey !== 'string' || !creationKey.length || creationKey.length > 200))
            throw new Error('Invalid creation key');
        const stableId = creationKey ? `colleague-${createHash('sha256').update(JSON.stringify([userId, creationKey])).digest('hex')}` : null;
        if (stableId) {
            const existing = await store.getEntity(stableId, { fresh: true, throwOnError: true });
            if (existing) {
                if (!isOwnedColleague(existing, userId)) throw new Error('Invalid colleague owner');
                return publicColleague(existing, userId, await getEntityPreferences(store, stableId, userId));
            }
        }
        const personal = await resolvePersonal(userId);
        if (!personal?.entityId || personal.entityConfig?.kind === 'colleague')
            throw new Error('Personal workspace is unavailable');
        const entity = {
            id: stableId || `colleague-${randomUUID()}`,
            kind: 'colleague',
            colleagueOwnerId: userId,
            workspaceOwnerId: personal.entityId,
            assocUserIds: [userId],
            createdBy: userId,
            tools: ['*'],
            customTools: {},
            useMemory: true,
            colleagueStatus: 'active',
            avatar: 'orbit',
            ...changes,
        };
        if (!(await store.upsertEntity(entity, { insertOnly: Boolean(stableId) })))
            throw new Error('Could not save colleague');
        // Agent recruitment supplies no preferences. Do not reset an identity
        // or its preferences if a concurrent creator already inserted it.
        if (!stableId) await saveEntityPreferences(store, entity.id, userId, preferences);
        const saved = stableId ? await store.getEntity(stableId, { fresh: true, throwOnError: true }) : entity;
        if (!isOwnedColleague(saved, userId)) throw new Error('Invalid colleague owner');
        return publicColleague(saved, userId, stableId ? await getEntityPreferences(store, saved.id, userId) : preferences);
    }
    if (!isOwnedColleague(entity, userId) && changes.colleagueStatus !== undefined)
        throw new Error('Only created colleagues can be paused or archived');
    if (!canEditColleague(entity, userId) && !isPersonalEntity(entity, userId) && Object.keys(changes).length)
        throw new Error('This entity is managed by its owner');
    if (Object.keys(changes).length && !(await store.upsertEntity({ id: entityId, ...changes })))
        throw new Error('Could not save colleague');
    await saveEntityPreferences(store, entityId, userId, preferences);
    return publicColleague({ ...entity, ...changes }, userId, await getEntityPreferences(store, entityId, userId));
}

// Resolve only one validated hop. Runtime state and locks belong exclusively to
// the personal entity; colleagues never copy container credentials or checkpoints.
export async function resolveColleagueWorkspace(entityId, getEntity, options = {}) {
    const entity = await getEntity(entityId);
    const caller = options.userId || assistantExecutionUser();
    const sharedCatalog = entity && entity.kind !== 'colleague' && !entity.personalOwnerId && !entity.isSystem && caller && canAccessEntity(entity, caller);
    if (entity?.kind !== 'colleague' && !sharedCatalog)
        return { entityId, entity, directory: null };
    if (entity.colleagueStatus === 'archived')
        throw new Error('Colleague is archived');
    if (caller && !canAccessEntity(entity, caller)) throw new Error('Assistant is unavailable');
    if (!caller && (entity.assistantVisibility === 'public' || entity.assistantAccess?.length)) throw new Error('Executing user is required for a shared assistant');
    const userId = caller || entity.colleagueOwnerId;
    let owner;
    if (sharedCatalog || userId !== entity.colleagueOwnerId) {
        const resolvePersonal = options.resolvePersonal || (await import('../pathways/system/entity/tools/shared/sys_entity_tools.js')).resolvePersonalEntityConfig;
        const personal = await resolvePersonal(userId);
        owner = personal?.entityId ? await getEntity(personal.entityId) : null;
    } else owner = await getEntity(entity.workspaceOwnerId);
    if (
        (!sharedCatalog && !isOwnedColleague(entity, entity.colleagueOwnerId)) ||
        !owner ||
        owner.kind === 'colleague' ||
        owner.id === entity.id ||
        owner.personalOwnerId !== userId ||
        owner.assocUserIds?.length !== 1 ||
        owner.assocUserIds[0] !== userId
    ) {
        throw new Error('Invalid shared workspace owner');
    }
    return {
        entityId: owner.id,
        entity: owner,
        directory: colleagueDirectory(entity.id),
    };
}
