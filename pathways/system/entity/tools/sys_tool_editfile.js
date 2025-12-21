// sys_tool_editfile.js
// Entity tool that modifies existing files by replacing line ranges or exact string matches
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { uploadFileToCloud, findFileInCollection, loadFileCollection, getMimeTypeFromFilename, deleteFileByHash, isTextMimeType, updateFileMetadata, writeFileDataToRedis, invalidateFileCollectionCache, getActualContentMimeType } from '../../../../lib/fileUtils.js';

// Maximum file size for editing (50MB) - prevents memory blowup on huge files
const MAX_EDITABLE_FILE_SIZE = 50 * 1024 * 1024;

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// In-process serialization: prevents concurrent edits to the same file on this instance
// Uses promise chaining to execute edits sequentially per file
const editQueues = new Map();

// Local file cache: avoids repeated downloads/uploads for sequential edits
// Key: lockKey (contextId:fileId), Value: { content, file, dirty }
const fileContentCache = new Map();

/**
 * Serialize edit operations per file to prevent concurrent edits on the same instance
 * Uses promise chaining to execute edits sequentially. No deadlock risk (single resource lock).
 * Also manages local file caching: downloads once, uploads once when session ends.
 * @param {string} contextId - Context ID
 * @param {string} fileId - File ID
 * @param {Function} editFn - Async function that performs the edit, receives { cachedContent, cachedFile } or null
 * @returns {Promise} Promise that resolves when this edit completes
 */
async function serializeEdit(contextId, fileId, editFn) {
    const lockKey = `${contextId}:${fileId}`;
    
    // Get existing queue or start with resolved promise
    let queue = editQueues.get(lockKey) || Promise.resolve();
    
    // Chain this operation after the previous one
    // Timeout protection: pathway timeout (120s) will handle stuck operations
    const operation = queue.then(async () => {
        // Pass cached content to edit function (if available)
        const cached = fileContentCache.get(lockKey);
        const result = await editFn(cached);
        
        // Check if we're the last operation (no more edits queued)
        // If yes, we need to flush (upload); if no, skip upload
        const isLastOperation = (editQueues.get(lockKey) === operation);
        
        return { ...result, _isLastOperation: isLastOperation, _lockKey: lockKey };
    }).finally(() => {
        // Cleanup: remove queue if we're still the current one (no new operations queued)
        // This prevents memory leaks if operations complete
        if (editQueues.get(lockKey) === operation) {
            editQueues.delete(lockKey);
            fileContentCache.delete(lockKey); // Clear cache when session ends
        }
    });
    
    editQueues.set(lockKey, operation);
    return operation;
}

/**
 * Update the local file cache with modified content
 */
