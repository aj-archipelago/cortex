// sys_tool_file_collection.js
// Tool pathway that manages user file collections (add, search, list files)
// Uses memory system endpoints (memoryFiles section) for storage
import logger from '../../../../lib/logger.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
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
                description: "List all files in your collection, optionally filtered by tags or sorted by date. Useful for getting an overview of your stored files.",
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
                description: "Remove one or more files from your collection and delete them from cloud storage. Use a file ID to remove a specific file, or use '*' to remove all files. The file will be deleted from cloud storage (if a hash is available) and removed from your collection.",
                parameters: {
                    type: "object",
                    properties: {
                        fileId: {
                            type: "string",
                            description: "The file to remove (from ListFileCollection or SearchFileCollection): can be the hash, the filename, the URL, or the GCS URL, or '*' to remove all files."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["fileId", "userMessage"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { contextId, contextKey } = args;

        // Determine which function was called based on which parameters are present
        const isAdd = args.fileUrl !== undefined || args.url !== undefined;
        const isSearch = args.query !== undefined;
        const isRemove = args.fileId !== undefined;
        const isList = !isAdd && !isSearch && !isRemove;

        try {
            if (!contextId) {
                throw new Error("contextId is required for file collection operations");
            }

            if (isAdd) {
                // Add file to collection
                const { fileUrl, url, gcs, filename, tags = [], notes = '', hash = null } = args;
                
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
                    resolver
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

                const queryLower = query.toLowerCase();
                
                // Use optimistic locking to update lastAccessed
                await modifyFileCollectionWithLock(contextId, contextKey, (collection) => {
                    // Find matching files and update their lastAccessed
                    const fileIds = new Set();
                    collection.forEach(file => {
                        // Search in filename, tags, and notes
                        const filenameMatch = file.filename.toLowerCase().includes(queryLower);
                        const notesMatch = file.notes && file.notes.toLowerCase().includes(queryLower);
                        const tagMatch = file.tags.some(tag => tag.toLowerCase().includes(queryLower));
                        
                        const matchesQuery = filenameMatch || notesMatch || tagMatch;
                        
                        // Filter by tags if provided
                        const matchesTags = filterTags.length === 0 || 
                            filterTags.every(filterTag => 
                                file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                            );
                        
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
                    const filenameMatch = file.filename.toLowerCase().includes(queryLower);
                    const notesMatch = file.notes && file.notes.toLowerCase().includes(queryLower);
                    const tagMatch = file.tags.some(tag => tag.toLowerCase().includes(queryLower));
                    
                    const matchesQuery = filenameMatch || notesMatch || tagMatch;
                    
                    const matchesTags = filterTags.length === 0 || 
                        filterTags.every(filterTag => 
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        );
                    
                    return matchesQuery && matchesTags;
                });

                // Sort by relevance (filename matches first, then by date)
                results.sort((a, b) => {
                    const aFilenameMatch = a.filename.toLowerCase().includes(queryLower);
                    const bFilenameMatch = b.filename.toLowerCase().includes(queryLower);
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
                const { fileId } = args;
                
                if (!fileId || typeof fileId !== 'string') {
                    throw new Error("fileId is required and must be a string");
                }

                let removedCount = 0;
                let removedFiles = [];
                let deletedFromCloud = 0;
                let deletionErrors = [];
                let filesToRemove = [];

                // First, identify files to remove (before locking)
                if (fileId === '*') {
                    // Load collection to get all files
                    const collection = await loadFileCollection(contextId, contextKey, false);
                    filesToRemove = collection.map(f => ({
                        id: f.id,
                        filename: f.filename,
                        hash: f.hash || null
                    }));
                } else {
                    // Load collection and find specific file
                    const collection = await loadFileCollection(contextId, contextKey, false);
                    const foundFile = findFileInCollection(fileId, collection);
                    
                    if (!foundFile) {
                        throw new Error(`File with ID, filename, URL, or hash "${fileId}" not found in collection`);
                    }
                    
                    filesToRemove = [{
                        id: foundFile.id,
                        filename: foundFile.filename,
                        hash: foundFile.hash || null
                    }];
                }

                // Delete files from cloud storage (outside lock - idempotent operation)
                for (const fileInfo of filesToRemove) {
                    if (fileInfo.hash) {
                        try {
                            logger.info(`Deleting file from cloud storage: ${fileInfo.filename} (hash: ${fileInfo.hash})`);
                            const deleted = await deleteFileByHash(fileInfo.hash, resolver);
                            if (deleted) {
                                deletedFromCloud++;
                            }
                        } catch (error) {
                            const errorMsg = error?.message || String(error);
                            logger.warn(`Failed to delete file ${fileInfo.filename} (hash: ${fileInfo.hash}) from cloud storage: ${errorMsg}`);
                            deletionErrors.push({ filename: fileInfo.filename, error: errorMsg });
                        }
                    }
                }

                // Use optimistic locking to remove files from collection
                const fileIdsToRemove = new Set(filesToRemove.map(f => f.id));
                const finalCollection = await modifyFileCollectionWithLock(contextId, contextKey, (collection) => {
                    // Remove files by ID
                    return collection.filter(file => !fileIdsToRemove.has(file.id));
                });

                removedCount = filesToRemove.length;
                removedFiles = filesToRemove;

                // Build result message
                let message;
                if (fileId === '*') {
                    message = `All ${removedCount} file(s) removed from collection`;
                    if (deletedFromCloud > 0) {
                        message += ` (${deletedFromCloud} deleted from cloud storage)`;
                    }
                    if (deletionErrors.length > 0) {
                        message += `. ${deletionErrors.length} deletion error(s) occurred`;
                    }
                } else {
                    message = `File "${removedFiles[0]?.filename || fileId}" removed from collection`;
                    if (deletedFromCloud > 0) {
                        message += ` and deleted from cloud storage`;
                    } else if (removedFiles[0]?.hash) {
                        message += ` (cloud storage deletion failed or file not found)`;
                    }
                }

                resolver.tool = JSON.stringify({ toolUsed: "RemoveFileFromCollection" });
                return JSON.stringify({
                    success: true,
                    removedCount: removedCount,
                    deletedFromCloud: deletedFromCloud,
                    remainingFiles: finalCollection.length,
                    message: message,
                    removedFiles: removedFiles,
                    deletionErrors: deletionErrors.length > 0 ? deletionErrors : undefined
                });

            } else {
                // List collection (read-only, no locking needed)
                const { tags: filterTags = [], sortBy = 'date', limit = 50 } = args;
                
                const collection = await loadFileCollection(contextId, contextKey, true);
                let results = collection;

                // Filter by tags if provided
                if (filterTags.length > 0) {
                    results = results.filter(file =>
                        filterTags.every(filterTag =>
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

