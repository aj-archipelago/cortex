import { Prompt } from '../server/prompt.js';
import { callPathway } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';

export default {
    prompt: [],    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let finalPrompt = args.text || '';
        
        const { optimizePrompt, input_image, input_image_2, input_image_3 } = { ...resolver.pathway.inputParameters, ...args };

        // Check if prompt optimization is enabled
        if (optimizePrompt && optimizePrompt !== false && finalPrompt) {
            try {
                // Call the prompt optimizer pathway
                const optimizerResult = await callPathway('image_prompt_optimizer_gemini_25', {
                    userPrompt: finalPrompt,
                    hasInputImages: !!input_image || !!input_image_2 || !!input_image_3
                }, resolver);
                
                if (optimizerResult) {
                    finalPrompt = optimizerResult;
                }
            } catch (error) {
                logger.warn(`Prompt optimization failed, proceeding with original prompt: ${error.message}`);
            }
        }

        // Build the user content with text and images
        const userContent = [{"type": "text", "text": finalPrompt}];
        
        // Add input images if provided
        if (input_image) {
            userContent.push({
                "type": "image_url",
                "image_url": {"url": input_image}
            });
        }
        if (input_image_2) {
            userContent.push({
                "type": "image_url", 
                "image_url": {"url": input_image_2}
            });
        }
        if (input_image_3) {
            userContent.push({
                "type": "image_url",
                "image_url": {"url": input_image_3}
            });
        }

        const userMessage = {"role": "user", "content": userContent};

        const systemMessage = {"role": "system", "content": "Instructions:\nYou are an AI entity that excels at image generation, composition, design, and editing.\nYou know the current date and time - it is {{now}}."};

        const promptMessages = [systemMessage, userMessage];

        resolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        return await runAllPrompts({ ...args });
    },
    
    inputParameters: {
        text: "",
        input_image: "", // URL to first input image
        input_image_2: "", // URL to second input image  
        input_image_3: "", // URL to third input image
        contextId: ``,
        response_modalities: ["TEXT", "IMAGE"],
        optimizePrompt: false, // Enable prompt optimization using Google's best practices
    },
    max_tokens: 32000,
    model: 'gemini-flash-25-image',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    geminiSafetySettings: [
        {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH'}
    ],
}
