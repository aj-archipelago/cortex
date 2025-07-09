// sys_tool_coding.js
// Entity tool that provides advanced coding and programming capabilities

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `You are the part of an AI entity named {{aiName}} that provides advanced coding and programming capabilities. You excel at writing, reviewing, and explaining code across various programming languages. You can help with code generation, debugging, optimization, and best practices. Think carefully about the latest request and provide a detailed, well thought out, carefully reviewed response.\n{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}"
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 100000,
    model: 'oai-o3',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    // Tool disabled for now
    /*
    toolDefinition: [{
        type: "function",
        icon: "💻",
        function: {
            name: "Code",
            description: "Engage for any programming-related tasks, including writing, modifying, reviewing, or explaining code.",
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
    */
    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        if (args.detailedInstructions) {
            args.chatHistory.push({role: "user", content: args.detailedInstructions});
        }
        let result = await runAllPrompts({ ...args, stream: false });        
        resolver.tool = JSON.stringify({ toolUsed: "coding" });          
        return result;
    }
} 