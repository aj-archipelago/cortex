// sys_generator_image.js
// Entity module that creates and shows images to the user
import { callPathway } from '../../../lib/pathwayTools.js';
import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';
import { getUniqueId } from '../../../lib/util.js';

const TOKEN_RATIO = 1.0;

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        privateData: false,
        useMemory: true,    
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        indexName: ``,
        semanticConfiguration: ``,
        roleInformation: ``,    
        calculateEmbeddings: false,
        language: "English",
        chatId: ``,
        model: 'oai-gpt4o',
    },
    timeout: 300,
    tokenRatio: TOKEN_RATIO,

    executePathway: async ({args, runAllPrompts, resolver}) => {

        const { chatHistory } = args;

        let pathwayResolver = resolver;

        const useMemory = args.useMemory || pathwayResolver.pathway.inputParameters.useMemory;

        const useMemoryPrompt = useMemory ? `{{renderTemplate AI_MEMORY}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n` : "";

        pathwayResolver.pathwayPrompt = 
        [
            new Prompt({ messages: [
                {
                    "role": "system",
                    "content": `${useMemoryPrompt}{{renderTemplate AI_COMMON_INSTRUCTIONS}}\nAs part of a conversation with the user, you have been asked to create one or more images for the user. You have already written the prompts and created the images, but now you need to show them to the user. You can decide which images to display and how to display them - you should do it in a way that is most pleasing to the user. You can use markdown or html and img tags to display and format the images - the UI will render either. You can be creative in your display and layout. Links to the images that you created are in the result of the final tool call below. If you don't see any tool results, it means you didn't create any images.`
                },
                "{{chatHistory}}",
            ]}),
        ];

        // function to add tool_calls to the chatHistory
        const addToolCalls= (chatHistory, imagePrompt, toolCallId) => {
            const toolCall = {
                "role": "assistant",
                "tool_calls": [
                        {
                            "id": toolCallId,
                            "type": "function",
                            "function": {
                                "arguments": JSON.stringify(imagePrompt),
                                "name": "generate_image"
                            }
                        }
                    ]
            };
            chatHistory.push(toolCall);
            return chatHistory;
        }

        // function to add tool_results to the chatHistory
        const addToolResults = (chatHistory, imageResults, toolCallId) => {
            const toolResult = {
                "role": "tool",
                "content": imageResults,
                "tool_call_id": toolCallId
            };
            chatHistory.push(toolResult);
            return chatHistory;
        }

        try {
          
            // figure out what the user wants us to do
            const contextInfo = chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");
            
            const helper = await callPathway('sys_image_prompt_builder', { ...args, stream: false, useMemory, contextInfo });
            logger.debug(`Image prompt builder response: ${helper}`);
            const parsedHelper = JSON.parse(helper);
            
            //parsedHelper should always be an array of objects, but in case it's a single object, we'll wrap it in an array
            const imagePrompts = Array.isArray(parsedHelper) ? parsedHelper : [parsedHelper];

            //for each image prompt, create the images
            const imageResults = await Promise.all(imagePrompts.map(async (imagePrompt) => {
                const { prompt, numberResults, negativePrompt, renderText, draft } = imagePrompt;
                if (!prompt) return null;
                
                let model = "replicate-flux-11-pro";
                if (numberResults > 1 || draft) {
                    model = "runware-flux-schnell";
                }
                if (renderText) {
                    return await callPathway('image_recraft', {...args, text: prompt });
                } else {
                    return await callPathway('image_flux', {...args, text: prompt, negativePrompt, numberResults, model });
                }
            })).then(results => results.filter(r => r !== null));

            // add the tool_calls and tool_results to the chatHistory
            imageResults.forEach((imageResult, index) => {
                const toolCallId = getUniqueId();
                addToolCalls(chatHistory, imagePrompts[index], toolCallId);
                addToolResults(chatHistory, imageResult, toolCallId);
            });
            
            const result = await runAllPrompts({ ...args });

            return result;
        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};