// sys_tool_readfile.js
// Tool pathway that reads text files with line number support
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { resolveFileParameter, getMimeTypeFromFilename, isTextMimeType } from '../../../../lib/fileUtils.js';

// Code/text file extensions that mime-types doesn't recognize or misidentifies
// The mime-types library lacks coverage for many programming languages
// See: https://github.com/jshttp/mime-types (uses mime-db which is IANA-focused)
//
// We only list extensions where mime.lookup() returns false or a wrong type
// (e.g., .ts -> video/mp2t instead of TypeScript)
const KNOWN_TEXT_EXTENSIONS = new Set([
    // TypeScript (mime-types returns video/mp2t for .ts!)
    'ts', 'tsx', 'mts', 'cts',
    // Languages not in mime-db
    'py', 'pyw', 'pyi',         // Python
    'go',                        // Go  
    'rs',                        // Rust
    'rb', 'rake', 'gemspec',     // Ruby
    'swift',                     // Swift
    'kt', 'kts',                 // Kotlin
    'scala', 'sbt',              // Scala
    'clj', 'cljs', 'cljc', 'edn',// Clojure
    'elm',                       // Elm
    'ex', 'exs',                 // Elixir
    'erl', 'hrl',                // Erlang
    'hs', 'lhs',                 // Haskell
    'ml', 'mli',                 // OCaml
    'fs', 'fsi', 'fsx',          // F#
    'r', 'rmd',                  // R
    'jl',                        // Julia
    'nim',                       // Nim
    'zig',                       // Zig
    'v',                         // V
    'cr',                        // Crystal
    // Modern web frameworks
    'vue', 'svelte', 'astro',
    // Shell variants (only bash/zsh/fish not recognized)
    'bash', 'zsh', 'fish',
    // Config files (dotfiles without extension)
    'env', 'envrc', 'editorconfig', 'gitignore', 'dockerignore',
    // Data/config formats not in mime-db
    'prisma', 'graphql', 'gql',
    'tf', 'tfvars', 'hcl',       // Terraform
    'proto',                     // Protocol Buffers
    'diff', 'patch',
]);

/**
 * Check if a file is a text file type that can be read
 * Uses MIME type detection via the mime-types library, with fallback for
 * common code file extensions that the library doesn't recognize
 * @param {string} url - File URL or path
 * @returns {boolean} - Returns true if it's a text file, false otherwise
 */
