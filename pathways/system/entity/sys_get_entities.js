// sys_get_entities.js
// Pathway to get list of available entities with their tools

import { getAvailableEntities } from './tools/shared/sys_entity_tools.js';

export default {
    prompt: [],
    inputParameters: {},
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const entities = getAvailableEntities();
            return JSON.stringify(entities);
        } catch (error) {
            return JSON.stringify(error);
        }
    },
    json: true, // We want JSON output
    manageTokenLength: false, // No need to manage token length for this simple operation
}; 