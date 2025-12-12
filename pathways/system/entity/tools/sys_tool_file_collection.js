// sys_tool_file_collection.js
// Tool pathway that manages user file collections (add, search, list files)
// Uses memory system endpoints (memoryFiles section) for storage
import logger from '../../../../lib/logger.js';
import { addFileToCollection, loadFileCollection, saveFileCollection, findFileInCollection, deleteFileByHash, modifyFileCollectionWithLock } from '../../../../lib/fileUtils.js';

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
                            description: "Optional: If true, the file will be stored indefinitely instead of being subject to the default 30 day storage limit. Default: false"
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
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { contextId, contextKey } = args;

        // Determine which function was called based on which parameters are present
        const isAdd = args.fileUrl !== undefined || args.url !== undefined;
        const isSearch = args.query !== undefined;
        const isRemove = args.fileIds !== undefined || args.fileId !== undefined;

        try {
            if (!contextId) {
                throw new Error("contextId is required for file collection operations");
            }

            if (isAdd) {
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
                    permanent
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
                
                // Use optimistic locking to update lastAccessed
                await modifyFileCollectionWithLock(contextId, contextKey, (collection) => {
                    // Find matching files and update their lastAccessed
                    const fileIds = new Set();
                    collection.forEach(file => {
                        // Skip files without filename
                        if (!file.filename) return;
                        
                        // Search in filename, tags, and notes
                        const filenameMatch = file.filename.toLowerCase().includes(queryLower);
                        const notesMatch = file.notes && file.notes.toLowerCase().includes(queryLower);
                        const tagMatch = Array.isArray(file.tags) && file.tags.some(tag => tag.toLowerCase().includes(queryLower));
                        
                        const matchesQuery = filenameMatch || notesMatch || tagMatch;
                        
                        // Filter by tags if provided
                        const matchesTags = safeFilterTags.length === 0 || 
                            (Array.isArray(file.tags) && safeFilterTags.every(filterTag => 
                                file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                            ));
                        
                        if (matchesQuery && matchesTags) {
                            fileIds.add(file.id);
                        }
                    });
                    
                    // Update lastAccessed for found files
                    collection.forEach(file => {
                        if (fileIds.has(file.id)) {
                            file.lastAccessed = new Date().toISOString();
                        }
                    });
                    
                    return collection;
                });
                
                // Reload collection to get results (after update)
                const collection = await loadFileCollection(contextId, contextKey, false);
                
                // Filter and sort results (for display only, not modifying)
                let results = collection.filter(file => {
                    // Skip files without filename
                    if (!file.filename) return false;
                    
                    const filenameMatch = file.filename.toLowerCase().includes(queryLower);
                    const notesMatch = file.notes && file.notes.toLowerCase().includes(queryLower);
                    const tagMatch = Array.isArray(file.tags) && file.tags.some(tag => tag.toLowerCase().includes(queryLower));
                    
                    const matchesQuery = filenameMatch || notesMatch || tagMatch;
                    
                    const matchesTags = safeFilterTags.length === 0 || 
                        (Array.isArray(file.tags) && safeFilterTags.every(filterTag => 
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        ));
                    
                    return matchesQuery && matchesTags;
                });

                // Sort by relevance (filename matches first, then by date)
                results.sort((a, b) => {
                    const aFilenameMatch = a.filename && a.filename.toLowerCase().includes(queryLower);
                    const bFilenameMatch = b.filename && b.filename.toLowerCase().includes(queryLower);
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
                        filename: f.filename,
                        url: f.url,
                        gcs: f.gcs || null,
                        tags: f.tags,
                        notes: f.notes,
                        addedDate: f.addedDate
                    }))
                });

            } else if (isRemove) {
                // Remove file(s) from collection and delete from cloud storage
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

                let removedCount = 0;
                let removedFiles = [];
                let notFoundFiles = [];
                let filesToRemove = [];

                // Load collection once to find all files
                const collection = await loadFileCollection(contextId, contextKey, false);
                
                // Resolve all files
                for (const target of targetFiles) {
                    if (target === '*') continue; // Skip wildcard if passed
                    
                    const foundFile = findFileInCollection(target, collection);
                    
                    if (foundFile) {
                        // Avoid duplicates
                        if (!filesToRemove.some(f => f.id === foundFile.id)) {
                            filesToRemove.push({
                                id: foundFile.id,
                                filename: foundFile.filename,
                                hash: foundFile.hash || null
                            });
                        }
                    } else {
                        notFoundFiles.push(target);
                    }
                }

                if (filesToRemove.length === 0 && notFoundFiles.length > 0) {
                    throw new Error(`No files found matching: ${notFoundFiles.join(', ')}`);
                }

                // Use optimistic locking to remove files from collection FIRST
                // Capture hashes INSIDE the lock to avoid race conditions with concurrent edits
                const fileIdsToRemove = new Set(filesToRemove.map(f => f.id));
                const hashesToDelete = [];
                const finalCollection = await modifyFileCollectionWithLock(contextId, contextKey, (collection) => {
                    // Capture hashes and container info of files that will be removed (at current lock time)
                    collection.forEach(file => {
                        if (fileIdsToRemove.has(file.id) && file.hash) {
                            hashesToDelete.push({
                                hash: file.hash,
                                filename: file.filename || 'unknown',
                                permanent: file.permanent || false
                            });
                        }
                    });
                    
                    // Remove files by ID
                    return collection.filter(file => !fileIdsToRemove.has(file.id));
                });

                // Delete files from cloud storage ASYNC (fire and forget, but log errors)
                // We do this after updating collection so user gets fast response and files are "gone" from UI immediately
                // Use hashes captured inside the lock to ensure we delete the correct files
                (async () => {
                    const { config } = await import('../../../../config.js');
                    const permanentContainerName = process.env.CORTEX_MEDIA_PERMANENT_STORE_NAME;
                    
                    for (const fileInfo of hashesToDelete) {
                        try {
                            // Determine container based on permanent flag
                            const container = fileInfo.permanent && permanentContainerName ? permanentContainerName : null;
                            logger.info(`Deleting file from cloud storage: ${fileInfo.filename} (hash: ${fileInfo.hash}${container ? `, container: ${container}` : ''})`);
                            await deleteFileByHash(fileInfo.hash, resolver, container);
                        } catch (error) {
                            logger.warn(`Failed to delete file ${fileInfo.filename} (hash: ${fileInfo.hash}) from cloud storage: ${error?.message || String(error)}`);
                        }
                    }
                })().catch(err => logger.error(`Async cloud deletion error: ${err}`));

                removedCount = filesToRemove.length;
                removedFiles = filesToRemove;

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
                    remainingFiles: finalCollection.length,
                    message: message,
                    removedFiles: removedFiles,
                    notFoundFiles: notFoundFiles.length > 0 ? notFoundFiles : undefined
                });

            } else {
                // List collection (read-only, no locking needed)
                const { tags: filterTags = [], sortBy = 'date', limit = 50 } = args;
                
                const collection = await loadFileCollection(contextId, contextKey, true);
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
                    results.sort((a, b) => a.filename.localeCompare(b.filename));
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
                        filename: f.filename,
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

