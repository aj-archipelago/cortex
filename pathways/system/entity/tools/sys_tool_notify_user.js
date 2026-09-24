import { randomUUID } from 'node:crypto';
import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { canAccessEntity, isPersonalEntity } from '../../../../lib/entityPreferences.js';

const validDestination = (value) => {
    if (value == null || value === '') return true;
    if (typeof value !== 'string' || value.length > 2048) return false;
    const url = value.trim();
    if (!url || url.includes('\\') || [...url].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
    if (url.startsWith('/') && !url.startsWith('//')) return true;
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch { return false; }
};
export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    json: true,
    manageTokenLength: false,
    inputParameters: {
        entityId: '',
        contextId: '',
        message: '',
        kind: 'result',
        url: '',
        fileAccessPlan: {
            type: 'array',
            items: { objType: 'FileAccessTargetInput' },
            default: [],
        },
    },
    toolDefinition: {
        type: 'function',
        icon: '📬',
        function: {
            name: 'NotifyUser',
            description:
                'Send a message to the user you are currently working for in their Concierge inbox. Available to personal assistants, created colleagues, and shared specialists. The recipient is fixed to the current user, never the shared entity owner or other users. Use kind help when you need a decision, permission, missing credentials, or clarification; explain what is needed and stop dependent work. Use result for useful results or updates. The user can reply in a private chat targeted to you.',
            parameters: {
                type: 'object',
                properties: {
                    message: {
                        type: 'string',
                        description:
                            'A concise message, including context and the requested action if blocked.',
                    },
                    kind: { type: 'string', enum: ['result', 'help'] },
                    url: {
                        type: 'string',
                        description: 'Optional click destination: a relative Concierge path such as /automations/ID/runs/RUN_ID or an absolute http(s) URL to the result. Omit to open a private chat with you. Only use a real destination you know exists.',
                    },
                },
                required: ['message', 'kind'],
            },
        },
    },
    executePathway: async ({ args }) => {
        const store = getEntityStore();
        const entity = await store.getEntity(args.entityId, { fresh: true });
        const owner =
            args.fileAccessPlan?.find((t) => t?.userContextId)?.userContextId ||
            args.contextId;
        if (
            !canAccessEntity(entity, owner) ||
            entity.colleagueStatus === 'archived'
        )
            return JSON.stringify({ error: 'Colleague not available' });
        if (
            typeof args.message !== 'string' ||
            !args.message.trim() ||
            args.message.length > 8000 ||
            !['result', 'help'].includes(args.kind) || !validDestination(args.url)
        )
            return JSON.stringify({ error: 'Invalid message' });
        // Concierge runs carry the same user/entity capability as management tools.
        // Deliver synchronously so success means the inbox and chat are durable.
        const endpoint = process.env.CONCIERGE_AGENT_TOOLS_URL;
        if (endpoint && args.agentToolsToken) {
            const response = await fetch(endpoint, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(90000),
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${args.agentToolsToken}`,
                },
                body: JSON.stringify({
                    tool: 'notifyuser',
                    args: { message: args.message.trim(), kind: args.kind, ...(args.url ? { url: args.url.trim() } : {}) },
                    entityId: entity.id,
                    contextId: owner,
                    callId: `${args._toolRequestId}:${args._parentToolCallId}`,
                }),
            });
            const result = await response.json();
            // Do not enqueue a duplicate after an ambiguous delivery failure.
            return JSON.stringify(response.ok ? result : {
                error: result.error || 'Inbox delivery failed',
            });
        }
        const outbox = await store.colleagueOutbox();
        await outbox.insertOne({
            _id: randomUUID(),
            owner,
            entityId: entity.id,
            name: entity.name,
            entityKind: isPersonalEntity(entity, owner) ? 'personal' : entity.kind,
            avatar: entity.avatar,
            ...(args.url ? { url: args.url.trim() } : {}),
            message: args.message.trim(),
            kind: args.kind,
            createdAt: new Date(),
        });
        return JSON.stringify({ success: true, delivery: 'queued', message: 'Queued for inbox delivery on the next scheduler tick, usually within a minute.' });
    },
};
