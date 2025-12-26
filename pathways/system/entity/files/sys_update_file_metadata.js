// sys_update_file_metadata.js
// GraphQL pathway for updating file metadata (replaces sys_save_memory for renames and metadata updates)
// Only updates Cortex-managed fields (displayFilename, tags, notes, etc.), not CFH fields (url, gcs, hash, filename)

import { updateFileMetadata, getDefaultContext } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        agentContext: [{ contextId: ``, contextKey: ``, default: true }],
        hash: ``,
        displayFilename: { type: 'string' }, // Optional - no default
        tags: { type: 'array', items: { type: 'string' } }, // Optional - no default
        notes: { type: 'string' }, // Optional - no default
        mimeType: { type: 'string' }, // Optional - no default
        permanent: { type: 'boolean' }, // Optional - no default
        inCollection: { type: 'array', items: { type: 'string' } } // Optional - array of chat IDs, or can be boolean true/false (normalized to ['*'] or removed)
    },
    model: 'oai-gpt4o',
    isMutation: true, // Declaratively mark this as a Mutation

    resolver: async (_parent, args, _contextValue, _info) => {
        const { agentContext, hash, displayFilename, tags, notes, mimeType, permanent, inCollection } = args;
        
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
        if (!hash) {
            return JSON.stringify({ 
                success: false, 
                error: 'hash is required' 
            });
        }
        
        try {
            // Build metadata object with only provided fields
            const metadata = {};
            if (displayFilename !== undefined && displayFilename !== null) {
                metadata.displayFilename = displayFilename;
            }
            if (tags !== undefined && tags !== null) {
                metadata.tags = Array.isArray(tags) ? tags : [];
            }
            if (notes !== undefined && notes !== null) {
                metadata.notes = notes;
            }
            if (mimeType !== undefined && mimeType !== null) {
                metadata.mimeType = mimeType;
            }
            if (permanent !== undefined && permanent !== null) {
                metadata.permanent = Boolean(permanent);
            }
            // inCollection can be: boolean true/false, or array of chat IDs (e.g., ['*'] for global, ['chat-123'] for specific chat)
            // Will be normalized by updateFileMetadata: true -> ['*'], false -> undefined (removed), array -> as-is
            if (inCollection !== undefined && inCollection !== null) {
                metadata.inCollection = inCollection;
            }
            
            // Update metadata (only Cortex-managed fields)
            const success = await updateFileMetadata(contextId, hash, metadata, contextKey);
            
            if (success) {
                return JSON.stringify({ 
                    success: true,
                    message: 'File metadata updated successfully'
                });
            } else {
                return JSON.stringify({ 
                    success: false, 
                    error: 'Failed to update file metadata' 
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

