// sys_tool_readfile.js
// Tool pathway that reads text files with line number support
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { findFileInCollection, loadFileCollection } from '../../../../lib/fileUtils.js';

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
                    cloudUrl: {
                        type: "string",
                        description: "The cloud storage URL of the file to read (from your file collection or AddFileToCollection). You can also use the 'file' parameter instead to reference a file from your collection."
                    },
                    file: {
                        type: "string",
                        description: "Optional: File URL (Azure or GCS), file ID from your file collection, or file hash. If provided, this will be used instead of cloudUrl. You can find available files in the availableFiles section."
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
        let { cloudUrl, file, startLine, endLine, maxLines = 1000, contextId, contextKey } = args;
        
        // If file parameter is provided, look it up in the collection and extract cloudUrl
        if (file) {
            if (contextId) {
                // Try to find the file in the collection
                const collection = await loadFileCollection(contextId, contextKey, true);
                const foundFile = findFileInCollection(file, collection);
                if (foundFile) {
                    cloudUrl = foundFile.url;
                } else {
                    // File not found in collection, but might be a direct URL
                    cloudUrl = file;
                }
            } else {
                // No contextId, treat as direct URL
                cloudUrl = file;
            }
        }
        
        if (!cloudUrl || typeof cloudUrl !== 'string') {
            throw new Error("Either cloudUrl or file parameter is required and must be a string");
        }

        if (startLine !== undefined && (typeof startLine !== 'number' || startLine < 1)) {
            throw new Error("startLine must be a positive integer");
        }

        if (endLine !== undefined && (typeof endLine !== 'number' || endLine < 1)) {
            throw new Error("endLine must be a positive integer");
        }

        if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
            throw new Error("endLine must be >= startLine");
        }

        try {
            // Download file content directly from the URL (don't use file handler for content)
            const response = await axios.get(cloudUrl, {
                responseType: 'text',
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 400
            });

            if (response.status !== 200 || typeof response.data !== 'string') {
                throw new Error(`Failed to download file content: ${response.status}`);
            }

            const textContent = response.data;
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

