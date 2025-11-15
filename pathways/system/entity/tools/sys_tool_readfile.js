// sys_tool_readfile.js
// Tool pathway that reads text files with line number support
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { resolveFileParameter } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: { 
        type: "function",
        icon: "📖",
        function: {
            name: "ReadFile",
            description: "Read text content from a file. Can read the entire file or specific line ranges. Use this to access and analyze text files from your file collection. Supports text files, markdown files, html, csv, and other document formats that can be converted to text, but not images, videos, or audio files or pdfs.",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "The file to read: can be the file ID, filename, URL, or hash from your file collection. You can find available files in the Available Files section or ListFileCollection or SearchFileCollection."
                    },
                    startLine: {
                        type: "number",
                        description: "Optional: Starting line number (1-indexed). If not provided, reads from the beginning."
                    },
                    endLine: {
                        type: "number",
                        description: "Optional: Ending line number (1-indexed). If not provided, reads to the end. Must be >= startLine if startLine is provided."
                    },
                    maxLines: {
                        type: "number",
                        description: "Optional: Maximum number of lines to read (default: 1000). Use this to limit the size of the response."
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

    executePathway: async ({args, runAllPrompts, resolver}) => {
        try {
            let { cloudUrl, file, startLine, endLine, maxLines = 1000, contextId, contextKey } = args;
            
            // If file parameter is provided, resolve it to a URL using the common utility
            if (file) {
                if (!contextId) {
                    const errorResult = {
                        success: false,
                        error: "contextId is required when using the 'file' parameter. Use ListFileCollection or SearchFileCollection to find available files."
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
                const resolvedUrl = await resolveFileParameter(file, contextId, contextKey);
                if (!resolvedUrl) {
                    const errorResult = {
                        success: false,
                        error: `File not found: "${file}". Use ListFileCollection or SearchFileCollection to find available files.`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
                cloudUrl = resolvedUrl;
            }
            
            if (!cloudUrl || typeof cloudUrl !== 'string') {
                const errorResult = {
                    success: false,
                    error: "Either cloudUrl or file parameter is required and must be a string"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            if (startLine !== undefined) {
                if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
                const errorResult = {
                    success: false,
                        error: "startLine must be a positive integer (1-indexed)"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
                }
            }

            if (endLine !== undefined) {
                if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
                const errorResult = {
                    success: false,
                        error: "endLine must be a positive integer (1-indexed)"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
                }
            }

            if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
                const errorResult = {
                    success: false,
                    error: "endLine must be >= startLine"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            if (maxLines !== undefined) {
                if (typeof maxLines !== 'number' || !Number.isInteger(maxLines) || maxLines < 1) {
                    const errorResult = {
                        success: false,
                        error: "maxLines must be a positive integer"
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
            }
            // Download file content directly from the URL (don't use file handler for content)
            // Use arraybuffer and explicitly decode as UTF-8 to avoid encoding issues
            const response = await axios.get(cloudUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 400
            });

            if (response.status !== 200 || !response.data) {
                throw new Error(`Failed to download file content: ${response.status}`);
            }

            // Explicitly decode as UTF-8 to prevent mojibake (encoding corruption)
            const textContent = Buffer.from(response.data).toString('utf8');
            const allLines = textContent.split(/\r?\n/);
            const totalLines = allLines.length;

            // Handle empty file
            if (totalLines === 0 || (totalLines === 1 && allLines[0] === '')) {
                const result = {
                    success: true,
                    cloudUrl: cloudUrl,
                    totalLines: 0,
                    returnedLines: 0,
                    startLine: 1,
                    endLine: 0,
                    content: '',
                    truncated: false,
                    isEmpty: true
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(result);
            }

            // Apply line range filtering
            let selectedLines = allLines;
            let actualStartLine = 1;
            let actualEndLine = totalLines;
            let wasTruncatedByRange = false;

            if (startLine !== undefined || endLine !== undefined) {
                const start = startLine !== undefined ? Math.max(1, Math.min(startLine, totalLines)) - 1 : 0; // Convert to 0-indexed, clamp to valid range
                const end = endLine !== undefined ? Math.min(totalLines, Math.max(1, endLine)) : totalLines; // Clamp to valid range
                
                if (startLine !== undefined && startLine > totalLines) {
                    const errorResult = {
                        success: false,
                        error: `startLine (${startLine}) exceeds file length (${totalLines} lines)`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }

                selectedLines = allLines.slice(start, end);
                actualStartLine = start + 1; // Convert back to 1-indexed
                actualEndLine = end;
                wasTruncatedByRange = (endLine !== undefined && endLine < totalLines) || (startLine !== undefined && startLine > 1);
            }

            // Apply maxLines limit
            let wasTruncatedByMaxLines = false;
            if (selectedLines.length > maxLines) {
                selectedLines = selectedLines.slice(0, maxLines);
                wasTruncatedByMaxLines = true;
            }

            const result = {
                success: true,
                cloudUrl: cloudUrl,
                totalLines: totalLines,
                returnedLines: selectedLines.length,
                startLine: actualStartLine,
                endLine: actualEndLine,
                content: selectedLines.join('\n'),
                truncated: wasTruncatedByRange || wasTruncatedByMaxLines,
                truncatedByRange: wasTruncatedByRange,
                truncatedByMaxLines: wasTruncatedByMaxLines
            };

            resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
            return JSON.stringify(result);

        } catch (e) {
            let errorMsg;
            if (e?.message) {
                errorMsg = e.message;
            } else if (e?.response) {
                // Handle HTTP errors
                const status = e.response.status;
                const statusText = e.response.statusText || '';
                errorMsg = `HTTP ${status}${statusText ? ` ${statusText}` : ''}: Failed to download file`;
            } else if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
                errorMsg = 'Request timeout: File download took too long';
            } else if (e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED') {
                errorMsg = `Connection error: ${e.message || 'Unable to reach file server'}`;
            } else if (typeof e === 'string') {
                errorMsg = e;
            } else if (e?.errors && Array.isArray(e.errors)) {
                // Handle AggregateError
                errorMsg = e.errors.map(err => err?.message || String(err)).join('; ');
            } else if (e) {
                errorMsg = String(e);
            } else {
                errorMsg = 'Unknown error occurred while reading file';
            }

            logger.error(`Error reading cloud file ${cloudUrl || file || 'unknown'}: ${errorMsg}`);
            
            const errorResult = {
                success: false,
                cloudUrl: cloudUrl || null,
                file: file || null,
                error: errorMsg
            };

            resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
            return JSON.stringify(errorResult);
        }
    }
};

