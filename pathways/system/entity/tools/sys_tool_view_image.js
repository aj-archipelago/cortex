// sys_tool_view_image.js
// Tool pathway that allows agents to view image files from the file collection
import logger from '../../../../lib/logger.js';
import { loadFileCollection, findFileInCollection, ensureShortLivedUrl } from '../../../../lib/fileUtils.js';
import { config } from '../../../../config.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: { 
        type: "function",
        icon: "👀",
        function: {
            name: "ViewImages",
            description: "View one or more image files from your file collection. This injects the images into the conversation so you can see them. Use this when you need to look at image files that are in your collection but not currently visible in the conversation.",
            parameters: {
                type: "object",
                properties: {
                    files: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Array of files to view (from ListFileCollection or SearchFileCollection): each can be the hash, the filename, the URL, or the GCS URL. You can find available files in the availableFiles section."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["files", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { files, contextId, contextKey } = args;

        if (!files || !Array.isArray(files) || files.length === 0) {
            throw new Error("Files parameter is required and must be a non-empty array");
        }

        try {
            // Load the file collection
            const collection = await loadFileCollection(contextId, contextKey, true);
            
            const imageUrls = [];
            const errors = [];
            const foundFilenames = [];

            // Process each file
            for (const file of files) {
                // Find the file in the collection
                const foundFile = findFileInCollection(file, collection);
                
                if (!foundFile) {
                    errors.push(`File not found: ${file}`);
                    continue;
                }

                // Check if it's an image by MIME type
                const mimeType = foundFile.mimeType || foundFile.contentType || '';
                const isImage = mimeType.startsWith('image/') || 
                              /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(foundFile.filename || '');

                if (!isImage) {
                    errors.push(`File "${foundFile.filename || file}" is not an image file (MIME type: ${mimeType || 'unknown'})`);
                    continue;
                }

                // Resolve to short-lived URL if possible
                const fileHandlerUrl = config.get('whisperMediaApiUrl');
                const fileWithShortLivedUrl = await ensureShortLivedUrl(foundFile, fileHandlerUrl, contextId);

                // Add to imageUrls array
                imageUrls.push({
                    type: "image_url",
                    url: fileWithShortLivedUrl.url,
                    gcs: fileWithShortLivedUrl.gcs,
                    image_url: { url: fileWithShortLivedUrl.url },
                    hash: fileWithShortLivedUrl.hash
                });

                foundFilenames.push(foundFile.filename || file);
            }

            // If no images were found, return error
            if (imageUrls.length === 0) {
                return JSON.stringify({
                    error: `No valid images found. ${errors.join('; ')}`
                });
            }

            // Return the file info in a format that can be extracted as toolImages
            // This will be picked up by pathwayTools.js and added to toolImages
            resolver.tool = JSON.stringify({ toolUsed: "ViewImages" });
            
            const message = imageUrls.length === 1 
                ? `Image "${foundFilenames[0]}" is now available for viewing.`
                : `${imageUrls.length} image(s) (${foundFilenames.join(', ')}) are now available for viewing.`;

            return JSON.stringify({
                success: true,
                message: message,
                imageUrls: imageUrls,
                errors: errors.length > 0 ? errors : undefined
            });
        } catch (e) {
            logger.error(`Error in ViewImages tool: ${e}`);
            throw e;
        }
    }
};

