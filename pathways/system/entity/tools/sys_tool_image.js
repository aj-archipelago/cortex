// sys_tool_image.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';

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
            description: "Use when asked to modify, transform, or edit an existing image. This tool can apply various transformations like style changes, artistic effects, or specific modifications to an image that has been previously uploaded or generated. It takes up to two input images as a reference and outputs a new image based on the instructions. This tool does not display the image to the user - you need to do that with markdown in your response.",
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

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            let model = "replicate-seedream-4";
            let prompt = args.detailedInstructions || "";

            // If we have an input image, use the flux-kontext-max model
            if (args.inputImage || args.inputImage2 || args.inputImage3) {
                model = "replicate-qwen-image-edit-plus";
            }

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });
            
            // Build parameters object, only including image parameters if they have non-empty values
            const params = {
                ...args, 
                text: prompt, 
                model, 
                stream: false,
            };
            
            if (args.inputImage && args.inputImage.trim()) {
                params.input_image = args.inputImage;
            }
            if (args.inputImage2 && args.inputImage2.trim()) {
                params.input_image_2 = args.inputImage2;
            }
            if (args.inputImage3 && args.inputImage3.trim()) {
                params.input_image_3 = args.inputImage3;
            }
            
            // Call appropriate pathway based on model
            const pathwayName = model.includes('seedream') ? 'image_seedream4' : 'image_qwen';
            return await callPathway(pathwayName, params);

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};