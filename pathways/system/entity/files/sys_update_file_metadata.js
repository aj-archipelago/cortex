// sys_update_file_metadata.js
// GraphQL pathway for updating file metadata (replaces sys_save_memory for renames and metadata updates)
// Only updates Cortex-managed fields (displayFilename, tags, notes, etc.), not CFH fields (url, gcs, hash, filename)

import { updateFileMetadata } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        contextId: ``,
        hash: ``,
        displayFilename: { type: 'string' }, // Optional - no default
        tags: { type: 'array', items: { type: 'string' } }, // Optional - no default
        notes: { type: 'string' }, // Optional - no default
        mimeType: { type: 'string' }, // Optional - no default
        permanent: { type: 'boolean' } // Optional - no default
    },
    model: 'oai-gpt4o',
    isMutation: true, // Declaratively mark this as a Mutation

    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, hash, displayFilename, tags, notes, mimeType, permanent } = args;
        
        // Validate required parameters
        if (!contextId || !hash) {
            return JSON.stringify({ 
                success: false, 
                error: 'contextId and hash are required' 
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
            
            // Update metadata (only Cortex-managed fields)
            const success = await updateFileMetadata(contextId, hash, metadata);
            
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

