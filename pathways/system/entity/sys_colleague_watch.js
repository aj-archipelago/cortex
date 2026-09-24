import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import {
    resolveColleagueWorkspace,
} from '../../../lib/colleagues.js';
import { watchCommand } from '../../../lib/colleagueWatch.js';
import { canAccessEntity } from '../../../lib/entityPreferences.js';
export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    json: true,
    manageTokenLength: false,
    inputParameters: { userId: '', entityId: '', path: '' },
    executePathway: async ({ args }) => {
        const store = getEntityStore();
        const entity = await store.getEntity(args.entityId, { fresh: true });
        if (
            !canAccessEntity(entity, args.userId) ||
            (entity.kind === 'colleague' && entity.colleagueStatus !== 'active')
        )
            return JSON.stringify({ skipped: true });
        const binding = await resolveColleagueWorkspace(entity.id, (id) =>
            store.getEntity(id, { fresh: true }), { userId: args.userId },
        );
        const ws = binding.entity.workspace;
        if (ws?.status !== 'running' || !ws.url)
            return JSON.stringify({ skipped: true });
        // No provisioning, reconnect, or activity refresh during a watch tick.
        const response = await fetch(`${ws.url}/shell`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-workspace-secret': ws.secret,
            },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ command: watchCommand(args.path) }),
        });
        if (!response.ok) throw new Error('Workspace watch unavailable');
        const result = await response.json();
        const fingerprint = result.stdout?.trim();
        if (!result.success || !/^[a-f0-9]{64}$/.test(fingerprint))
            throw new Error('Workspace watch could not read the folder');
        return JSON.stringify({ fingerprint });
    },
};
