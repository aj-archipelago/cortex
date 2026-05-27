// Ensures a personal entity exists for a user.

import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import logger from '../../../lib/logger.js';

export default {
    prompt: [],
    inputParameters: {
        userId: '',
        name: '',
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        const { userId, name } = args;

        if (!userId) {
            return JSON.stringify({ error: 'userId is required' });
        }

        try {
            const entityStore = getEntityStore();
            const defaultEntity = await loadEntityConfig(null);

            const entityDefaults = {
                name: name || 'Jarvis',
                tools: defaultEntity?.tools || ['*'],
                useMemory: defaultEntity?.useMemory ?? true,
                description: defaultEntity?.description || '',
                identity: defaultEntity?.identity || '',
                customTools: defaultEntity?.customTools || {},
                assocUserIds: [userId],
            };

            const result = await entityStore.findOrCreatePersonalEntity(userId, entityDefaults);
            if (!result) {
                return JSON.stringify({ error: 'Failed to find or create personal entity' });
            }

            return JSON.stringify({ id: result.id, name: result.name });
        } catch (error) {
            logger.error(`Error in sys_entity_upsert_personal: ${error.message}`);
            return JSON.stringify({ error: error.message });
        }
    },
    json: true,
    manageTokenLength: false,
};
