// sys_read_file_collection.js
// GraphQL pathway for reading file collections
// File collections are stored in Redis hash maps (FileStoreMap:ctx:<contextId>
// Returns file collection as JSON array string for backward compatibility with Labeeb

import { loadFileCollection } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        contextId: ``,
        contextKey: ``,
        useCache: true
    },
    // No format field - returns String directly (like sys_read_memory)
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, contextKey = null, useCache = true } = args;
        
        // Validate that contextId is provided
        if (!contextId) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }
        
        try {
            // Load file collection from Redis hash maps
            const collection = await loadFileCollection(contextId, contextKey, useCache);
            
            // Return as JSON array string for backward compatibility with Labeeb
            // Labeeb expects either: [] or { version: "...", files: [...] }
            // Since we removed versioning, we just return the array directly
            // Ensure we always return a valid JSON array (empty if no files)
            const result = Array.isArray(collection) ? collection : [];
            return JSON.stringify(result);
        } catch (e) {
            // Log error for debugging
            const logger = (await import('../../../../lib/logger.js')).default;
            logger.warn(`Error loading file collection for contextId ${contextId}: ${e.message}`);
            // Return empty array on error for backward compatibility
            return "[]";
        }
    }
}

