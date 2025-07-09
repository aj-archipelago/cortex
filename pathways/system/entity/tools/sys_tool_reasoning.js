// sys_tool_reasoning.js
// Entity tool that provides advanced reasoning and planning capabilities

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `You are the part of an AI entity named {{aiName}} that provides advanced reasoning and planning capabilities. You excel at breaking down complex problems, creating detailed plans, and providing thorough analysis. Think carefully about the latest request and provide a detailed, well thought out, carefully reviewed response.\n{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}",
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
    toolDefinition: [{
        type: "function",
        icon: "🗺️",
        function: {
            name: "PlanMultiStepTask",
            description: "Use specifically to create a thorough, well thought out, step by step plan to accomplish a task. You should always use this tool when you're planning to do something complex or something that might require multiple steps.",
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
    },
    {
        type: "function",
        icon: "🧠",
        function: {
            name: "ApplyAdvancedReasoning",
            description: "Employ for advanced reasoning, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices.",
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
        let result = await runAllPrompts({ ...args, stream: false });        
        resolver.tool = JSON.stringify({ toolUsed: "reasoning" });          
        return result;
    }
} 