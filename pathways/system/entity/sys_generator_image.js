// sys_generator_image.js
// Entity module that creates and shows images to the user
import { callPathway } from '../../../lib/pathwayTools.js';
import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';
import { getUniqueId } from '../../../lib/util.js';

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

    executePathway: async ({args, runAllPrompts, resolver}) => {

        const { chatHistory } = args;

        let pathwayResolver = resolver;

        const useMemory = args.useMemory || pathwayResolver.pathway.inputParameters.useMemory;

        pathwayResolver.pathwayPrompt = 
        [
            new Prompt({ messages: [
                {
                    "role": "system",
                    "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}

{{renderTemplate AI_DIRECTIVES}}

Instructions: As part of a conversation with the user, you have been asked to create one or more images, photos, pictures, selfies, drawings, or other visual content for the user. You have already written the prompts and created the images - links to them are in the most recent tool calls in the chat history. You should display the images in a way that is most pleasing to the user. You can use markdown or HTML and img tags to display and format the images - the UI will render either. If there are no tool results, it means you didn't successfully create any images - in that case, don't show any images and tell the user you weren't able to create images.\n{{renderTemplate AI_DATETIME}}`
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
                    model = "replicate-flux-1-schnell";
                }
                if (renderText) {
                    return await callPathway('image_recraft', {...args, text: prompt, model, stream: false });
                } else {
                    return await callPathway('image_flux', {...args, text: prompt, negativePrompt, numberResults, model, stream: false });
                }
            })).then(results => results.filter(r => r !== null));

            // add the tool_calls and tool_results to the chatHistory
            imageResults.forEach((imageResult, index) => {
                const toolCallId = getUniqueId();
                addToolCalls(chatHistory, imagePrompts[index], toolCallId);
                addToolResults(chatHistory, imageResult, toolCallId);
            });
            
            const result = await runAllPrompts({ ...args });
            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });
            return result;
        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};