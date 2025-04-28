// sys_tool_remember.js
// Entity tool that looks for relevant information in the entity's memory
import { callPathway } from '../../../../lib/pathwayTools.js';

export default {
    prompt:
        [],
    model: 'oai-gpt41-mini',

    toolDefinition: [{
        type: "function",
        function: {
            name: "Remember",
            description: "Use specifically to search your long term memory for information or details that may not be present in your short term memory. You should always use this tool before you tell the user you don't remember something.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed description of what you want to see if you remember"
                    }
                },
                required: ["detailedInstructions"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "LoadMemoryContext",
            description: "This tool quickly preloads the memory context for this turn of the conversation.  It's typically automatically used by the system, but you can use it if you need to.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do"
                    }
                },
                required: ["detailedInstructions"]
            }
        }
    }],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        resolver.tool = JSON.stringify({ toolUsed: "memory" });
        return await callPathway('sys_search_memory', { ...args, stream: false, section: 'memoryAll', updateContext: true });
    }
}