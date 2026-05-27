// sys_read_file_collection.js
// GraphQL pathway for reading file collections from cloud storage
// Returns file listing as JSON array string

import { listFilesForFileAccessPlan } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        fileAccessPlan: {
            type: 'array',
            items: { objType: 'FileAccessTargetInput' },
            default: [],
        },
        useCache: true
    },
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {
        const { fileAccessPlan } = args;

        if (!fileAccessPlan || !Array.isArray(fileAccessPlan) || fileAccessPlan.length === 0) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }

        try {
            const files = await listFilesForFileAccessPlan(fileAccessPlan);
            if (!Array.isArray(files)) {
                return "[]";
            }
            return JSON.stringify(files);
        } catch (e) {
            const logger = (await import('../../../../lib/logger.js')).default;
            logger.warn(`Error loading file collection: ${e.message}`);
            return "[]";
        }
    }
}
