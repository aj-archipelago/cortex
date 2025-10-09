// sys_tool_image_gemini.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadImageToCloud } from '../../../../lib/util.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
    },
    timeout: 300,
    /*
    toolDefinition: [{
        type: "function",
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
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["detailedInstructions", "renderText", "userMessage"]
            }
        }
    },
    {
        type: "function",
        icon: "🔄",
        function: {
            name: "ModifyImage",
            description: "Use when asked to modify, transform, or edit an existing image. This tool can apply various transformations like style changes, artistic effects, or specific modifications to an image that has been previously uploaded or generated. It takes up to two input images as a reference and outputs a new image based on the instructions.",
            parameters: {
                type: "object",
                properties: {
                    inputImage: {
                        type: "string",
                        description: "The first image URL copied exactly from an image_url field in your chat context."
                    },
                    inputImage2: {
                        type: "string",
                        description: "The second input image URL copied exactly from an image_url field in your chat context if there is one."
                    },
                    inputImage3: {
                        type: "string",
                        description: "The third input image URL copied exactly from an image_url field in your chat context if there is one."
                    },
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing how you want to modify the image. Be specific about the changes you want to make, including style changes, artistic effects, or specific modifications. The more detailed and descriptive the prompt, the better the result."
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
    */
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            let model = "gemini-25-flash-image";
            let prompt = args.detailedInstructions || "";
            
            // Call the image generation pathway
            let result = await callPathway('image_gemini_25', {
                ...args, 
                text: prompt,
                model, 
                stream: false,
                input_image: args.inputImage,
                input_image_2: args.inputImage2,
                input_image_3: args.inputImage3,
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
                                // Upload image to cloud storage
                                const imageUrl = await uploadImageToCloud(artifact.data, artifact.mimeType, pathwayResolver);
                                uploadedImages.push({
                                    type: 'image',
                                    url: imageUrl,
                                    mimeType: artifact.mimeType
                                });
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
                    result = result + '\n' + uploadedImages.map(image => image.url).join('\n');
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