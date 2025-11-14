// sys_tool_image_gemini.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadImageToCloud, addFileToCollection, resolveFileParameter } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
        contextId: '',
        contextKey: '',
    },
    timeout: 300,
    toolDefinition: [{
        type: "function",
        enabled: true,
        icon: "🎨",
        function: {
            name: "GenerateImage",
            description: "Use when asked to create, generate, or generate revisions of visual content. Any time the user asks you for a picture, a selfie, artwork, a drawing or if you want to illustrate something for the user, you can use this tool to generate any sort of image from cartoon to photo realistic. After you have generated the image, you must include the image in your response to show it to the user.",
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
        enabled: false,
        icon: "🔄",
        function: {
            name: "ModifyImage",
            description: "Use when asked to modify, transform, or edit an existing image. This tool can apply various transformations like style changes, artistic effects, or specific modifications to an image that has been previously uploaded or generated. It takes up to two input images as a reference and outputs a new image based on the instructions.",
            parameters: {
                type: "object",
                properties: {
                    inputImage: {
                        type: "string",
                        description: "An image from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to use as a reference for the image modification."
                    },
                    inputImage2: {
                        type: "string",
                        description: "A second image from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to use as a reference for the image modification if there is one."
                    },
                    inputImage3: {
                        type: "string",
                        description: "A third image from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to use as a reference for the image modification if there is one."
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
                required: ["inputImage", "detailedInstructions", "userMessage"]
            }
        }
    }],
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            let model = "gemini-25-flash-image";
            let prompt = args.detailedInstructions || "";
            
            // Resolve input images to URLs using the common utility
            // For Gemini, prefer GCS URLs over Azure URLs
            // Fail early if any provided image parameter cannot be resolved
            if (args.inputImage) {
                if (!args.contextId) {
                    throw new Error("contextId is required when using the 'inputImage' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                const resolved = await resolveFileParameter(args.inputImage, args.contextId, args.contextKey, { preferGcs: true });
                if (!resolved) {
                    throw new Error(`File not found: "${args.inputImage}". Use ListFileCollection or SearchFileCollection to find available files.`);
                }
                args.inputImage = resolved;
            }
            
            if (args.inputImage2) {
                if (!args.contextId) {
                    throw new Error("contextId is required when using the 'inputImage2' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                const resolved = await resolveFileParameter(args.inputImage2, args.contextId, args.contextKey, { preferGcs: true });
                if (!resolved) {
                    throw new Error(`File not found: "${args.inputImage2}". Use ListFileCollection or SearchFileCollection to find available files.`);
                }
                args.inputImage2 = resolved;
            }
            
            if (args.inputImage3) {
                if (!args.contextId) {
                    throw new Error("contextId is required when using the 'inputImage3' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                const resolved = await resolveFileParameter(args.inputImage3, args.contextId, args.contextKey, { preferGcs: true });
                if (!resolved) {
                    throw new Error(`File not found: "${args.inputImage3}". Use ListFileCollection or SearchFileCollection to find available files.`);
                }
                args.inputImage3 = resolved;
            }
            
            const resolvedInputImage = args.inputImage;
            const resolvedInputImage2 = args.inputImage2;
            const resolvedInputImage3 = args.inputImage3;
            
            // Call the image generation pathway
            let result = await callPathway('image_gemini_25', {
                ...args, 
                text: prompt,
                model, 
                stream: false,
                input_image: resolvedInputImage,
                input_image_2: resolvedInputImage2,
                input_image_3: resolvedInputImage3,
                optimizePrompt: true,
            }, pathwayResolver);

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });

            if (pathwayResolver.pathwayResultData) {
                if (pathwayResolver.pathwayResultData.artifacts && Array.isArray(pathwayResolver.pathwayResultData.artifacts)) {
                    const uploadedImages = [];
                    
                    // Process each image artifact
                    for (const artifact of pathwayResolver.pathwayResultData.artifacts) {
                        if (artifact.type === 'image' && artifact.data && artifact.mimeType) {
                            try {
                                // Upload image to cloud storage (returns {url, gcs, hash})
                                const uploadResult = await uploadImageToCloud(artifact.data, artifact.mimeType, pathwayResolver);
                                
                                const imageUrl = uploadResult.url || uploadResult;
                                const imageGcs = uploadResult.gcs || null;
                                const imageHash = uploadResult.hash || null;
                                
                                uploadedImages.push({
                                    type: 'image',
                                    url: imageUrl,
                                    gcs: imageGcs,
                                    hash: imageHash,
                                    mimeType: artifact.mimeType
                                });
                                
                                // Add uploaded image to file collection if contextId is available
                                if (args.contextId && imageUrl) {
                                    try {
                                        // Generate filename from mimeType (e.g., "image/png" -> "png")
                                        const extension = artifact.mimeType.split('/')[1] || 'png';
                                        // Use hash for uniqueness if available, otherwise use timestamp and index
                                        const uniqueId = imageHash ? imageHash.substring(0, 8) : `${Date.now()}-${uploadedImages.length}`;
                                        
                                        // Determine filename prefix based on whether this is a modification or generation
                                        // If inputImage exists, it's a modification; otherwise it's a generation
                                        const isModification = args.inputImage || args.inputImage2 || args.inputImage3;
                                        const defaultPrefix = isModification ? 'modified-image' : 'generated-image';
                                        const filenamePrefix = args.filenamePrefix || defaultPrefix;
                                        
                                        // Sanitize the prefix to ensure it's a valid filename component
                                        const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                                        const filename = `${sanitizedPrefix}-${uniqueId}.${extension}`;
                                        
                                        // Merge provided tags with default tags
                                        const defaultTags = ['image', isModification ? 'modified' : 'generated'];
                                        const providedTags = Array.isArray(args.tags) ? args.tags : [];
                                        const allTags = [...defaultTags, ...providedTags.filter(tag => !defaultTags.includes(tag))];
                                        
                                        // Use the centralized utility function to add to collection
                                        await addFileToCollection(
                                            args.contextId,
                                            args.contextKey || '',
                                            imageUrl,
                                            imageGcs,
                                            filename,
                                            allTags,
                                            isModification 
                                                ? `Modified image from prompt: ${args.detailedInstructions || 'image modification'}`
                                                : `Generated image from prompt: ${args.detailedInstructions || 'image generation'}`,
                                            imageHash
                                        );
                                    } catch (collectionError) {
                                        // Log but don't fail - file collection is optional
                                        pathwayResolver.logWarning(`Failed to add image to file collection: ${collectionError.message}`);
                                    }
                                }
                            } catch (uploadError) {
                                pathwayResolver.logError(`Failed to upload artifact: ${uploadError.message}`);
                                // Keep original artifact as fallback
                                uploadedImages.push(artifact);
                            }
                        } else {
                            // Keep non-image artifacts as-is
                            uploadedImages.push(artifact);
                        }
                    }
                    
                    // Return the urls of the uploaded images as text in the result
                    result = result ? result + '\n' + uploadedImages.map(image => image.url || image).join('\n') : uploadedImages.map(image => image.url || image).join('\n');
                }
            } else {
                // If result is not a CortexResponse, log a warning but return as-is
                pathwayResolver.logWarning('No artifacts to upload');
                result = result + '\n' + 'No images generated';
            }

            return result;

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};