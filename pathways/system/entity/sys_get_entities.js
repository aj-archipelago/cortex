// sys_get_entities.js
// Pathway to get list of available entities with their tools

import { getAvailableEntities } from './tools/shared/sys_entity_tools.js';

export default {
    prompt: [],
    inputParameters: {
        userId: '',
        fresh: '',
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const options = {};
            if (args.userId) {
                options.userId = args.userId;
            }
            if (args.fresh === true || args.fresh === 'true' || args.fresh === '1') {
                options.fresh = true;
            }
            const entities = await getAvailableEntities(options);
            return JSON.stringify(entities);
        } catch (error) {
            return JSON.stringify(error);
        }
    },
    json: true, // We want JSON output
    manageTokenLength: false, // No need to manage token length for this simple operation
};
