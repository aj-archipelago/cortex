import { Prompt } from '../server/prompt.js';
import { callPathway } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';

export default {
    prompt: [],    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let finalPrompt = args.text || '';
        
        // Extract all input image parameters (up to 14 images)
        const inputImages = [];
        for (let i = 1; i <= 14; i++) {
            const imageParam = i === 1 ? 'input_image' : `input_image_${i}`;
            const imageValue = resolver.pathway.inputParameters[imageParam] || args[imageParam];
            if (imageValue) {
                inputImages.push(imageValue);
            }
        }

        const { optimizePrompt } = { ...resolver.pathway.inputParameters, ...args };

        // Check if prompt optimization is enabled
        if (optimizePrompt && finalPrompt) {
            try {
                // Call the prompt optimizer pathway
                const optimizerResult = await callPathway('image_prompt_optimizer_gemini_25', {
                    userPrompt: finalPrompt,
                    hasInputImages: inputImages.length > 0
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
        
        // Add all input images if provided
        inputImages.forEach(imageUrl => {
            userContent.push({
                "type": "image_url",
                "image_url": {"url": imageUrl}
            });
        });

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
        input_image_4: "", // URL to fourth input image
        input_image_5: "", // URL to fifth input image
        input_image_6: "", // URL to sixth input image
        input_image_7: "", // URL to seventh input image
        input_image_8: "", // URL to eighth input image
        input_image_9: "", // URL to ninth input image
        input_image_10: "", // URL to tenth input image
        input_image_11: "", // URL to eleventh input image
        input_image_12: "", // URL to twelfth input image
        input_image_13: "", // URL to thirteenth input image
        input_image_14: "", // URL to fourteenth input image
        contextId: ``,
        response_modalities: ["TEXT", "IMAGE"],
        optimizePrompt: false, // Enable prompt optimization using Google's best practices
        aspectRatio: "", // Image aspect ratio (e.g., "16:9", "1:1", "9:16", "4:3", "3:4")
        image_size: "", // Image size (e.g., "2K", "4K")
    },
    max_tokens: 64576,
    model: 'gemini-pro-3-image',
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

