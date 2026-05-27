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
        model: "oai-gpt54-mini"
    },
    
    toolDefinition: {
        type: "function",
        enabled: false,
        icon: "🤖",
        function: {
            name: "CallModel",
            description: "Use when you need to call an AI model to get a response. This is typically used to perform some sort of custom LLM analysis (translate, summarize, ask questions about content, etc.), but can literally do anything you need. You can use this to call any model you have access to and perform any task.",
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
                        description: "The model to use. Current examples include oai-gpt54-mini, oai-gpt55, claude-47-opus-vertex, claude-46-sonnet-vertex, gemini-flash-35-vision, and gemini-pro-31-vision."
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
