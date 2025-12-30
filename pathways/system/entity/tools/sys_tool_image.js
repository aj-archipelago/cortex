// sys_tool_image.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadFileToCloud, addFileToCollection, resolveFileParameter } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
    },
    timeout: 300,
    toolDefinition: [{
        type: "function",
        enabled: false,
        icon: "🎨",
        function: {
            name: "GenerateImage",
            description: "Use when asked to create, generate, or generate revisions of visual content. Any time the user asks you for a picture, a selfie, artwork, a drawing or if you want to illustrate something for the user, you can use this tool to generate any sort of image from cartoon to photo realistic. This tool does not display the image to the user - you need to do that with markdown in your response.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing the image you want to create. You should be very specific - explaining subject matter, style, and details about the image including things like camera angle, lens types, lighting, photographic techniques, etc. Any details you can provide to the image creation engine will help it create the most accurate and useful images. The more detailed and descriptive the prompt, the better the result."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A descriptive prefix to use for the generated image filename (e.g., 'portrait', 'landscape', 'logo'). If not provided, defaults to 'generated-image'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the image (e.g., ['portrait', 'art', 'photography']). Will be merged with default tags ['image', 'generated']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    },
    {
        type: "function",
        icon: "🔄",
        function: {
            name: "ModifyImage",
            description: "Use when asked to modify, transform, or edit an existing image. This tool can apply various transformations like style changes, artistic effects, or specific modifications to an image that has been previously uploaded or generated. It takes up to three input images as a reference and outputs a new image based on the instructions. This tool does not display the image to the user - you need to do that with markdown in your response.",
            parameters: {
                type: "object",
                properties: {
                    inputImages: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "An array of images from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to use as references for the image modification. You can provide up to 3 images. Each image should be the hash or filename."
                    },
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing how you want to modify the image. Be specific about the changes you want to make, including style changes, artistic effects, or specific modifications. The more detailed and descriptive the prompt, the better the result."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A prefix to use for the modified image filename (e.g., 'edited', 'stylized', 'enhanced'). If not provided, defaults to 'modified-image'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the image (e.g., ['edited', 'art', 'stylized']). Will be merged with default tags ['image', 'modified']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["inputImages", "detailedInstructions", "userMessage"]
            }
        }
    }],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            let model = "replicate-seedream-4";
            let prompt = args.detailedInstructions || "";

            // If we have input images, use the qwen-image-edit-2511 model
            if (args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0) {
                model = "replicate-qwen-image-edit-2511";
            }

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });
            
            // Resolve all input images to URLs using the common utility
            // Fail early if any provided image cannot be resolved
            const resolvedInputImages = [];
            if (args.inputImages && Array.isArray(args.inputImages)) {
                if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                    throw new Error("agentContext is required when using the 'inputImages' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                
                // Limit to 3 images maximum
                const imagesToProcess = args.inputImages.slice(0, 3);
                
                for (let i = 0; i < imagesToProcess.length; i++) {
                    const imageRef = imagesToProcess[i];
                    const resolved = await resolveFileParameter(imageRef, args.agentContext);
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Use ListFileCollection or SearchFileCollection to find available files.`);
                    }
                    resolvedInputImages.push(resolved);
                }
            }
            
            // Build parameters object, only including image parameters if they have non-empty values
            const params = {
                ...args, 
                text: prompt, 
                model, 
                stream: false,
            };
            
            if (resolvedInputImages.length > 0) {
                params.input_image = resolvedInputImages[0];
            }
            if (resolvedInputImages.length > 1) {
                params.input_image_2 = resolvedInputImages[1];
            }
            if (resolvedInputImages.length > 2) {
                params.input_image_3 = resolvedInputImages[2];
            }

            // Set default aspectRatio for qwen-image-edit-2511 model
            if (model === "replicate-qwen-image-edit-2511") {
                params.aspectRatio = "match_input_image";
            }
            
            // Call appropriate pathway based on model
            const pathwayName = model.includes('seedream') ? 'image_seedream4' : 'image_qwen';
            let result = await callPathway(pathwayName, params, pathwayResolver);

            // Process artifacts from Replicate (which come as URLs, not base64 data)
            if (pathwayResolver.pathwayResultData) {
                if (pathwayResolver.pathwayResultData.artifacts && Array.isArray(pathwayResolver.pathwayResultData.artifacts)) {
                    const uploadedImages = [];
                    
                    // Process each image artifact
                    for (const artifact of pathwayResolver.pathwayResultData.artifacts) {
                        if (artifact.type === 'image' && artifact.url) {
                            try {
                                // Replicate artifacts have URLs, not base64 data
                                // Download the image and upload it to cloud storage
                                const imageUrl = artifact.url;
                                const mimeType = artifact.mimeType || 'image/png';
                                
                                // Upload image to cloud storage (downloads from URL, computes hash, uploads)
                                const uploadResult = await uploadFileToCloud(
                                    imageUrl,
                                    mimeType,
                                    null, // filename will be generated
                                    pathwayResolver,
                                    args.contextId
                                );
                                
                                const uploadedUrl = uploadResult.url || uploadResult;
                                const uploadedGcs = uploadResult.gcs || null;
                                const uploadedHash = uploadResult.hash || null;
                                
                                const imageData = {
                                    type: 'image',
                                    url: uploadedUrl,
                                    gcs: uploadedGcs,
                                    hash: uploadedHash,
                                    mimeType: mimeType
                                };
                                
                                // Add uploaded image to file collection if contextId is available
                                if (args.contextId && uploadedUrl) {
                                    try {
                                        // Generate filename from mimeType (e.g., "image/png" -> "png")
                                        const extension = mimeType.split('/')[1] || 'png';
                                        // Use hash for uniqueness if available, otherwise use timestamp and index
                                        const uniqueId = uploadedHash ? uploadedHash.substring(0, 8) : `${Date.now()}-${uploadedImages.length}`;
                                        
                                        // Determine filename prefix based on whether this is a modification or generation
                                        const isModification = args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0;
                                        const defaultPrefix = isModification ? 'modified-image' : 'generated-image';
                                        const filenamePrefix = args.filenamePrefix || defaultPrefix;
                                        
                                        // Sanitize the prefix to ensure it's a valid filename component
                                        const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                                        const filename = `${sanitizedPrefix}-${uniqueId}.${extension}`;
                                        
                                        // Merge provided tags with default tags
                                        const defaultTags = ['image', isModification ? 'modified' : 'generated'];
                                        const providedTags = Array.isArray(args.tags) ? args.tags : [];
                                        const allTags = [...defaultTags, ...providedTags.filter(tag => !defaultTags.includes(tag))];
                                        
                                        // Use the centralized utility function to add to collection - capture returned entry
                                        const fileEntry = await addFileToCollection(
                                            args.contextId,
                                            args.contextKey || '',
                                            uploadedUrl,
                                            uploadedGcs,
                                            filename,
                                            allTags,
                                            isModification 
                                                ? `Modified image from prompt: ${args.detailedInstructions || 'image modification'}`
                                                : `Generated image from prompt: ${args.detailedInstructions || 'image generation'}`,
                                            uploadedHash,
                                            null, // fileUrl - not needed since we already uploaded
                                            pathwayResolver,
                                            true // permanent => retention=permanent
                                        );
                                        
                                        // Use the file entry data for the return message
                                        imageData.fileEntry = fileEntry;
                                    } catch (collectionError) {
                                        // Log but don't fail - file collection is optional
                                        pathwayResolver.logWarning(`Failed to add image to file collection: ${collectionError.message}`);
                                    }
                                }
                                
                                uploadedImages.push(imageData);
                            } catch (uploadError) {
                                pathwayResolver.logError(`Failed to upload image from Replicate: ${uploadError.message}`);
                                // Keep original URL as fallback
                                uploadedImages.push({
                                    type: 'image',
                                    url: artifact.url,
                                    mimeType: artifact.mimeType || 'image/png'
                                });
                            }
                        } else {
                            // Keep non-image artifacts as-is
                            uploadedImages.push(artifact);
                        }
                    }
                    
                    // Return the URLs of the uploaded images in structured format
                    // Replace the result with uploaded cloud URLs (not the original Replicate URLs)
                    if (uploadedImages.length > 0) {
                        const successfulImages = uploadedImages.filter(img => img.url);
                        if (successfulImages.length > 0) {
                            // Build imageUrls array in the format expected by pathwayTools.js for toolImages injection
                            // This format matches ViewImages tool so images get properly injected into chat history
                            const imageUrls = successfulImages.map((img) => {
                                const url = img.fileEntry?.url || img.url;
                                const gcs = img.fileEntry?.gcs || img.gcs;
                                const hash = img.fileEntry?.hash || img.hash;
                                
                                return {
                                    type: "image_url",
                                    url: url,
                                    gcs: gcs || null,
                                    image_url: { url: url },
                                    hash: hash || null
                                };
                            });
                            
                            // Return image info in the same format as availableFiles for the text message
                            // Format: hash | filename | url | date | tags
                            const imageList = successfulImages.map((img) => {
                                if (img.fileEntry) {
                                    // Use the file entry data from addFileToCollection
                                    const fe = img.fileEntry;
                                    const dateStr = fe.addedDate 
                                        ? new Date(fe.addedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                        : '';
                                    const tagsStr = Array.isArray(fe.tags) ? fe.tags.join(',') : '';
                                    return `${fe.hash || ''} | ${fe.displayFilename || ''} | ${fe.url || img.url} | ${dateStr} | ${tagsStr}`;
                                } else {
                                    // Fallback if file collection wasn't available
                                    return `${img.hash || 'unknown'} | | ${img.url} | |`;
                                }
                            }).join('\n');
                            
                            const count = successfulImages.length;
                            const isModification = args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0;
                            
                            // Make the success message very explicit so the agent knows files were created and added to collection
                            // This format matches availableFiles so the agent can reference them by hash/filename
                            const action = isModification ? 'Image modification' : 'Image generation';
                            const message = `${action} completed successfully. ${count} image${count > 1 ? 's have' : ' has'} been generated, uploaded to cloud storage, and added to your file collection. The image${count > 1 ? 's are' : ' is'} now available in your file collection:\n\n${imageList}\n\nYou can reference these images by their hash, filename, or URL in future tool calls.`;
                            
                            // Return JSON object with imageUrls (kept for backward compatibility, but explicit message should prevent looping)
                            result = JSON.stringify({
                                success: true,
                                message: message,
                                imageUrls: imageUrls
                            });
                        }
                    }
                }
            }

            return result;

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};