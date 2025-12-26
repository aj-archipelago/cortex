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
            description: "Use when asked to modify, transform, or edit an existing image. This tool can apply various transformations like style changes, artistic effects, or specific modifications to an image that has been previously uploaded or generated. It takes up to three input images as a reference and outputs a new image based on the instructions.",
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
            let model = "gemini-flash-25-image";
            let prompt = args.detailedInstructions || "";
            
            // Resolve input images to URLs using the common utility
            // For Gemini, prefer GCS URLs over Azure URLs
            // Fail early if any provided image cannot be resolved
            const resolvedInputImages = [];
            if (args.inputImages && Array.isArray(args.inputImages)) {
                if (!args.contextId) {
                    throw new Error("contextId is required when using the 'inputImages' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                
                // Limit to 3 images maximum
                const imagesToProcess = args.inputImages.slice(0, 3);
                
                for (let i = 0; i < imagesToProcess.length; i++) {
                    const imageRef = imagesToProcess[i];
                    const resolved = await resolveFileParameter(imageRef, args.contextId, args.contextKey, { preferGcs: true, altContextId: args.altContextId });
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Use ListFileCollection or SearchFileCollection to find available files.`);
                    }
                    resolvedInputImages.push(resolved);
                }
            }
            
            // Call the image generation pathway
            let result = await callPathway('image_gemini_25', {
                ...args, 
                text: prompt,
                model, 
                stream: false,
                input_image: resolvedInputImages.length > 0 ? resolvedInputImages[0] : undefined,
                input_image_2: resolvedInputImages.length > 1 ? resolvedInputImages[1] : undefined,
                input_image_3: resolvedInputImages.length > 2 ? resolvedInputImages[2] : undefined,
                optimizePrompt: true,
            }, pathwayResolver);

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });

            // Check for artifacts first - image generation may return empty text but still have image artifacts
            // The artifacts in pathwayResultData are the actual generated images
            const hasArtifacts = pathwayResolver.pathwayResultData?.artifacts && 
                                 Array.isArray(pathwayResolver.pathwayResultData.artifacts) && 
                                 pathwayResolver.pathwayResultData.artifacts.length > 0;

            // If no result AND no artifacts, then generation truly failed
            if (!hasArtifacts && (result === null || result === undefined || result === '')) {
                throw new Error('Image generation failed: No response from image generation API. Try a different prompt.');
            }

            // Process artifacts if we have them
            if (hasArtifacts) {
                const uploadedImages = [];
                
                // Process each image artifact
                for (const artifact of pathwayResolver.pathwayResultData.artifacts) {
                    if (artifact.type === 'image' && artifact.data && artifact.mimeType) {
                        try {
                            // Upload image to cloud storage (returns {url, gcs, hash})
                            const uploadResult = await uploadImageToCloud(artifact.data, artifact.mimeType, pathwayResolver, args.contextId);
                            
                            const imageUrl = uploadResult.url || uploadResult;
                            const imageGcs = uploadResult.gcs || null;
                            const imageHash = uploadResult.hash || null;
                            
                            // Prepare image data
                            const imageData = {
                                type: 'image',
                                url: imageUrl,
                                gcs: imageGcs,
                                hash: imageHash,
                                mimeType: artifact.mimeType
                            };
                            
                            // Add uploaded image to file collection if contextId is available
                            if (args.contextId && imageUrl) {
                                try {
                                    // Generate filename from mimeType (e.g., "image/png" -> "png")
                                    const extension = artifact.mimeType.split('/')[1] || 'png';
                                    // Use hash for uniqueness if available, otherwise use timestamp and index
                                    const uniqueId = imageHash ? imageHash.substring(0, 8) : `${Date.now()}-${uploadedImages.length}`;
                                    
                                    // Determine filename prefix based on whether this is a modification or generation
                                    // If inputImages exists, it's a modification; otherwise it's a generation
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
                                        imageUrl,
                                        imageGcs,
                                        filename,
                                        allTags,
                                        isModification 
                                            ? `Modified image from prompt: ${args.detailedInstructions || 'image modification'}`
                                            : `Generated image from prompt: ${args.detailedInstructions || 'image generation'}`,
                                        imageHash,
                                        null,
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
                            pathwayResolver.logError(`Failed to upload artifact: ${uploadError.message}`);
                            // Keep original artifact as fallback
                            uploadedImages.push(artifact);
                        }
                    } else {
                        // Keep non-image artifacts as-is
                        uploadedImages.push(artifact);
                    }
                }
                
                // Check if we successfully uploaded any images
                const successfulImages = uploadedImages.filter(img => img.url);
                if (successfulImages.length > 0) {
                    // Return image info in the same format as availableFiles
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
                    return `Image generation successful. Generated ${count} image${count > 1 ? 's' : ''}:\n${imageList}`;
                } else {
                    throw new Error('Image generation failed: Images were generated but could not be uploaded to storage');
                }
            } else {
                // No artifacts were generated - this likely means the image was blocked by safety filters
                // or there was another issue with generation
                throw new Error('Image generation failed: No images were generated. This may be due to content safety filters blocking the request. Try using a different, less detailed prompt or avoiding photorealistic depictions of people/faces.');
            }

        } catch (e) {
            // Return a structured error that the agent can understand and act upon
            // Do NOT call sys_generator_error - let the agent see the actual error
            const errorMessage = e.message ?? String(e);
            pathwayResolver.logError(errorMessage);
            
            // Check for specific error types and provide actionable guidance
            let guidance = '';
            if (errorMessage.includes('IMAGE_SAFETY') || errorMessage.includes('safety')) {
                guidance = ' Try a different approach: use stylized/artistic depictions instead of photorealistic, avoid human faces, or simplify the prompt.';
            } else if (errorMessage.includes('RECITATION')) {
                guidance = ' The request may be too similar to copyrighted content. Try making the prompt more original.';
            } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
                guidance = ' The request timed out. Try a simpler prompt or try again.';
            }
            
            return JSON.stringify({
                error: true,
                message: `Image generation failed: ${errorMessage}${guidance}`,
                toolName: 'GenerateImage'
            });
        }
    }
};