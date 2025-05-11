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
            description: "Use this tool to search your memory and retrieve information or details stored in your memory. Use any time the user asks you about something personal or asks you to remember something.",
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