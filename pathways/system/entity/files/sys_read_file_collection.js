// sys_read_file_collection.js
// GraphQL pathway for reading file collections
// File collections are stored in Redis hash maps (FileStoreMap:ctx:<contextId>
// Returns file collection as JSON array string for backward compatibility with Labeeb

import { loadFileCollection } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        agentContext: [
            { contextId: ``, contextKey: ``, default: true }
        ],
        useCache: true
    },
    // No format field - returns String directly (like sys_read_memory)
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {
        let { agentContext } = args;
        
        // Backward compatibility: if contextId is provided without agentContext, create agentContext
        if ((!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) && args.contextId) {
            agentContext = [{ 
                contextId: args.contextId, 
                contextKey: args.contextKey || null, 
                default: true 
            }];
        }
        
        // Validate that agentContext is provided
        if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }
        
        try {
            // Load file collection from Redis hash maps (from all agentContext contexts)
            const collection = await loadFileCollection(agentContext);
            
            // Return as JSON array string for backward compatibility with Labeeb
            // Labeeb expects either: [] or { version: "...", files: [...] }
            // Since we removed versioning, we just return the array directly
            // Strip internal _contextId before returning
            const result = (Array.isArray(collection) ? collection : [])
                .map(({ _contextId, ...file }) => file);
            return JSON.stringify(result);
        } catch (e) {
            // Log error for debugging
            const logger = (await import('../../../../lib/logger.js')).default;
            logger.warn(`Error loading file collection: ${e.message}`);
            // Return empty array on error for backward compatibility
            return "[]";
        }
    }
}

