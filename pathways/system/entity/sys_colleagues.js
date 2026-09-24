import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import { manageColleagues } from '../../../lib/colleagues.js';
import { resolvePersonalEntityConfig } from './tools/shared/sys_entity_tools.js';
import { config } from '../../../config.js';
export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    json: true,
    manageTokenLength: false,
    inputParameters: {
        userId: '',
        action: 'list',
        entityId: '',
        settings: '{}',
    },
    executePathway: async ({ args }) => {
        try {
            return JSON.stringify(
                await manageColleagues(
                    getEntityStore(),
                    args,
                    resolvePersonalEntityConfig,
                    model => Boolean(config.get('models')?.[model]?.metadata?.isAgentic || config.get('modelGroups')?.[model]?.metadata?.isAgentic),
                ),
            );
        } catch (error) {
            return JSON.stringify({ error: error.message });
        }
    },
};
