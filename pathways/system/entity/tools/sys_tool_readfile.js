// sys_tool_readfile.js
// Tool pathway that reads text files with line number support
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
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

            if (startLine !== undefined && (typeof startLine !== 'number' || startLine < 1)) {
                const errorResult = {
                    success: false,
                    error: "startLine must be a positive integer"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            if (endLine !== undefined && (typeof endLine !== 'number' || endLine < 1)) {
                const errorResult = {
                    success: false,
                    error: "endLine must be a positive integer"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
                const errorResult = {
                    success: false,
                    error: "endLine must be >= startLine"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
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

            // Apply line range filtering
            let selectedLines = allLines;
            if (startLine !== undefined || endLine !== undefined) {
                const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0; // Convert to 0-indexed
                const end = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines;
                selectedLines = allLines.slice(start, end);
            }

            // Apply maxLines limit
            if (selectedLines.length > maxLines) {
                selectedLines = selectedLines.slice(0, maxLines);
            }

            const result = {
                success: true,
                cloudUrl: cloudUrl,
                totalLines: totalLines,
                returnedLines: selectedLines.length,
                startLine: startLine || 1,
                endLine: endLine || totalLines,
                content: selectedLines.join('\n'),
                truncated: selectedLines.length < allLines.length || (endLine !== undefined && endLine < totalLines)
            };

            resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
            return JSON.stringify(result);

        } catch (e) {
            logger.error(`Error reading cloud file ${cloudUrl}: ${e.message}`);
            
            const errorResult = {
                success: false,
                cloudUrl: cloudUrl,
                error: e.message || "Unknown error occurred while reading file"
            };

            resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
            return JSON.stringify(errorResult);
        }
    }
};

