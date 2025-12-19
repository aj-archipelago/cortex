// sys_tool_editfile.js
// Entity tool that modifies existing files by replacing line ranges or exact string matches
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { uploadFileToCloud, findFileInCollection, loadFileCollection, getMimeTypeFromFilename, resolveFileParameter, deleteFileByHash, isTextMimeType, updateFileMetadata, writeFileDataToRedis, invalidateFileCollectionCache } from '../../../../lib/fileUtils.js';

// In-process serialization: prevents concurrent edits to the same file on this instance
// Uses promise chaining to execute edits sequentially per file
const editQueues = new Map();

/**
 * Serialize edit operations per file to prevent concurrent edits on the same instance
 * Uses promise chaining to execute edits sequentially. No deadlock risk (single resource lock).
 * @param {string} contextId - Context ID
 * @param {string} fileId - File ID
 * @param {Function} editFn - Async function that performs the edit
 * @returns {Promise} Promise that resolves when this edit completes
 */
async function serializeEdit(contextId, fileId, editFn) {
    const lockKey = `${contextId}:${fileId}`;
    
    // Get existing queue or start with resolved promise
    let queue = editQueues.get(lockKey) || Promise.resolve();
    
    // Chain this operation after the previous one
    // Timeout protection: pathway timeout (120s) will handle stuck operations
    const operation = queue.then(editFn).finally(() => {
        // Cleanup: remove queue if we're still the current one (no new operations queued)
        // This prevents memory leaks if operations complete
        if (editQueues.get(lockKey) === operation) {
            editQueues.delete(lockKey);
        }
    });
    
    editQueues.set(lockKey, operation);
    return operation;
}

