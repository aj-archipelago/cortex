// sys_tool_writefile.js
// Entity tool that writes content to a file and uploads it to cloud storage
import logger from '../../../../lib/logger.js';
import { uploadFileToCloud, addFileToCollection, getMimeTypeFromFilename } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: { 
        type: "function",
        icon: "✍️",
        function: {
            name: "WriteFile",
            description: "Write content to a file and upload it to cloud storage. The file will be added to your file collection for future reference. Use this to save text, code, data, or any content you generate to a file.",
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "The content to write to the file"
                    },
                    filename: {
                        type: "string",
                        description: "The filename for the file (e.g., 'output.txt', 'data.json', 'script.py'). Include the file extension."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the file (e.g., ['code', 'output', 'data'])"
                    },
                    notes: {
                        type: "string",
                        description: "Optional: Notes or description about the file"
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["content", "filename", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { content, filename, tags = [], notes = '', contextId, contextKey } = args;
        
        // Validate inputs and return JSON error if invalid
        if (!content || typeof content !== 'string') {
            const errorResult = {
                success: false,
                filename: filename || 'unknown',
                error: "content is required and must be a string"
            };
            resolver.tool = JSON.stringify({ toolUsed: "WriteFile" });
            return JSON.stringify(errorResult);
        }

        if (!filename || typeof filename !== 'string') {
            const errorResult = {
                success: false,
                filename: 'unknown',
                error: "filename is required and must be a string"
            };
            resolver.tool = JSON.stringify({ toolUsed: "WriteFile" });
            return JSON.stringify(errorResult);
        }

        try {
            // Convert content to buffer
            const fileBuffer = Buffer.from(content, 'utf8');
            logger.info(`Prepared content buffer for file: ${filename} (${fileBuffer.length} bytes)`);

            // Determine MIME type from filename using utility function
            let mimeType = getMimeTypeFromFilename(filename, 'text/plain');
            
            // Add charset=utf-8 for text-based MIME types to ensure proper encoding
            if (mimeType.startsWith('text/') || mimeType === 'application/json' || 
                mimeType === 'application/javascript' || mimeType === 'application/typescript' ||
                mimeType === 'application/xml') {
                mimeType = `${mimeType}; charset=utf-8`;
            }

            // Upload file to cloud storage (this will compute hash and check for duplicates)
            const uploadResult = await uploadFileToCloud(
                fileBuffer,
                mimeType,
                filename,
                resolver
            );

            if (!uploadResult || !uploadResult.url) {
                throw new Error('Failed to upload file to cloud storage');
            }

            // Add to file collection if contextId is provided
            let fileEntry = null;
            if (contextId) {
                try {
                    fileEntry = await addFileToCollection(
                        contextId,
                        contextKey || null,
                        uploadResult.url,
                        uploadResult.gcs || null,
                        filename,
                        tags,
                        notes,
                        uploadResult.hash || null,
                        null, // fileUrl - not needed since we already uploaded
                        resolver
                    );
                } catch (collectionError) {
                    // Log but don't fail - file collection is optional
                    logger.warn(`Failed to add file to collection: ${collectionError.message}`);
                }
            }

            const result = {
                success: true,
                filename: filename,
                url: uploadResult.url,
                gcs: uploadResult.gcs || null,
                hash: uploadResult.hash || null,
                fileId: fileEntry?.id || null,
                size: Buffer.byteLength(content, 'utf8'),
                message: `File "${filename}" written and uploaded successfully`
            };

            resolver.tool = JSON.stringify({ toolUsed: "WriteFile" });
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
            logger.error(`Error writing file ${filename}: ${errorMsg}`);
            
            const errorResult = {
                success: false,
                filename: filename,
                error: errorMsg
            };

            resolver.tool = JSON.stringify({ toolUsed: "WriteFile" });
            return JSON.stringify(errorResult);
        }
    }
};