function isTextFile(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    // Extract filename from URL (remove query string and fragment)
    const urlPath = url.split('?')[0].split('#')[0];
    const extension = urlPath.split('.').pop()?.toLowerCase();
    
    // Use MIME library to get MIME type from filename/extension
    const mimeType = getMimeTypeFromFilename(urlPath);
    
    // If MIME library returns a valid type, check it (but watch for misidentifications)
    if (mimeType && mimeType !== 'application/octet-stream') {
        // Handle known misidentifications from mime-types library
        // .ts -> video/mp2t (wrong, it's TypeScript)
        // .rs -> application/rls-services+xml (wrong, it's Rust)
        if (extension && KNOWN_TEXT_EXTENSIONS.has(extension)) {
            return true; // Trust our extension list over wrong MIME type
        }
        return isTextMimeType(mimeType);
    }
    
    // Fallback: Check our list of known text/code extensions
    // This handles cases where the MIME library doesn't recognize the extension
    if (extension && KNOWN_TEXT_EXTENSIONS.has(extension)) {
        return true;
    }
    
    // For truly unknown extensions, we can't reliably determine if it's text
    return false;
}

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: { 
        type: "function",
        icon: "📖",
        function: {
            name: "ReadTextFile",
            description: "Read text content from a text type file. Can read the file using line ranges (for line-based files) or character ranges (for files like JSON where line-based reading doesn't work well). Use this to access text files from your file collection. Supports text files, markdown files, html, csv, json, and other document formats that can be converted to text. DOES NOT support binary files, images, videos, or audio files or pdfs. Reading large files in chunks is recommended to avoid token limits. Use character ranges (startChar/endChar) for JSON and other structured formats. Use line ranges (startLine/endLine) for code and text files. If no range is specified, reads from the beginning with default limits.",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "The file to read: can be the file ID, filename, URL, or hash from your file collection. You can find available files in the Available Files section or ListFileCollection or SearchFileCollection."
                    },
                    startChar: {
                        type: "number",
                        description: "Optional: Starting character position (0-indexed). If provided, character-based reading is used instead of line-based. Use this for JSON and other structured formats. Must be >= 0."
                    },
                    endChar: {
                        type: "number",
                        description: "Optional: Ending character position (0-indexed, exclusive). If provided with startChar, character-based reading is used. Must be > startChar if startChar is provided. Maximum range is 100000 characters."
                    },
                    startLine: {
                        type: "number",
                        description: "Optional: Starting line number (1-indexed). If not provided, reads from the beginning. Ignored if startChar is provided."
                    },
                    endLine: {
                        type: "number",
                        description: "Optional: Ending line number (1-indexed). If not provided, reads to the end. Must be >= startLine if startLine is provided. Ignored if startChar is provided. Maximum range is 1000 lines."
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
            // Internal limits for safety
            const MAX_CHARS = 100000;
            const MAX_LINES = 1000;
            
            let { cloudUrl, file, startChar, endChar, startLine, endLine, contextId, contextKey } = args;
            
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
                // Use useCache: false to ensure we get the latest file data (important after edits)
                const resolvedUrl = await resolveFileParameter(file, contextId, contextKey, { useCache: false });
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

            // Check if file is a text type before attempting to read
            if (!isTextFile(cloudUrl)) {
                const mimeType = getMimeTypeFromFilename(cloudUrl.split('?')[0].split('#')[0]);
                const detectedType = mimeType || 'unknown type';
                
                const errorResult = {
                    success: false,
                    error: `This tool only supports text files. The file appears to be a non-text file (MIME type: ${detectedType}). For images, PDFs, videos, or other non-text files, please use the AnalyzeImage, AnalyzePDF, or AnalyzeVideo tools instead.`
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            // Validate character-based parameters
            if (startChar !== undefined) {
                if (typeof startChar !== 'number' || !Number.isInteger(startChar) || startChar < 0) {
                    const errorResult = {
                        success: false,
                        error: "startChar must be a non-negative integer (0-indexed)"
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
            }

            if (endChar !== undefined) {
                if (typeof endChar !== 'number' || !Number.isInteger(endChar) || endChar < 0) {
                    const errorResult = {
                        success: false,
                        error: "endChar must be a non-negative integer (0-indexed)"
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
            }

            if (startChar !== undefined && endChar !== undefined && endChar <= startChar) {
                const errorResult = {
                    success: false,
                    error: "endChar must be > startChar"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            // Check if character range exceeds limit (only if both start and end are specified)
            if (startChar !== undefined && endChar !== undefined) {
                const rangeSize = endChar - startChar;
                if (rangeSize > MAX_CHARS) {
                    const errorResult = {
                        success: false,
                        error: `Requested character range (${rangeSize} characters) exceeds maximum allowed range of ${MAX_CHARS} characters. Please request a smaller range.`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
            }

            // Validate line-based parameters (only if not using character mode)
            if (startChar === undefined && startLine !== undefined) {
                if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
                    const errorResult = {
                        success: false,
                        error: "startLine must be a positive integer (1-indexed)"
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
            }

            if (startChar === undefined && endLine !== undefined) {
                if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
                    const errorResult = {
                        success: false,
                        error: "endLine must be a positive integer (1-indexed)"
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }
            }

            if (startChar === undefined && startLine !== undefined && endLine !== undefined && endLine < startLine) {
                const errorResult = {
                    success: false,
                    error: "endLine must be >= startLine"
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            // Check if line range exceeds limit
            if (startChar === undefined && startLine !== undefined && endLine !== undefined) {
                const rangeSize = endLine - startLine + 1; // +1 because endLine is inclusive
                if (rangeSize > MAX_LINES) {
                    const errorResult = {
                        success: false,
                        error: `Requested line range (${rangeSize} lines) exceeds maximum allowed range of ${MAX_LINES} lines. Please request a smaller range.`
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

            // Secondary check: verify content-type header if available
            const contentType = response.headers['content-type'] || response.headers['Content-Type'];
            if (contentType && !isTextMimeType(contentType)) {
                const errorResult = {
                    success: false,
                    error: `This tool only supports text files. The file appears to be a non-text file (Content-Type: ${contentType}). For images, PDFs, videos, or other non-text files, please use the AnalyzeImage, AnalyzePDF, or AnalyzeVideo tools instead.`
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(errorResult);
            }

            // Explicitly decode as UTF-8 to prevent mojibake (encoding corruption)
            const textContent = Buffer.from(response.data).toString('utf8');
            const totalChars = textContent.length;
            const totalBytes = response.data.length;
            const allLines = textContent.split(/\r?\n/);
            const totalLines = allLines.length;

            // Handle empty file
            if (totalChars === 0) {
                const result = {
                    success: true,
                    cloudUrl: cloudUrl,
                    totalChars: 0,
                    totalBytes: totalBytes,
                    totalLines: 0,
                    returnedChars: 0,
                    returnedLines: 0,
                    content: '',
                    truncated: false,
                    isEmpty: true,
                    mode: 'character'
                };
                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(result);
            }

            // Character-based reading mode (takes precedence)
            if (startChar !== undefined) {
                // Check for out-of-bounds before clamping
                if (startChar > totalChars) {
                    const errorResult = {
                        success: false,
                        error: `startChar (${startChar}) exceeds file length (${totalChars} characters)`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }

                let start = Math.max(0, Math.min(startChar, totalChars));
                let end = endChar !== undefined 
                    ? Math.min(totalChars, Math.max(start + 1, endChar))
                    : Math.min(totalChars, start + MAX_CHARS); // Default limit if endChar not specified

                let selectedContent = textContent.substring(start, end);
                let wasTruncatedByRange = (endChar !== undefined && endChar < totalChars) || (startChar > 0);
                let wasTruncatedByLimit = (endChar === undefined && end < totalChars);
                const isTruncated = wasTruncatedByRange || wasTruncatedByLimit;

                let instruction = '';
                if (isTruncated) {
                    instruction = `⚠️ IMPORTANT: This is NOT the complete file. You are viewing characters ${start} to ${end} of ${totalChars} total characters (${selectedContent.length} characters shown). The file has ${totalChars} total characters. To read more, call ReadTextFile again with startChar=${end} (and optionally endChar=${Math.min(end + MAX_CHARS, totalChars)}) to read the next chunk. To avoid context overflow and data loss, make sure you're done processing your current chunk before you read the next one.`;
                }

                const result = {
                    success: true,
                    cloudUrl: cloudUrl,
                    totalChars: totalChars,
                    totalBytes: totalBytes,
                    totalLines: totalLines,
                    returnedChars: selectedContent.length,
                    startChar: start,
                    endChar: end,
                    content: selectedContent,
                    truncated: isTruncated,
                    truncatedByRange: wasTruncatedByRange,
                    truncatedByLimit: wasTruncatedByLimit,
                    mode: 'character',
                    ...(instruction ? { instruction } : {})
                };

                resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                return JSON.stringify(result);
            }

            // Line-based reading mode (default)
            let selectedLines = allLines;
            let actualStartLine = 1;
            let actualEndLine = totalLines;
            let wasTruncatedByRange = false;
            let wasTruncatedByLimit = false;

            if (startLine !== undefined || endLine !== undefined) {
                const start = startLine !== undefined ? Math.max(1, Math.min(startLine, totalLines)) - 1 : 0; // Convert to 0-indexed, clamp to valid range
                let end = endLine !== undefined ? Math.min(totalLines, Math.max(1, endLine)) : Math.min(totalLines, start + MAX_LINES); // Default limit if endLine not specified
                
                if (startLine !== undefined && startLine > totalLines) {
                    const errorResult = {
                        success: false,
                        error: `startLine (${startLine}) exceeds file length (${totalLines} lines)`
                    };
                    resolver.tool = JSON.stringify({ toolUsed: "ReadFile" });
                    return JSON.stringify(errorResult);
                }

                // If endLine not specified, apply default limit
                if (endLine === undefined && (end - start) > MAX_LINES) {
                    end = start + MAX_LINES;
                    wasTruncatedByLimit = true;
                }

                selectedLines = allLines.slice(start, end);
                actualStartLine = start + 1; // Convert back to 1-indexed
                actualEndLine = end;
                wasTruncatedByRange = (endLine !== undefined && endLine < totalLines) || (startLine !== undefined && startLine > 1);
            } else {
                // No range specified - apply default limit from beginning
                if (selectedLines.length > MAX_LINES) {
                    selectedLines = selectedLines.slice(0, MAX_LINES);
                    actualEndLine = MAX_LINES;
                    wasTruncatedByLimit = true;
                }
            }

            const selectedContent = selectedLines.join('\n');
            const isTruncated = wasTruncatedByRange || wasTruncatedByLimit;

            let instruction = '';
            if (isTruncated) {
                instruction = `⚠️ IMPORTANT: This is NOT the complete file. You are viewing lines ${actualStartLine} to ${actualEndLine} of ${totalLines} total lines (${selectedLines.length} lines shown). The file has ${totalLines} total lines and ${totalChars} total characters. To read more, call ReadTextFile again with startLine=${actualEndLine + 1} (and optionally endLine=${Math.min(actualEndLine + MAX_LINES, totalLines)}) to read the next chunk. To avoid context overflow and data loss, make sure you're done processing your current chunk before you read the next one.`;
            }

            const result = {
                success: true,
                cloudUrl: cloudUrl,
                totalChars: totalChars,
                totalBytes: totalBytes,
                totalLines: totalLines,
                returnedChars: selectedContent.length,
                returnedLines: selectedLines.length,
                startLine: actualStartLine,
                endLine: actualEndLine,
                content: selectedContent,
                truncated: isTruncated,
                truncatedByRange: wasTruncatedByRange,
                truncatedByLimit: wasTruncatedByLimit,
                mode: 'line',
                ...(instruction ? { instruction } : {})
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

