// sys_tool_remember.js
// Entity tool that looks for relevant information in the entity's memory
import { callPathway } from '../../../../lib/pathwayTools.js';

export default {
    prompt:
        [],
    model: 'oai-gpt41-mini',

    toolDefinition: [{
        type: "function",
        icon: "🧩",
        function: {
            name: "SearchMemory",
            description: "Use this tool to search your memory and remember information or details that may not be present in your short term or contextual memory. You should always use this tool before you answer questions about remembered information. It's critical that you never fabricate memories.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed description of what you want to see if you remember"
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
        icon: "🧩",
        function: {
            name: "Remember",
            description: "When the user asks you if you remember something, you must use this tool before you answer. It's critical that you never fabricate memories.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed description of what you want to see if you remember"
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
        if (args.detailedInstructions) {
            args.chatHistory.push({role: "user", content: args.detailedInstructions});
        }
        resolver.tool = JSON.stringify({ toolUsed: "memory" });
        return await callPathway('sys_search_memory', { ...args, stream: false, section: 'memoryAll', updateContext: true });
    }
}