// sys_tool_modifyfile.js
// Entity tool that modifies existing files by replacing line ranges
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { uploadFileToCloud, findFileInCollection, loadFileCollection, saveFileCollection, getMimeTypeFromFilename } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    timeout: 120,
    toolDefinition: { 
        type: "function",
        icon: "✏️",
        function: {
            name: "ModifyFile",
            description: "Modify an existing file by replacing a range of lines with new content. The file must exist in your file collection and must be a text-type file (text, markdown, html, csv, etc.). Use this to edit, update, or patch files. After modification, the file is re-uploaded and the collection entry is updated.",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "The file to modify: can be the file ID, filename, URL, or hash from your file collection. You can find available files in the availableFiles section."
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
                        description: "The new content to replace the specified line range. This will replace lines startLine through endLine (inclusive)."
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

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { file, startLine, endLine, content, contextId, contextKey } = args;
        
        // Validate inputs
        if (!file || typeof file !== 'string') {
            const errorResult = {
                success: false,
                error: "file parameter is required and must be a string"
            };
            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }

        if (!contextId) {
            const errorResult = {
                success: false,
                error: "contextId is required for file modification"
            };
            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }

        if (typeof startLine !== 'number' || startLine < 1) {
            const errorResult = {
                success: false,
                error: "startLine must be a positive integer (1-indexed)"
            };
            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }

        if (typeof endLine !== 'number' || endLine < 1) {
            const errorResult = {
                success: false,
                error: "endLine must be a positive integer (1-indexed)"
            };
            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }

        if (endLine < startLine) {
            const errorResult = {
                success: false,
                error: "endLine must be >= startLine"
            };
            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }

        if (typeof content !== 'string') {
            const errorResult = {
                success: false,
                error: "content is required and must be a string"
            };
            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }

        try {
            // Find the file in the collection
            const collection = await loadFileCollection(contextId, contextKey, true);
            const foundFile = findFileInCollection(file, collection);
            
            if (!foundFile) {
                const errorResult = {
                    success: false,
                    error: `File not found in collection: ${file}. Use ListFileCollection or SearchFileCollection to find available files.`
                };
                resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
                return JSON.stringify(errorResult);
            }

            // Get the file URL (prefer converted URL if available)
            const fileUrl = foundFile.url;
            if (!fileUrl) {
                const errorResult = {
                    success: false,
                    error: "File found but has no URL"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
                return JSON.stringify(errorResult);
            }

            // Download the current file content
            logger.info(`Downloading file for modification: ${fileUrl}`);
            const downloadResponse = await axios.get(fileUrl, {
                responseType: 'text',
                timeout: 60000,
                validateStatus: (status) => status >= 200 && status < 400
            });

            if (downloadResponse.status !== 200 || typeof downloadResponse.data !== 'string') {
                throw new Error(`Failed to download file: ${downloadResponse.status}`);
            }

            const originalContent = downloadResponse.data;
            const allLines = originalContent.split(/\r?\n/);
            const totalLines = allLines.length;

            // Validate line range
            if (startLine > totalLines) {
                const errorResult = {
                    success: false,
                    error: `startLine (${startLine}) exceeds file length (${totalLines} lines)`
                };
                resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
                return JSON.stringify(errorResult);
            }

            // Perform the line replacement
            // Convert to 0-indexed for array operations
            // startLine is 1-indexed, so startIndex = startLine - 1
            // endLine is 1-indexed and inclusive, so we want to include it
            // slice end is exclusive, so we use endLine (not endLine - 1) to get everything after endLine
            const startIndex = startLine - 1;
            const endIndex = Math.min(endLine, totalLines); // endLine is 1-indexed, slice end is exclusive
            
            // Split the replacement content into lines
            const replacementLines = content.split(/\r?\n/);
            
            // Build the modified content
            // Lines before the replacement range
            const beforeLines = allLines.slice(0, startIndex);
            // Lines after the replacement range (endIndex is exclusive, so this gets lines after endLine)
            const afterLines = allLines.slice(endIndex);
            // Combine: before + replacement + after
            const modifiedLines = [...beforeLines, ...replacementLines, ...afterLines];
            const modifiedContent = modifiedLines.join('\n');

            // Determine MIME type from filename using utility function
            const filename = foundFile.filename || 'modified.txt';
            let mimeType = getMimeTypeFromFilename(filename, 'text/plain');
            
            // Add charset=utf-8 for text-based MIME types
            if (mimeType.startsWith('text/') || mimeType === 'application/json' || 
                mimeType === 'application/javascript' || mimeType === 'application/typescript' ||
                mimeType === 'application/xml') {
                mimeType = `${mimeType}; charset=utf-8`;
            }

            // Upload the modified file
            const fileBuffer = Buffer.from(modifiedContent, 'utf8');
            const uploadResult = await uploadFileToCloud(
                fileBuffer,
                mimeType,
                filename,
                resolver
            );

            if (!uploadResult || !uploadResult.url) {
                throw new Error('Failed to upload modified file to cloud storage');
            }

            // Update the file collection entry with new URL and hash
            foundFile.url = uploadResult.url;
            if (uploadResult.gcs) {
                foundFile.gcs = uploadResult.gcs;
            }
            if (uploadResult.hash) {
                foundFile.hash = uploadResult.hash;
            }
            foundFile.lastAccessed = new Date().toISOString();

            // Save the updated collection
            await saveFileCollection(contextId, contextKey, collection);

            const result = {
                success: true,
                filename: filename,
                fileId: foundFile.id,
                url: uploadResult.url,
                gcs: uploadResult.gcs || null,
                hash: uploadResult.hash || null,
                originalLines: totalLines,
                modifiedLines: modifiedLines.length,
                replacedLines: endLine - startLine + 1,
                insertedLines: replacementLines.length,
                startLine: startLine,
                endLine: endLine,
                message: `File "${filename}" modified successfully. Replaced lines ${startLine}-${endLine} (${endLine - startLine + 1} lines) with ${replacementLines.length} line(s).`
            };

            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(result);

        } catch (error) {
            let errorMsg = 'Unknown error';
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

            resolver.tool = JSON.stringify({ toolUsed: "ModifyFile" });
            return JSON.stringify(errorResult);
        }
    }
};

