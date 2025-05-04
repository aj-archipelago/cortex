// sys_tool_callmodel.js
// Entity tool that calls a model to get a response
import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "{{{systemPrompt}}}" },
                { "role": "user", "content": "{{{userPrompt}}}" }
            ]
        }),
    ],

    inputParameters: {
        userPrompt: "",
        systemPrompt: "",
        model: "oai-gpt41"
    },
    
    toolDefinition:     {
        type: "function",
        icon: "🤖",
        function: {
            name: "CallModel",
            description: "Use when you need to call an AI model to get a response. This is typically used to perform some sort of LLM analysis (translate, summarize, ask questions about content, etc.), but can literally do anything you need. You can use this to call any model you have access to and perform any task.",
            parameters: {
                type: "object",
                properties: {
                    systemPrompt: {
                        type: "string",
                        description: "The system prompt to send to the model to set up the context for what you want the model to do."
                    },
                    userPrompt: {
                        type: "string",
                        description: "The complete prompt to send as a user message to the model instructing the model to perform the task you need. Keep in mind this model does not share your context, conversation history, tool call results, or memories - so include all relevant information in the user prompt."
                    },
                    model: {
                        type: "string",
                        description: "The model to use. You currently have the following models available to call: oai-gpt4o, oai-gpt41, oai-o3, oai-o3-mini, claude-35-sonnet-vertex, gemini-flash-20-vision, gemini-pro-25-vision."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["systemPrompt", "userPrompt", "model", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        try {
            const result = await runAllPrompts({ ...args });
            return result;
        } catch (error) {
            logger.error(error);
            return "Error calling model: " + error.message;
        }
    }
}