export default {
    prompt: [],
    timeout: 120,
    toolDefinition: [
        { 
            type: "function",
            icon: "✏️",
            function: {
                name: "EditFileByLine",
                description: "Modify an existing file by replacing a range of lines. Use this for line-based edits where you know the exact line numbers to replace. The file must exist in your file collection and must be a text-type file (text, markdown, html, csv, etc.). After modification, the file is re-uploaded and the collection entry is updated.",
                parameters: {
                    type: "object",
                    properties: {
                        file: {
                            type: "string",
                            description: "The file to modify: can be the file ID, filename, URL, or hash from your file collection. You can find available files in the Available Files section or ListFileCollection or SearchFileCollection."
                        },
                        startLine: {
                            type: "number",
                            description: "Starting line number (1-indexed) to replace. The line range is inclusive (both startLine and endLine are replaced)."
                        },
                        endLine: {
                            type: "number",
                            description: "Ending line number (1-indexed) to replace. Must be >= startLine. The line range is inclusive (both startLine and endLine are replaced)."
                        },
                        content: {
                            type: "string",
                            description: "New content to replace the specified line range. This will replace lines startLine through endLine (inclusive)."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["file", "startLine", "endLine", "content", "userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "✏️",
            function: {
                name: "EditFileBySearchAndReplace",
                description: "Search and replace exact string matches in a file. Use this when you know the exact text to find and replace. The file must exist in your file collection and must be a text-type file (text, markdown, html, csv, etc.). After modification, the old file version is deleted from cloud storage and the new version is uploaded. The collection entry is updated with the new URL and hash.",
                parameters: {
                    type: "object",
                    properties: {
                        file: {
                            type: "string",
                            description: "The file to modify: can be the file ID, filename, URL, or hash from your file collection. You can find available files in the Available Files section or ListFileCollection or SearchFileCollection."
                        },
                        oldString: {
                            type: "string",
                            description: "Exact string to replace. Must match the exact text in the file (including whitespace and newlines). The search is case-sensitive and must match exactly."
                        },
                        newString: {
                            type: "string",
                            description: "New content to replace oldString with."
                        },
                        replaceAll: {
                            type: "boolean",
                            description: "Optional: If true, replace all occurrences of oldString. Default: false (replace only first occurrence)."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["file", "oldString", "newString", "userMessage"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { file, startLine, endLine, content, oldString, newString, replaceAll = false, contextId, contextKey } = args;
        
        // Determine which tool was called based on parameters
        const isSearchReplace = oldString !== undefined && newString !== undefined;
        const isEditByLine = startLine !== undefined && endLine !== undefined && content !== undefined;
        const toolName = isSearchReplace ? "EditFileBySearchAndReplace" : "EditFileByLine";
        
        // Validate basic inputs
        if (!file || typeof file !== 'string') {
            const errorResult = {
                success: false,
                error: "file parameter is required and must be a string"
            };
            resolver.tool = JSON.stringify({ toolUsed: toolName });
            return JSON.stringify(errorResult);
        }

        if (!contextId) {
            const errorResult = {
                success: false,
                error: "contextId is required for file modification"
            };
            resolver.tool = JSON.stringify({ toolUsed: toolName });
            return JSON.stringify(errorResult);
        }

        // Validate that we have the right parameters for the tool being used
        if (!isSearchReplace && !isEditByLine) {
            const errorResult = {
                success: false,
                error: "Either use EditFileByLine (with startLine/endLine/content) or EditFileBySearchAndReplace (with oldString/newString)"
            };
            resolver.tool = JSON.stringify({ toolUsed: toolName });
            return JSON.stringify(errorResult);
        }

        // Validate EditFileByLine parameters
        if (isEditByLine) {
            if (typeof startLine !== 'number' || startLine < 1) {
                const errorResult = {
                    success: false,
                    error: "startLine must be a positive integer (1-indexed)"
                };
                resolver.tool = JSON.stringify({ toolUsed: "EditFileByLine" });
                return JSON.stringify(errorResult);
            }

            if (typeof endLine !== 'number' || endLine < 1) {
                const errorResult = {
                    success: false,
                    error: "endLine must be a positive integer (1-indexed)"
                };
                resolver.tool = JSON.stringify({ toolUsed: "EditFileByLine" });
                return JSON.stringify(errorResult);
            }

            if (endLine < startLine) {
                const errorResult = {
                    success: false,
                    error: "endLine must be >= startLine"
                };
                resolver.tool = JSON.stringify({ toolUsed: "EditFileByLine" });
                return JSON.stringify(errorResult);
            }

            if (typeof content !== 'string') {
                const errorResult = {
                    success: false,
                    error: "content is required and must be a string"
                };
                resolver.tool = JSON.stringify({ toolUsed: "EditFileByLine" });
                return JSON.stringify(errorResult);
            }
        }

        // Validate EditFileBySearchAndReplace parameters
        if (isSearchReplace) {
            if (typeof oldString !== 'string') {
                const errorResult = {
                    success: false,
                    error: "oldString is required and must be a string"
                };
                resolver.tool = JSON.stringify({ toolUsed: "EditFileBySearchAndReplace" });
                return JSON.stringify(errorResult);
            }

            if (typeof newString !== 'string') {
                const errorResult = {
                    success: false,
                    error: "newString is required and must be a string"
                };
                resolver.tool = JSON.stringify({ toolUsed: "EditFileBySearchAndReplace" });
                return JSON.stringify(errorResult);
            }
        }

        try {
            // Resolve file ID first (needed for serialization)
            const collection = await loadFileCollection(contextId, contextKey, false);
            const foundFile = findFileInCollection(file, collection);
            
            if (!foundFile) {
                const errorResult = {
                    success: false,
                    error: `File not found in collection: "${file}". Use ListFileCollection or SearchFileCollection to find available files.`
                };
                resolver.tool = JSON.stringify({ toolUsed: toolName });
                return JSON.stringify(errorResult);
            }
            
            const fileId = foundFile.id;
            
            // Serialize edits to this file (prevents concurrent edits on same instance)
            return await serializeEdit(contextId, fileId, async () => {
                // CRITICAL: Reload collection FIRST to get latest file data (may have changed from previous serialized edit)
                // This must happen inside serializeEdit to ensure we see the previous edit's changes
                const currentCollection = await loadFileCollection(contextId, contextKey, false);
                const currentFile = findFileInCollection(file, currentCollection);

                if (!currentFile) {
                    const errorResult = {
                        success: false,
                        error: `File not found in collection: "${file}"`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: toolName });
                    return JSON.stringify(errorResult);
                }
                
                // Store the file ID for updating
                let fileIdToUpdate = currentFile.id;

                // Resolve file URL AFTER reloading collection to ensure we get the latest URL
                // Use the file from the reloaded collection, not the initial resolution
                const fileUrl = currentFile.url;
            
                if (!fileUrl) {
                    const errorResult = {
                        success: false,
                        error: `File URL not found for: "${file}". The file may have been modified or removed.`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: toolName });
                    return JSON.stringify(errorResult);
                }

                // Download the current file content
                logger.info(`Downloading file for modification: ${fileUrl}`);
                const downloadResponse = await axios.get(fileUrl, {
                    responseType: 'arraybuffer',
                    timeout: 60000,
                    validateStatus: (status) => status >= 200 && status < 400
                });

                if (downloadResponse.status !== 200 || !downloadResponse.data) {
                    throw new Error(`Failed to download file: ${downloadResponse.status}`);
                }

                // Explicitly decode as UTF-8 to prevent mojibake (encoding corruption)
                const originalContent = Buffer.from(downloadResponse.data).toString('utf8');
                let modifiedContent;
                let modificationInfo = {};

                if (isEditByLine) {
                    // Line-based replacement mode
                    const allLines = originalContent.split(/\r?\n/);
                    const totalLines = allLines.length;

                    // Validate line range
                    if (startLine > totalLines) {
                        const errorResult = {
                            success: false,
                            error: `startLine (${startLine}) exceeds file length (${totalLines} lines)`
                        };
                        resolver.tool = JSON.stringify({ toolUsed: "EditFileByLine" });
                        return JSON.stringify(errorResult);
                    }

                    // Perform the line replacement
                    const startIndex = startLine - 1;
                    const endIndex = Math.min(endLine, totalLines);
                    
                    // Split the replacement content into lines
                    const replacementLines = content.split(/\r?\n/);
                    
                    // Build the modified content
                    const beforeLines = allLines.slice(0, startIndex);
                    const afterLines = allLines.slice(endIndex);
                    const modifiedLines = [...beforeLines, ...replacementLines, ...afterLines];
                    modifiedContent = modifiedLines.join('\n');

                    modificationInfo = {
                        mode: 'line-based',
                        originalLines: totalLines,
                        modifiedLines: modifiedLines.length,
                        replacedLines: endLine - startLine + 1,
                        insertedLines: replacementLines.length,
                        startLine: startLine,
                        endLine: endLine
                    };
                } else if (isSearchReplace) {
                    // Search and replace mode
                    if (!originalContent.includes(oldString)) {
                        const errorResult = {
                            success: false,
                            error: `oldString not found in file. The exact string must match (including whitespace and newlines).`
                        };
                        resolver.tool = JSON.stringify({ toolUsed: "EditFileBySearchAndReplace" });
                        return JSON.stringify(errorResult);
                    }

                    // Count occurrences
                    const occurrences = (originalContent.match(new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                    
                    if (replaceAll) {
                        modifiedContent = originalContent.split(oldString).join(newString);
                        modificationInfo = {
                            mode: 'string-based',
                            replaceAll: true,
                            occurrencesReplaced: occurrences
                        };
                    } else {
                        // Replace only first occurrence
                        modifiedContent = originalContent.replace(oldString, newString);
                        modificationInfo = {
                            mode: 'string-based',
                            replaceAll: false,
                            occurrencesReplaced: 1,
                            totalOccurrences: occurrences
                        };
                    }
                }

                // Determine MIME type from filename using utility function
                // Use displayFilename (user-friendly) if available, otherwise fall back to filename (CFH-managed)
                const filename = currentFile.displayFilename || currentFile.filename || 'modified.txt';
                let mimeType = getMimeTypeFromFilename(filename, 'text/plain');
                
                // Add charset=utf-8 for text-based MIME types
                if (isTextMimeType(mimeType)) {
                    mimeType = `${mimeType}; charset=utf-8`;
                }

                // Upload the modified file FIRST (safer: prevent data loss if upload fails)
                const fileBuffer = Buffer.from(modifiedContent, 'utf8');
                const uploadResult = await uploadFileToCloud(
                    fileBuffer,
                    mimeType,
                    filename,
                    resolver,
                    contextId
                );

                if (!uploadResult || !uploadResult.url) {
                    throw new Error('Failed to upload modified file to cloud storage');
                }

                // Update the file collection entry directly (atomic operation)
                // Reload collection to get the latest file data (important after prior edits)
                const latestCollection = await loadFileCollection(contextId, contextKey, false);
                let fileToUpdate = latestCollection.find(f => f.id === fileIdToUpdate);
                
                // If not found by ID, try to find by the original file parameter (in case lookup by ID failed)
                if (!fileToUpdate) {
                    fileToUpdate = findFileInCollection(file, latestCollection);
                    if (fileToUpdate) {
                        // Update fileIdToUpdate to use the found file's ID
                        fileIdToUpdate = fileToUpdate.id;
                    }
                }
                
                if (!fileToUpdate) {
                    throw new Error(`File with ID "${fileIdToUpdate}" not found in collection. The file may have been modified or removed.`);
                }
                
                const oldHashToDelete = fileToUpdate.hash || null;
                
                // Write new entry with CFH data (url, gcs, hash) + Cortex metadata
                // If hash changed, this creates a new entry; if same hash, it updates the existing one
                if (uploadResult.hash) {
                    const { getRedisClient } = await import('../../../../lib/fileUtils.js');
                    const redisClient = await getRedisClient();
                    if (redisClient) {
                        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
                        
                        // Get existing CFH data for the new hash (if any)
                        const existingDataStr = await redisClient.hget(contextMapKey, uploadResult.hash);
                        let existingData = {};
                        if (existingDataStr) {
                            try {
                                existingData = JSON.parse(existingDataStr);
                            } catch (e) {
                                existingData = {};
                            }
                        }
                        
                        // Merge CFH data (url, gcs, hash) with Cortex metadata
                        const fileData = {
                            ...existingData, // Preserve any existing CFH data
                            // CFH-managed fields (from upload result)
                            url: uploadResult.url,
                            gcs: uploadResult.gcs || null,
                            hash: uploadResult.hash,
                            filename: uploadResult.filename || fileToUpdate.filename || filename, // Use CFH filename if available, otherwise preserve
                            // Cortex-managed metadata
                            id: fileToUpdate.id, // Keep same ID
                            displayFilename: fileToUpdate.displayFilename || filename, // Preserve user-friendly filename
                            tags: fileToUpdate.tags || [],
                            notes: fileToUpdate.notes || '',
                            mimeType: fileToUpdate.mimeType || mimeType || null,
                            inCollection: ['*'], // Mark as global chat file (available to all chats)
                            addedDate: fileToUpdate.addedDate, // Keep original added date
                            lastAccessed: new Date().toISOString(),
                            permanent: fileToUpdate.permanent || false
                        };
                        
                        // Write new entry (atomic operation) - encryption happens in helper
                        await writeFileDataToRedis(redisClient, contextMapKey, uploadResult.hash, fileData, contextKey);
                        
                        // If hash changed, remove old entry
                        if (oldHashToDelete && oldHashToDelete !== uploadResult.hash) {
                            await redisClient.hdel(contextMapKey, oldHashToDelete);
                        }
                        
                        // Invalidate cache immediately so subsequent operations get fresh data
                        invalidateFileCollectionCache(contextId, contextKey);
                    }
                } else if (fileToUpdate.hash) {
                    // Same hash, just update Cortex metadata (filename, lastAccessed)
                    await updateFileMetadata(contextId, fileToUpdate.hash, {
                        filename: filename,
                        lastAccessed: new Date().toISOString()
                    }, contextKey);
                    
                    // Invalidate cache after metadata update
                    invalidateFileCollectionCache(contextId, contextKey);
                }

                // Now it is safe to delete the old file version (after lock succeeds)
                // This ensures we're deleting the correct hash even if concurrent edits occurred
                if (oldHashToDelete) {
                    // Fire-and-forget async deletion for better performance, but log errors
                    // We don't want to fail the whole operation if cleanup fails, since we have the new file
                    (async () => {
                        try {
                            logger.info(`Deleting old file version with hash ${oldHashToDelete} (background task)`);
                            await deleteFileByHash(oldHashToDelete, resolver, contextId);
                        } catch (cleanupError) {
                            logger.warn(`Failed to cleanup old file version (hash: ${oldHashToDelete}): ${cleanupError.message}`);
                        }
                    })().catch(err => logger.error(`Async cleanup error: ${err}`));
                } else {
                    logger.info(`No hash found for old file, skipping deletion`);
                }
                
                // Get the updated file info for the result
                // Use useCache: false to ensure we get fresh data after Redis write
                const updatedCollection = await loadFileCollection(contextId, contextKey, false);
                const updatedFile = updatedCollection.find(f => f.id === fileIdToUpdate);
                
                if (!updatedFile) {
                    logger.warn(`File with ID "${fileIdToUpdate}" not found in updated collection. This may indicate a timing issue.`);
                    // Fall back to using uploadResult data directly
                    const fallbackFile = {
                        id: fileIdToUpdate,
                        url: uploadResult.url,
                        hash: uploadResult.hash
                    };
                    logger.info(`Using fallback file data: ${JSON.stringify(fallbackFile)}`);
                }

                // Build result message
                let message;
                if (isEditByLine) {
                    message = `File "${filename}" modified successfully. Replaced lines ${startLine}-${endLine} (${endLine - startLine + 1} lines) with ${modificationInfo.insertedLines} line(s).`;
                } else if (isSearchReplace) {
                    if (replaceAll) {
                        message = `File "${filename}" modified successfully. Replaced all ${modificationInfo.occurrencesReplaced} occurrence(s) of the specified string.`;
                    } else {
                        message = `File "${filename}" modified successfully. Replaced first occurrence of the specified string${modificationInfo.totalOccurrences > 1 ? ` (${modificationInfo.totalOccurrences} total occurrences found)` : ''}.`;
                    }
                }

                const result = {
                    success: true,
                    filename: filename,
                    fileId: updatedFile?.id || fileIdToUpdate,
                    url: uploadResult.url, // Always use the new URL from upload
                    gcs: uploadResult.gcs || null,
                    hash: uploadResult.hash || null,
                    ...modificationInfo,
                    message: message
                };
                
                // Log for debugging
                if (!updatedFile) {
                    logger.warn(`EditFile: Could not find updated file in collection, but upload succeeded. Using uploadResult URL: ${uploadResult.url}`);
                } else {
                    logger.info(`EditFile: Successfully updated file. New URL: ${uploadResult.url}, New hash: ${uploadResult.hash}`);
                }

                resolver.tool = JSON.stringify({ toolUsed: toolName });
                return JSON.stringify(result);
            }).catch(error => {
                let errorMsg;
                if (error?.message) {
                    errorMsg = error.message;
                } else if (error?.errors && Array.isArray(error.errors)) {
                    // Handle AggregateError
                    errorMsg = error.errors.map(e => e?.message || String(e)).join('; ');
                } else {
                    errorMsg = String(error);
                }
                logger.error(`Error modifying file: ${errorMsg}`);
                
                const errorResult = {
                    success: false,
                    error: errorMsg
                };

                resolver.tool = JSON.stringify({ toolUsed: toolName });
                return JSON.stringify(errorResult);
            });
        } catch (error) {
            // Handle errors before serialization (file not found, validation errors, etc.)
            let errorMsg;
            if (error?.message) {
                errorMsg = error.message;
            } else if (error?.errors && Array.isArray(error.errors)) {
                errorMsg = error.errors.map(e => e?.message || String(e)).join('; ');
            } else {
                errorMsg = String(error);
            }
            logger.error(`Error in file edit operation: ${errorMsg}`);
            
            const errorResult = {
                success: false,
                error: errorMsg
            };

            resolver.tool = JSON.stringify({ toolUsed: toolName });
            return JSON.stringify(errorResult);
        }
    }
};

