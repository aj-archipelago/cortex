// sys_tool_slides_gemini.js
// Entity tool that creates slides, infographics, and presentations using Gemini 3 Pro image generation
import { callPathway } from '../../../../lib/pathwayTools.js';
import {
    uploadImageToCloud,
    addFileToCollection,
    resolveFileParameter,
    buildFileCreationResponse,
    buildFileLocation,
    promptToFilename,
    getWriteFileAccessTarget,
} from '../../../../lib/fileUtils.js';

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
        icon: "📊",
        function: {
            name: "GenerateSlides",
            description: "Use when asked to create, generate, or design slides, infographics, presentations, or visual content optimized for presentations. This tool is specifically designed for creating presentation-ready visuals including slide layouts, infographic designs, charts, diagrams, and other visual content that would be used in presentations. It uses Gemini 3 Pro image generation which excels at creating structured, professional presentation content. After you have generated the content, you must include it in your response to show it to the user.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed, SELF-CONTAINED prompt describing the slide content. CRITICAL: The image generation model has NO access to conversation history, uploaded files, or prior tool results. You MUST embed ALL data, text, numbers, labels, and values directly in these instructions. For charts or data visualizations, list EVERY data point explicitly (e.g., 'Bar chart showing: omd.com: 16, novartis.com: 12, mindshareworld.com: 11, ...'). Never refer to 'the data above' or 'the attached file' — the model cannot see them. Also specify layout, design style, color scheme, and typography (e.g., 'Professional slide with a horizontal bar chart, blue and white color scheme, modern sans-serif fonts, title at top.'). The more complete and self-contained the prompt, the better the result."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A descriptive prefix to use for the generated image filename (e.g., 'slide', 'infographic', 'presentation', 'chart'). If not provided, defaults to 'presentation-slide'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the content (e.g., ['slide', 'infographic', 'presentation', 'chart']). Will be merged with default tags ['presentation', 'generated']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    },
                    inputImages: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of file references (hashes, filenames, URLs, or workspace paths like /workspace/files/...) from the file collection to use as reference images for the slide design. These images will be used as style references or incorporated into the slide. Maximum 3 images."
                    },
                    aspectRatio: {
                        type: "string",
                        enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
                        description: "Optional: The aspect ratio for the generated slide. Options: '1:1' (Square), '16:9' (Widescreen, default), '9:16' (Vertical/Portrait), '4:3' (Standard), '3:4' (Vertical/Portrait). Defaults to '16:9' if not specified."
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    }],
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        const chatId = args.chatId || null;
        const fileAccessPlan = Array.isArray(args.fileAccessPlan) ? args.fileAccessPlan : [];
        const writeTarget = getWriteFileAccessTarget(fileAccessPlan);

        try {   
            let model = "gemini-pro-3-image";
            let prompt = args.detailedInstructions || "";
            
            // Resolve input images to URLs using the common utility
            // For Gemini, prefer GCS URLs over Azure URLs
            // Fail early if any provided image cannot be resolved
            const resolvedInputImages = [];
            if (args.inputImages && Array.isArray(args.inputImages)) {
                if (fileAccessPlan.length === 0) {
                    throw new Error("fileAccessPlan is required when using the 'inputImages' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                
                // Limit to 3 images maximum
                const imagesToProcess = args.inputImages.slice(0, 3);
                
                for (let i = 0; i < imagesToProcess.length; i++) {
                    const imageRef = imagesToProcess[i];
                    const resolved = await resolveFileParameter(imageRef, fileAccessPlan, { preferGcs: true });
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Use ListFileCollection or SearchFileCollection to find available files.`);
                    }
                    resolvedInputImages.push(resolved);
                }
            }
            
            // Call the image generation pathway using Gemini 3
            // Default aspectRatio to 16:9 if not provided
            const aspectRatio = args.aspectRatio || '16:9';
            
            let result = await callPathway('image_gemini_3', {
                ...args, 
                text: prompt,
                model, 
                stream: false,
                input_image: resolvedInputImages.length > 0 ? resolvedInputImages[0] : undefined,
                input_image_2: resolvedInputImages.length > 1 ? resolvedInputImages[1] : undefined,
                input_image_3: resolvedInputImages.length > 2 ? resolvedInputImages[2] : undefined,
                aspectRatio: aspectRatio,
                optimizePrompt: true,
            }, pathwayResolver);

            pathwayResolver.tool = JSON.stringify({ toolUsed: "slides" });

            // Check for artifacts first - image generation may return empty text but still have image artifacts
            // The artifacts in pathwayResultData are the actual generated images
            const hasArtifacts = pathwayResolver.pathwayResultData?.artifacts && 
                                 Array.isArray(pathwayResolver.pathwayResultData.artifacts) && 
                                 pathwayResolver.pathwayResultData.artifacts.length > 0;

            // If no result AND no artifacts, check for specific error types
            if (!hasArtifacts && (result === null || result === undefined || result === '')) {
                // Check pathwayResolver.errors for specific error information
                const errors = pathwayResolver.errors || [];
                const errorText = errors.join(' ').toLowerCase();
                
                if (errorText.includes('image_prohibited_content') || errorText.includes('prohibited_content')) {
                    throw new Error('Content was blocked by safety filters. Try simplifying the prompt, using abstract designs, or removing potentially sensitive elements.');
                } else if (errorText.includes('safety') || errorText.includes('blocked')) {
                    throw new Error('Content was blocked by safety filters. Try a different approach or simplify the content.');
                } else {
                    throw new Error('No presentation content was generated. This may be due to content safety filters or an API error. Try using a different prompt or simplifying the content.');
                }
            }

            // Process artifacts if we have them
            if (hasArtifacts) {
                const uploadedImages = [];
                
                // Process each image artifact
                for (const artifact of pathwayResolver.pathwayResultData.artifacts) {
                    if (artifact.type === 'image' && artifact.data && artifact.mimeType) {
                        try {
                            const extension = artifact.mimeType.split('/')[1] || 'png';
                            const uploadFilename = promptToFilename(prompt, extension, {
                                prefix: args.filenamePrefix || 'presentation-slide',
                                index: uploadedImages.length,
                            });

                            // Upload image to cloud storage (returns {url, gcs, hash})
                            const fileLocation = writeTarget
                                ? buildFileLocation(writeTarget.contextId, {
                                    userId: writeTarget.userContextId || null,
                                    chatId: writeTarget.chatId || null,
                                    workspaceId: writeTarget.workspaceId || null,
                                    appletId: writeTarget.appletId || null,
                                    fileScope: writeTarget.writeFileScope || null,
                                })
                                : null;
                            const uploadResult = await uploadImageToCloud(artifact.data, artifact.mimeType, pathwayResolver, fileLocation, uploadFilename);

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
                            if (writeTarget?.contextId && imageUrl) {
                                try {
                                    // Use the centralized utility function to add to collection - capture returned entry
                                    const fileEntry = await addFileToCollection(
                                        writeTarget.contextId,
                                        writeTarget.contextKey || '',
                                        imageUrl,
                                        uploadFilename,
                                        imageHash,
                                        null,
                                        pathwayResolver,
                                        writeTarget.chatId || null,
                                        {
                                            workspaceId: writeTarget.workspaceId || null,
                                            appletId: writeTarget.appletId || null,
                                            fileScope: writeTarget.writeFileScope || null,
                                        }
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
                    return buildFileCreationResponse(successfulImages, {
                        mediaType: 'image',
                        action: 'Slide/infographic generation',
                    });
                } else {
                    throw new Error('Slide generation failed: Content was generated but could not be uploaded to storage');
                }
            } else {
                // No artifacts were generated - this likely means the content was blocked by safety filters
                // Check pathwayResolver.errors for specific error information
                const errors = pathwayResolver.errors || [];
                const errorText = errors.join(' ').toLowerCase();
                
                if (errorText.includes('image_prohibited_content') || errorText.includes('prohibited_content')) {
                    throw new Error('Content was blocked by safety filters. Try simplifying the prompt, using abstract designs, or removing potentially sensitive elements.');
                } else {
                    throw new Error('No presentation content was generated. This may be due to content safety filters blocking the request. Try using a different prompt or simplifying the content.');
                }
            }

        } catch (e) {
            // Return a structured error that the agent can understand and act upon
            // Do NOT call sys_generator_error - let the agent see the actual error
            let errorMessage = e.message ?? String(e);
            pathwayResolver.logError(errorMessage);
            
            // Remove any duplicate "Slide generation failed:" prefix if it exists
            if (errorMessage.startsWith('Slide generation failed: ')) {
                errorMessage = errorMessage.substring('Slide generation failed: '.length);
            }
            
            // Check for specific error types and provide actionable guidance
            let guidance = '';
            if (errorMessage.includes('safety filters') || errorMessage.includes('blocked by')) {
                // Already has guidance, don't add more
                guidance = '';
            } else if (errorMessage.includes('IMAGE_SAFETY') || errorMessage.includes('IMAGE_PROHIBITED')) {
                guidance = ' Try a different approach: simplify the content, use abstract designs, or remove any potentially sensitive elements.';
            } else if (errorMessage.includes('RECITATION')) {
                guidance = ' The request may be too similar to copyrighted content. Try making the design more original.';
            } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
                guidance = ' The request timed out. Try a simpler design or try again.';
            }
            
            return JSON.stringify({
                error: true,
                message: `Slide generation failed: ${errorMessage}${guidance}`,
                toolName: 'GenerateSlides'
            });
        }
    }
};
