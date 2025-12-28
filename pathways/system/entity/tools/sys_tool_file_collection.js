// sys_tool_file_collection.js
// Tool pathway that manages user file collections (add, search, list, update, remove files)
// Uses Redis hash maps (FileStoreMap:ctx:<contextId>) for storage
// Supports atomic rename/tag/notes updates via UpdateFileMetadata
import logger from '../../../../lib/logger.js';
import { addFileToCollection, loadFileCollection, loadMergedFileCollection, findFileInCollection, deleteFileByHash, updateFileMetadata, invalidateFileCollectionCache, getDefaultContext } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: [
        { 
            type: "function",
            icon: "📁",
            function: {
                name: "AddFileToCollection",
                description: "Add a file to your persistent file collection. This tool can upload a file from a URL to cloud storage (checking for duplicates by hash) and then store it in your collection with metadata. You can also add files that are already in cloud storage by providing the cloud URL directly.",
                parameters: {
                    type: "object",
                    properties: {
                        fileUrl: {
                            type: "string",
                            description: "Optional: The URL of a file to upload to cloud storage (e.g., https://example.com/file.pdf). If provided, the file will be uploaded and then added to the collection. If not provided, you must provide the 'url' parameter for an already-uploaded file."
                        },
                        url: {
                            type: "string",
                            description: "Optional: The cloud storage URL of an already-uploaded file (Azure URL). Use this if the file is already in cloud storage. If 'fileUrl' is provided, this will be ignored."
                        },
                        gcs: {
                            type: "string",
                            description: "Optional: The Google Cloud Storage URL of the file (GCS URL). Only needed if the file is already in cloud storage and you're providing 'url'."
                        },
                        filename: {
                            type: "string",
                            description: "The filename or title for this file"
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional: Array of tags to help organize and search for this file (e.g., ['pdf', 'report', '2024'])"
                        },
                        notes: {
                            type: "string",
                            description: "Optional: Notes or description about this file to help you remember what it contains"
                        },
                        hash: {
                            type: "string",
                            description: "Optional: File hash for deduplication and identification (usually computed automatically during upload)"
                        },
                        permanent: {
                            type: "boolean",
                            description: "Optional: If true, the file will be stored indefinitely (retention=permanent). Default: false."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["filename", "userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "🔍",
            function: {
                name: "SearchFileCollection",
                description: "Search your file collection to find files by filename, tags, notes, or date. Returns matching files with their cloud URLs and metadata.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Search query - can search by filename, tags, or notes content"
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional: Filter results by specific tags (all tags must match)"
                        },
                        limit: {
                            type: "number",
                            description: "Optional: Maximum number of results to return (default: 20)"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["query", "userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "📋",
            function: {
                name: "ListFileCollection",
                description: "List all files in your collection, optionally filtered by tags or sorted by date. Useful for getting an overview of your stored files or when you don't know the exact file you're looking for.",
                parameters: {
                    type: "object",
                    properties: {
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional: Filter results by specific tags (all tags must match)"
                        },
                        sortBy: {
                            type: "string",
                            enum: ["date", "filename"],
                            description: "Optional: Sort results by date (newest first) or filename (alphabetical). Default: date"
                        },
                        limit: {
                            type: "number",
                            description: "Optional: Maximum number of results to return (default: 50)"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "🗑️",
            function: {
                name: "RemoveFileFromCollection",
                description: "Remove one or more files from your collection and delete them from cloud storage.",
                parameters: {
                    type: "object",
                    properties: {
                        fileIds: {
                            type: "array",
                            items: { type: "string" },
                            description: "Array of files to remove (from ListFileCollection or SearchFileCollection): each item can be the hash, the filename, the URL, or the GCS URL."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["fileIds", "userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "✏️",
            function: {
                name: "UpdateFileMetadata",
                description: "Update metadata for a file in your collection. Use this to rename files, update tags, or add/modify notes. This is an atomic operation - safer than add+delete for renaming.",
                parameters: {
                    type: "object",
                    properties: {
                        file: {
                            type: "string",
                            description: "The file to update - can be the current filename, hash, URL, or ID from ListFileCollection"
                        },
                        newFilename: {
                            type: "string",
                            description: "Optional: New filename/title for the file (renames the file)"
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional: New tags to set for this file (replaces existing tags)"
                        },
                        addTags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional: Tags to add to the file's existing tags"
                        },
                        removeTags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional: Tags to remove from the file's existing tags"
                        },
                        notes: {
                            type: "string",
                            description: "Optional: New notes/description for the file (replaces existing notes)"
                        },
                        permanent: {
                            type: "boolean",
                            description: "Optional: If true, marks the file as permanent (won't be auto-cleaned). If false, marks as temporary."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["file", "userMessage"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const defaultCtx = getDefaultContext(args.agentContext);
        if (!defaultCtx) {
            throw new Error("agentContext with at least one default context is required");
        }
        const contextId = defaultCtx.contextId;
        const contextKey = defaultCtx.contextKey || null;
        const chatId = args.chatId || null;

        // Determine which function was called based on which parameters are present
        // Order matters: check most specific operations first
        const isUpdate = args.file !== undefined && (
            args.newFilename !== undefined || 
            args.tags !== undefined || 
            args.addTags !== undefined || 
            args.removeTags !== undefined || 
            args.notes !== undefined || 
            args.permanent !== undefined
        );
        const isAdd = !isUpdate && (args.fileUrl !== undefined || args.url !== undefined);
        const isSearch = args.query !== undefined;
        const isRemove = args.fileIds !== undefined || args.fileId !== undefined;

        try {
            if (!contextId) {
                throw new Error("contextId is required for file collection operations");
            }

            if (isUpdate) {
                // Update file metadata (rename, tags, notes, permanent)
                const { file, newFilename, tags, addTags, removeTags, notes, permanent } = args;
                
                if (!file) {
                    throw new Error("file parameter is required - specify the file by filename, hash, URL, or ID");
                }

                // Load collection and find the file
                const collection = await loadFileCollection(contextId, contextKey, false);
                const foundFile = findFileInCollection(file, collection);
                
                if (!foundFile) {
                    throw new Error(`File not found: "${file}". Use ListFileCollection to see available files.`);
                }

                if (!foundFile.hash) {
                    throw new Error(`File "${file}" has no hash - cannot update metadata`);
                }

                // Build the metadata update object
                const metadataUpdate = {};
                
                // Handle filename rename
                if (newFilename !== undefined) {
                    metadataUpdate.displayFilename = newFilename;
                }
                
                // Handle tags - three modes: replace all, add, or remove
                if (tags !== undefined) {
                    // Replace all tags
                    metadataUpdate.tags = Array.isArray(tags) ? tags : [];
                } else if (addTags !== undefined || removeTags !== undefined) {
                    // Merge with existing tags
                    let currentTags = Array.isArray(foundFile.tags) ? [...foundFile.tags] : [];
                    
                    // Add new tags (avoid duplicates)
                    if (addTags && Array.isArray(addTags)) {
                        for (const tag of addTags) {
                            const normalizedTag = tag.toLowerCase();
                            if (!currentTags.some(t => t.toLowerCase() === normalizedTag)) {
                                currentTags.push(tag);
                            }
                        }
                    }
                    
                    // Remove tags
                    if (removeTags && Array.isArray(removeTags)) {
                        const removeSet = new Set(removeTags.map(t => t.toLowerCase()));
                        currentTags = currentTags.filter(t => !removeSet.has(t.toLowerCase()));
                    }
                    
                    metadataUpdate.tags = currentTags;
                }
                
                // Handle notes
                if (notes !== undefined) {
                    metadataUpdate.notes = notes;
                }
                
                // Handle permanent flag
                if (permanent !== undefined) {
                    metadataUpdate.permanent = permanent;
                }
                
                // Always update lastAccessed
                metadataUpdate.lastAccessed = new Date().toISOString();

                // Perform the atomic update
                const success = await updateFileMetadata(contextId, foundFile.hash, metadataUpdate, contextKey, chatId);
                
                if (!success) {
                    throw new Error(`Failed to update file metadata for "${file}"`);
                }

                // Build result with what was updated
                const updates = [];
                if (newFilename !== undefined) updates.push(`renamed to "${newFilename}"`);
                if (tags !== undefined) updates.push(`tags set to [${tags.join(', ')}]`);
                if (addTags !== undefined) updates.push(`added tags [${addTags.join(', ')}]`);
                if (removeTags !== undefined) updates.push(`removed tags [${removeTags.join(', ')}]`);
                if (notes !== undefined) updates.push(`notes updated`);
                if (permanent !== undefined) updates.push(`marked as ${permanent ? 'permanent' : 'temporary'}`);

                resolver.tool = JSON.stringify({ toolUsed: "UpdateFileMetadata" });
                return JSON.stringify({
                    success: true,
                    file: foundFile.displayFilename || foundFile.filename || file,
                    fileId: foundFile.id,
                    hash: foundFile.hash,
                    updates: updates,
                    message: `File "${foundFile.displayFilename || foundFile.filename || file}" updated: ${updates.join(', ')}`
                });

            } else if (isAdd) {
                // Add file to collection
                const { fileUrl, url, gcs, filename, tags = [], notes = '', hash = null, permanent = false } = args;
                
                if (!filename) {
                    throw new Error("filename is required");
                }
                
                if (!fileUrl && !url) {
                    throw new Error("Either fileUrl (to upload) or url (already uploaded) is required");
                }

                // Use the centralized utility function (it will handle upload if fileUrl is provided)
                const fileEntry = await addFileToCollection(
                    contextId,
                    contextKey,
                    url,
                    gcs,
                    filename,
                    tags,
                    notes,
                    hash,
                    fileUrl,
                    resolver,
                    permanent,
                    chatId
                );

                resolver.tool = JSON.stringify({ toolUsed: "AddFileToCollection" });
                return JSON.stringify({
                    success: true,
                    fileId: fileEntry.id,
                    message: `File "${filename}" added to collection`
                });

            } else if (isSearch) {
                // Search collection
                const { query, tags: filterTags = [], limit = 20 } = args;
                
                if (!query || typeof query !== 'string') {
                    throw new Error("query is required and must be a string");
                }

                // Ensure filterTags is always an array
                const safeFilterTags = Array.isArray(filterTags) ? filterTags : [];
                const queryLower = query.toLowerCase();
                
                // Load primary collection for lastAccessed updates (only update files in primary context)
                const primaryFiles = await loadFileCollection(contextId, contextKey, false);
                const now = new Date().toISOString();
                
                // Find matching files in primary collection and update lastAccessed directly
                for (const file of primaryFiles) {
                    if (!file.hash) continue;
                    
                    // Fallback to filename if displayFilename is not set (for files uploaded before displayFilename was added)
                    const displayFilename = file.displayFilename || file.filename || '';
                    const filenameMatch = displayFilename.toLowerCase().includes(queryLower);
                    const notesMatch = file.notes && file.notes.toLowerCase().includes(queryLower);
                    const tagMatch = Array.isArray(file.tags) && file.tags.some(tag => tag.toLowerCase().includes(queryLower));
                    const matchesQuery = filenameMatch || notesMatch || tagMatch;
                    
                    const matchesTags = safeFilterTags.length === 0 || 
                        (Array.isArray(file.tags) && safeFilterTags.every(filterTag => 
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        ));
                    
                    if (matchesQuery && matchesTags) {
                        // Update lastAccessed directly (atomic operation)
                        // Don't pass chatId - we're only updating access time, not changing inCollection
                        await updateFileMetadata(contextId, file.hash, {
                            lastAccessed: now
                        }, contextKey);
                    }
                }
                
                // Load merged collection for search results (includes all agentContext files)
                const updatedFiles = await loadMergedFileCollection(args.agentContext);
                
                // Filter and sort results (for display only, not modifying)
                let results = updatedFiles.filter(file => {
                    // Fallback to filename if displayFilename is not set
                    const displayFilename = file.displayFilename || file.filename || '';
                    const filename = file.filename || '';
                    
                    // Check both displayFilename and filename for matches
                    // (displayFilename may be different from filename, so check both)
                    const filenameMatch = displayFilename.toLowerCase().includes(queryLower) || 
                                         (filename && filename !== displayFilename && filename.toLowerCase().includes(queryLower));
                    const notesMatch = file.notes && file.notes.toLowerCase().includes(queryLower);
                    const tagMatch = Array.isArray(file.tags) && file.tags.some(tag => tag.toLowerCase().includes(queryLower));
                    
                    const matchesQuery = filenameMatch || notesMatch || tagMatch;
                    
                    const matchesTags = safeFilterTags.length === 0 || 
                        (Array.isArray(file.tags) && safeFilterTags.every(filterTag => 
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        ));
                    
                    return matchesQuery && matchesTags;
                });

                // Sort by relevance (displayFilename matches first, then by date)
                results.sort((a, b) => {
                    // Fallback to filename if displayFilename is not set
                    const aDisplayFilename = a.displayFilename || a.filename || '';
                    const bDisplayFilename = b.displayFilename || b.filename || '';
                    const aFilenameMatch = aDisplayFilename.toLowerCase().includes(queryLower);
                    const bFilenameMatch = bDisplayFilename.toLowerCase().includes(queryLower);
                    if (aFilenameMatch && !bFilenameMatch) return -1;
                    if (!aFilenameMatch && bFilenameMatch) return 1;
                    return new Date(b.addedDate) - new Date(a.addedDate);
                });

                // Limit results
                results = results.slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "SearchFileCollection" });
                return JSON.stringify({
                    success: true,
                    count: results.length,
                    files: results.map(f => ({
                        id: f.id,
                        displayFilename: f.displayFilename || f.filename || null,
                        url: f.url,
                        gcs: f.gcs || null,
                        tags: f.tags,
                        notes: f.notes,
                        addedDate: f.addedDate
                    }))
                });

            } else if (isRemove) {
                // Remove file(s) from this chat's collection (reference counting)
                // Only delete from cloud if no other chats reference the file
                const { fileIds, fileId } = args;
                
                // Normalize input to array
                let targetFiles = [];
                if (Array.isArray(fileIds)) {
                    targetFiles = fileIds;
                } else if (fileId) {
                    targetFiles = [fileId];
                }

                if (!targetFiles || targetFiles.length === 0) {
                    throw new Error("fileIds array is required and must not be empty");
                }

                let notFoundFiles = [];
                let filesToProcess = [];

                // Load collection ONCE to find all files and their data
                // Use useCache: false to get fresh data
                const collection = await loadFileCollection(contextId, contextKey, false);
                
                // Resolve all files and collect their info in a single pass
                for (const target of targetFiles) {
                    if (target === '*') continue; // Skip wildcard if passed
                    
                    const foundFile = findFileInCollection(target, collection);
                    
                    if (foundFile) {
                        // Avoid duplicates (by hash since that's the unique key in Redis)
                        if (!filesToProcess.some(f => f.hash === foundFile.hash)) {
                            filesToProcess.push({
                                id: foundFile.id,
                                displayFilename: foundFile.displayFilename || foundFile.filename || null,
                                hash: foundFile.hash || null,
                                permanent: foundFile.permanent ?? false,
                                inCollection: foundFile.inCollection || []
                            });
                        }
                    } else {
                        notFoundFiles.push(target);
                    }
                }

                if (filesToProcess.length === 0 && notFoundFiles.length > 0) {
                    throw new Error(`No files found matching: ${notFoundFiles.join(', ')}`);
                }

                // Import helpers for reference counting
                const { getRedisClient, removeChatIdFromInCollection } = await import('../../../../lib/fileUtils.js');
                const redisClient = await getRedisClient();
                const contextMapKey = `FileStoreMap:ctx:${contextId}`;
                
                // Track files that will be fully deleted vs just updated
                const filesToFullyDelete = [];
                const filesToUpdate = [];
                
                for (const fileInfo of filesToProcess) {
                    if (!fileInfo.hash) continue;
                    
                    // Check if file is global ('*') - global files can't be removed per-chat
                    const isGlobal = Array.isArray(fileInfo.inCollection) && fileInfo.inCollection.includes('*');
                    
                    if (isGlobal) {
                        // Global file - fully remove it (no reference counting for global files)
                        filesToFullyDelete.push(fileInfo);
                    } else if (!chatId) {
                        // No chatId context - fully remove
                        filesToFullyDelete.push(fileInfo);
                    } else {
                        // Remove this chatId from inCollection
                        const updatedInCollection = removeChatIdFromInCollection(fileInfo.inCollection, chatId);
                        
                        if (updatedInCollection.length === 0) {
                            // No more references - fully delete
                            filesToFullyDelete.push(fileInfo);
                        } else {
                            // Still has references from other chats - just update inCollection
                            filesToUpdate.push({ ...fileInfo, updatedInCollection });
                        }
                    }
                }
                
                // Update files that still have references (remove this chatId only)
                for (const fileInfo of filesToUpdate) {
                    if (redisClient) {
                        try {
                            const existingDataStr = await redisClient.hget(contextMapKey, fileInfo.hash);
                            if (existingDataStr) {
                                const existingData = JSON.parse(existingDataStr);
                                existingData.inCollection = fileInfo.updatedInCollection;
                                await redisClient.hset(contextMapKey, fileInfo.hash, JSON.stringify(existingData));
                                logger.info(`Removed chatId ${chatId} from file: ${fileInfo.displayFilename} (still referenced by: ${fileInfo.updatedInCollection.join(', ')})`);
                            }
                        } catch (e) {
                            logger.warn(`Failed to update inCollection for file ${fileInfo.hash}: ${e.message}`);
                        }
                    }
                }
                
                // Fully delete files with no remaining references
                if (redisClient) {
                    for (const fileInfo of filesToFullyDelete) {
                        await redisClient.hdel(contextMapKey, fileInfo.hash);
                    }
                }
                
                // Always invalidate cache immediately so list operations reflect changes
                invalidateFileCollectionCache(contextId, contextKey);

                // Delete files from cloud storage ASYNC (only for files with no remaining references)
                // IMPORTANT: Don't delete permanent files from cloud storage - they should persist
                (async () => {
                    for (const fileInfo of filesToFullyDelete) {
                        // Skip deletion if file is marked as permanent
                        if (fileInfo.permanent) {
                            logger.info(`Skipping cloud deletion for permanent file: ${fileInfo.displayFilename} (hash: ${fileInfo.hash})`);
                            continue;
                        }
                        
                        try {
                            logger.info(`Deleting file from cloud storage (no remaining references): ${fileInfo.displayFilename} (hash: ${fileInfo.hash})`);
                            await deleteFileByHash(fileInfo.hash, resolver, contextId);
                        } catch (error) {
                            logger.warn(`Failed to delete file ${fileInfo.displayFilename} (hash: ${fileInfo.hash}) from cloud storage: ${error?.message || String(error)}`);
                        }
                    }
                })().catch(err => logger.error(`Async cloud deletion error: ${err}`));

                const removedCount = filesToProcess.length;
                const removedFiles = filesToProcess.map(f => ({
                    id: f.id,
                    displayFilename: f.displayFilename,
                    hash: f.hash,
                    fullyDeleted: filesToFullyDelete.some(fd => fd.hash === f.hash)
                }));

                // Get remaining files count after deletion
                const remainingCollection = await loadFileCollection(contextId, contextKey, false);
                const remainingCount = remainingCollection.length;

                // Build result message
                let message = `${removedCount} file(s) removed from collection`;
                
                if (notFoundFiles.length > 0) {
                    message += `. Could not find: ${notFoundFiles.join(', ')}`;
                }
                
                message += " (Cloud storage cleanup started in background)";

                resolver.tool = JSON.stringify({ toolUsed: "RemoveFileFromCollection" });
                return JSON.stringify({
                    success: true,
                    removedCount: removedCount,
                    remainingFiles: remainingCount,
                    message: message,
                    removedFiles: removedFiles,
                    notFoundFiles: notFoundFiles.length > 0 ? notFoundFiles : undefined
                });

            } else {
                // List collection (read-only, no locking needed)
                const { tags: filterTags = [], sortBy = 'date', limit = 50 } = args;
                
                // Use merged collection to include files from all agentContext contexts
                const collection = await loadMergedFileCollection(args.agentContext);
                let results = collection;

                // Filter by tags if provided
                if (filterTags.length > 0) {
                    results = results.filter(file =>
                        Array.isArray(file.tags) && filterTags.every(filterTag =>
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        )
                    );
                }

                // Sort results
                if (sortBy === 'date') {
                    results.sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate));
                } else if (sortBy === 'filename') {
                    results.sort((a, b) => {
                        // Fallback to filename if displayFilename is not set
                        const aDisplayFilename = a.displayFilename || a.filename || '';
                        const bDisplayFilename = b.displayFilename || b.filename || '';
                        return aDisplayFilename.localeCompare(bDisplayFilename);
                    });
                }

                // Limit results
                results = results.slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "ListFileCollection" });
                return JSON.stringify({
                    success: true,
                    count: results.length,
                    totalFiles: collection.length,
                    files: results.map(f => ({
                        id: f.id,
                        displayFilename: f.displayFilename || f.filename || null,
                        url: f.url,
                        gcs: f.gcs || null,
                        tags: f.tags,
                        notes: f.notes,
                        addedDate: f.addedDate,
                        lastAccessed: f.lastAccessed
                    }))
                });
            }

        } catch (e) {
            logger.error(`Error in file collection operation: ${e.message}`);
            
            const errorResult = {
                success: false,
                error: e.message || "Unknown error occurred"
            };

            resolver.tool = JSON.stringify({ toolUsed: "FileCollection" });
            return JSON.stringify(errorResult);
        }
    }
};

