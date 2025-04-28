// sys_tool_image.js
// Entity tool that creates images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
    },
    timeout: 300,
    toolDefinition: {
        type: "function",
        function: {
            name: "Image",
            description: "Use when asked to create, generate, or revise visual content. Any time the user asks you for a picture, a selfie, artwork, a drawing or if you want to illustrate something for the user, you can use this tool to generate any sort of image from cartoon to photo realistic.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing the image you want to create. You should be very specific - explaining subject matter, style, and details about the image including things like camera angle, lens types, lighting, photographic techniques, etc. Any details you can provide to the image creation engine will help it create the most accurate and useful images. The more detailed and descriptive the prompt, the better the result."
                    },
                    renderText: {
                        type: "boolean",
                        description: "Set to true if the image should be optimized to show correct text. This is useful when the user asks for a picture of something that includes specific text as it invokes a different image generation model that is optimized for including text."
                    }
                },
                required: ["detailedInstructions", "renderText"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            let model = "replicate-flux-11-pro";
            let prompt = args.detailedInstructions;
            let numberResults = args.numberResults || 1;
            let negativePrompt = args.negativePrompt || "";

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });
            return await callPathway('image_flux', {...args, text: prompt, negativePrompt, numberResults, model, stream: false });

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};