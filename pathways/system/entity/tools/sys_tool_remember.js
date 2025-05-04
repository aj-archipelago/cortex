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
            name: "Remember",
            description: "Use specifically to search your long term memory for information or details that may not be present in your short term memory. You should always use this tool before you tell the user you don't remember something. If the user asks you a question (like what's your favorite color) and you don't remember the answer, use this tool to search your long term memory for the answer before you tell the user you don't have one.",
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
            name: "LoadMemoryContext",
            description: "This tool quickly preloads the memory context for this turn of the conversation.  It's typically automatically used by the system, but you can use it if you need to.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do"
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