function updateFileCache(lockKey, content, file) {
    fileContentCache.set(lockKey, { content, file, dirty: true });
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
            
            // Prevent editing converted files (they can be read but not edited)
            if (foundFile._isConverted) {
                const errorResult = {
                    success: false,
                    error: `Cannot edit converted files. The file "${foundFile.displayFilename || file}" is a converted version and cannot be edited. You can read it using ReadTextFile, but to edit it you would need to edit the original file.`
                };
                resolver.tool = JSON.stringify({ toolUsed: toolName });
                return JSON.stringify(errorResult);
            }
            
            const fileId = foundFile.id;
            
            // Serialize edits to this file (prevents concurrent edits on same instance)
            // The callback receives cached content if available (from previous edits in this session)
            const editResult = await serializeEdit(contextId, fileId, async (cached) => {
                const lockKey = `${contextId}:${fileId}`;
                let currentFile;
                let originalContent;
                
                if (cached && cached.content !== undefined) {
                    // Use cached content from previous edit in this session (skip download)
                    originalContent = cached.content;
                    currentFile = cached.file;
                    logger.info(`Using cached content for: ${currentFile.displayFilename || file}`);
                } else {
                    // First edit in session: load collection and download file
                    const currentCollection = await loadFileCollection(contextId, contextKey, false);
                    currentFile = findFileInCollection(file, currentCollection);

                    if (!currentFile) {
                        const errorResult = {
                            success: false,
                            error: `File not found in collection: "${file}"`
                        };
                        resolver.tool = JSON.stringify({ toolUsed: toolName });
                        return { jsonResult: JSON.stringify(errorResult) };
                    }
                    
                    // Use the file URL (already uses converted URL if it exists)
                    const fileUrl = currentFile.url;
                
                    if (!fileUrl) {
                        const errorResult = {
                            success: false,
                            error: `File URL not found for: "${file}". The file may have been modified or removed.`
                        };
                        resolver.tool = JSON.stringify({ toolUsed: toolName });
                        return { jsonResult: JSON.stringify(errorResult) };
                    }

                    // Download the file content
                    logger.info(`Downloading file for modification: ${fileUrl}`);
                    const downloadResponse = await axios.get(fileUrl, {
                        responseType: 'arraybuffer',
                        timeout: 60000,
                        validateStatus: (status) => status >= 200 && status < 400
                    });

                    if (downloadResponse.status !== 200 || !downloadResponse.data) {
                        throw new Error(`Failed to download file: ${downloadResponse.status}`);
                    }

                    // Check file size to prevent memory blowup
                    const fileSize = downloadResponse.data.length;
                    if (fileSize > MAX_EDITABLE_FILE_SIZE) {
                        const errorResult = {
                            success: false,
                            error: `File too large for editing (${formatBytes(fileSize)}). Maximum editable file size is ${formatBytes(MAX_EDITABLE_FILE_SIZE)}. Consider splitting the file or using a different approach.`
                        };
                        resolver.tool = JSON.stringify({ toolUsed: toolName });
                        return { jsonResult: JSON.stringify(errorResult) };
                    }

                    // Explicitly decode as UTF-8 to prevent mojibake (encoding corruption)
                    originalContent = Buffer.from(downloadResponse.data).toString('utf8');
                }
                
                // Store the file ID for updating
                let fileIdToUpdate = currentFile.id;
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
                        return { jsonResult: JSON.stringify(errorResult) };
                    }

                    // Perform the line replacement
                    const startIndex = startLine - 1;
                    const endIndex = Math.min(endLine, totalLines);
                    
                    // Split the replacement content into lines
                    // Strip trailing newlines to prevent extra blank lines being inserted
                    const trimmedContent = content.replace(/[\r\n]+$/, '');
                    const replacementLines = trimmedContent.split(/\r?\n/);
                    
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
                        return { jsonResult: JSON.stringify(errorResult) };
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

                // Determine MIME type from actual stored content (URL), not displayFilename
                // displayFilename may have a different extension than the actual content
                // (e.g., displayFilename="report.docx" but content is markdown after conversion)
                const filename = currentFile.displayFilename || currentFile.filename || 'modified.txt';
                let mimeType = getActualContentMimeType(currentFile) || getMimeTypeFromFilename(filename, 'text/plain');
                
                // Add charset=utf-8 for text-based MIME types
                if (isTextMimeType(mimeType)) {
                    mimeType = `${mimeType}; charset=utf-8`;
                }

                // Update local cache with modified content
                // The wrapper will decide whether to upload (only on last operation)
                updateFileCache(lockKey, modifiedContent, currentFile);

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

                // Return edit result with data needed for upload (wrapper handles upload decision)
                return {
                    modifiedContent,
                    currentFile,
                    fileIdToUpdate,
                    filename,
                    mimeType,
                    modificationInfo,
                    message,
                    // Pass these for upload phase
                    contextId,
                    contextKey,
                    resolver,
                    file, // original file parameter for fallback lookup
                    isEditByLine,
                    isSearchReplace,
                    replaceAll,
                    startLine,
                    endLine
                };
            });

            // Handle early return (error cases)
            if (editResult.jsonResult) {
                return editResult.jsonResult;
            }

            // Check if we need to upload (only on last operation in queue)
            if (editResult._isLastOperation) {
                // Flush: upload the final content and update metadata
                const { modifiedContent, currentFile, fileIdToUpdate: initialFileId, filename, mimeType, 
                        modificationInfo, message, contextId: ctxId, contextKey: ctxKey, resolver: res,
                        file: fileParam, isEditByLine: isByLine, isSearchReplace: isSR, replaceAll: repAll,
                        startLine: sLine, endLine: eLine } = editResult;
                
                let fileIdToUpdate = initialFileId;
                
                logger.info(`Flushing cached edits for: ${filename}`);
                
                // Upload the modified file
                const fileBuffer = Buffer.from(modifiedContent, 'utf8');
                const uploadResult = await uploadFileToCloud(
                    fileBuffer,
                    mimeType,
                    filename,
                    res,
                    ctxId
                );

                if (!uploadResult || !uploadResult.url) {
                    throw new Error('Failed to upload modified file to cloud storage');
                }

                // Update the file collection entry directly (atomic operation)
                const latestCollection = await loadFileCollection(ctxId, ctxKey, false);
                let fileToUpdate = latestCollection.find(f => f.id === fileIdToUpdate);
                
                // If not found by ID, try to find by the original file parameter
                if (!fileToUpdate) {
                    fileToUpdate = findFileInCollection(fileParam, latestCollection);
                    if (fileToUpdate) {
                        fileIdToUpdate = fileToUpdate.id;
                    }
                }
                
                if (!fileToUpdate) {
                    throw new Error(`File with ID "${fileIdToUpdate}" not found in collection. The file may have been modified or removed.`);
                }
                
                const oldHashToDelete = fileToUpdate.hash || null;
                
                // Write new entry with CFH data (url, gcs, hash) + Cortex metadata
                if (uploadResult.hash) {
                    const { getRedisClient } = await import('../../../../lib/fileUtils.js');
                    const redisClient = await getRedisClient();
                    if (redisClient) {
                        const contextMapKey = `FileStoreMap:ctx:${ctxId}`;
                        
                        const existingDataStr = await redisClient.hget(contextMapKey, uploadResult.hash);
                        let existingData = {};
                        if (existingDataStr) {
                            try {
                                existingData = JSON.parse(existingDataStr);
                            } catch (e) {
                                existingData = {};
                            }
                        }
                        
                        const fileData = {
                            ...existingData,
                            url: uploadResult.url,
                            gcs: uploadResult.gcs || null,
                            hash: uploadResult.hash,
                            filename: uploadResult.filename || fileToUpdate.filename || filename,
                            id: fileToUpdate.id,
                            displayFilename: fileToUpdate.displayFilename || filename,
                            tags: fileToUpdate.tags || [],
                            notes: fileToUpdate.notes || '',
                            mimeType: fileToUpdate.mimeType || mimeType || null,
                            inCollection: ['*'],
                            addedDate: fileToUpdate.addedDate,
                            lastAccessed: new Date().toISOString(),
                            permanent: fileToUpdate.permanent || false
                        };
                        
                        await writeFileDataToRedis(redisClient, contextMapKey, uploadResult.hash, fileData, ctxKey);
                        
                        if (oldHashToDelete && oldHashToDelete !== uploadResult.hash) {
                            await redisClient.hdel(contextMapKey, oldHashToDelete);
                        }
                        
                        invalidateFileCollectionCache(ctxId, ctxKey);
                    }
                } else if (fileToUpdate.hash) {
                    await updateFileMetadata(ctxId, fileToUpdate.hash, {
                        filename: filename,
                        lastAccessed: new Date().toISOString()
                    }, ctxKey);
                    
                    invalidateFileCollectionCache(ctxId, ctxKey);
                }

                // Delete old file version (fire-and-forget)
                if (oldHashToDelete && oldHashToDelete !== uploadResult.hash) {
                    (async () => {
                        try {
                            logger.info(`Deleting old file version with hash ${oldHashToDelete} (background task)`);
                            await deleteFileByHash(oldHashToDelete, res, ctxId);
                        } catch (cleanupError) {
                            logger.warn(`Failed to cleanup old file version: ${cleanupError.message}`);
                        }
                    })().catch(err => logger.error(`Async cleanup error: ${err}`));
                }

                const result = {
                    success: true,
                    filename: filename,
                    fileId: fileIdToUpdate,
                    url: uploadResult.url,
                    gcs: uploadResult.gcs || null,
                    hash: uploadResult.hash || null,
                    ...modificationInfo,
                    message: message
                };
                
                logger.info(`EditFile: Flushed and uploaded. New URL: ${uploadResult.url}, New hash: ${uploadResult.hash}`);

                resolver.tool = JSON.stringify({ toolUsed: toolName });
                return JSON.stringify(result);
            } else {
                // Intermediate edit: content cached, upload deferred to last operation
                const { filename, modificationInfo, message, isEditByLine, isSearchReplace, replaceAll,
                        startLine, endLine, currentFile } = editResult;
                
                logger.info(`EditFile: Cached edit for: ${filename} (upload deferred)`);

                const result = {
                    success: true,
                    filename: filename,
                    fileId: currentFile.id,
                    // No URL/hash yet - upload pending
                    pending: true,
                    ...modificationInfo,
                    message: `${message} (upload pending - will be saved with next operation)`
                };

                resolver.tool = JSON.stringify({ toolUsed: toolName });
                return JSON.stringify(result);
            }
        } catch (error) {
            // Handle errors in file edit operation
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

