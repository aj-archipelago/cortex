// sys_add_file_to_collection.js
// GraphQL pathway for adding files to the file collection
// Used when a file is already in storage and needs to be added to the collection

import { addFileToCollection, getDefaultContext } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        agentContext: [{ contextId: ``, contextKey: ``, default: true }],
        hash: ``,
        url: ``,
        gcs: { type: 'string' }, // Optional
        filename: ``,
        tags: { type: 'array', items: { type: 'string' } }, // Optional
        notes: { type: 'string' }, // Optional
        mimeType: { type: 'string' }, // Optional
        permanent: { type: 'boolean' }, // Optional
        chatId: { type: 'string' } // Optional - for chat-scoped files
    },
    model: 'oai-gpt4o',
    isMutation: true, // Declaratively mark this as a Mutation

    resolver: async (_parent, args, _contextValue, _info) => {
        const { agentContext, hash, url, gcs, filename, tags, notes, mimeType, permanent, chatId } = args;
        
        const defaultCtx = getDefaultContext(agentContext);
        if (!defaultCtx) {
            return JSON.stringify({ 
                success: false, 
                error: 'agentContext with at least one default context is required' 
            });
        }
        const contextId = defaultCtx.contextId;
        const contextKey = defaultCtx.contextKey || null;
        
        // Validate required parameters
        if (!hash || !url || !filename) {
            return JSON.stringify({ 
                success: false, 
                error: 'hash, url, and filename are required' 
            });
        }
        
        try {
            // Add file to collection
            const fileEntry = await addFileToCollection(
                contextId,
                contextKey,
                url,
                gcs || null,
                filename,
                tags || [],
                notes || '',
                hash,
                null, // fileUrl - not needed since file is already uploaded
                null, // pathwayResolver
                Boolean(permanent),
                chatId || null
            );
            
            if (fileEntry) {
                return JSON.stringify({ 
                    success: true,
                    fileId: fileEntry.id,
                    message: `File "${filename}" added to collection`
                });
            } else {
                return JSON.stringify({ 
                    success: false, 
                    error: 'Failed to add file to collection' 
                });
            }
        } catch (e) {
            return JSON.stringify({ 
                success: false, 
                error: e.message || 'Unknown error occurred' 
            });
        }
    }
}
