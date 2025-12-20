// sys_tool_slides_gemini.js
// Entity tool that creates slides, infographics, and presentations using Gemini 3 Pro image generation
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
        icon: "📊",
        function: {
            name: "GenerateSlides",
            description: "Use when asked to create, generate, or design slides, infographics, presentations, or visual content optimized for presentations. This tool is specifically designed for creating presentation-ready visuals including slide layouts, infographic designs, charts, diagrams, and other visual content that would be used in presentations. It uses Gemini 3 Pro image generation which excels at creating structured, professional presentation content. After you have generated the content, you must include it in your response to show it to the user.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing the slide, infographic, or presentation content you want to create. Be specific about the layout, design style, content structure, color scheme, typography preferences, and any specific elements you want included (e.g., 'Create a professional slide with a title at the top, three bullet points in the middle, and a chart on the right side. Use a blue and white color scheme with modern sans-serif fonts.'). For infographics, specify the data visualization needs, layout structure, and visual hierarchy. The more detailed and descriptive the prompt, the better the result."
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
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    }],
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            let model = "gemini-pro-3-image";
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
                    const resolved = await resolveFileParameter(imageRef, args.contextId, args.contextKey, { preferGcs: true });
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Use ListFileCollection or SearchFileCollection to find available files.`);
                    }
                    resolvedInputImages.push(resolved);
                }
            }
            
            // Call the image generation pathway using Gemini 3
            let result = await callPathway('image_gemini_3', {
                ...args, 
                text: prompt,
                model, 
                stream: false,
                input_image: resolvedInputImages.length > 0 ? resolvedInputImages[0] : undefined,
                input_image_2: resolvedInputImages.length > 1 ? resolvedInputImages[1] : undefined,
                input_image_3: resolvedInputImages.length > 2 ? resolvedInputImages[2] : undefined,
                optimizePrompt: true,
            }, pathwayResolver);

            pathwayResolver.tool = JSON.stringify({ toolUsed: "slides" });

            if (pathwayResolver.pathwayResultData) {
                if (pathwayResolver.pathwayResultData.artifacts && Array.isArray(pathwayResolver.pathwayResultData.artifacts)) {
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
                                        
                                        // Determine filename prefix
                                        const defaultPrefix = 'presentation-slide';
                                        const filenamePrefix = args.filenamePrefix || defaultPrefix;
                                        
                                        // Sanitize the prefix to ensure it's a valid filename component
                                        const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                                        const filename = `${sanitizedPrefix}-${uniqueId}.${extension}`;
                                        
                                        // Merge provided tags with default tags
                                        const defaultTags = ['presentation', 'generated'];
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
                                            `Generated presentation content from prompt: ${args.detailedInstructions || 'presentation generation'}`,
                                            imageHash,
                                            null,
                                            pathwayResolver,
                                            true // permanent => retention=permanent
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
                result = result + '\n' + 'No presentation content generated';
            }

            return result;

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};

