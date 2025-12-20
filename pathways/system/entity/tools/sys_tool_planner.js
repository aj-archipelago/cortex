// sys_tool_planner.js
// Entity tool that provides step-by-step planning capabilities using high reasoning mode

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `You are the part of an AI entity named {{aiName}} that provides optimal step-by-step planning capabilities. Your role is to analyze the task at hand and create a detailed, well-structured plan that breaks down the work into clear, actionable steps. Focus on efficiency, completeness, and optimal sequencing of operations.\n\nCreate a step-by-step plan that:\n- Identifies all required information and resources\n- Sequences steps in the most efficient order\n- Considers dependencies between steps\n- Anticipates potential issues and includes contingencies\n- Ensures the plan leads to complete task fulfillment\n\nProvide your plan in a clear, structured format that can be easily followed.\n{{renderTemplate AI_DATETIME}}`},
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
    model: 'oai-gpt51',
    reasoningEffort: 'high',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: {
        type: "function",
        enabled: false,
        icon: "📋",
        function: {
            name: "CreatePlan",
            description: "Create a detailed, step-by-step plan to optimally accomplish a complex task. Use this tool when approaching research problems, multi-step operations, or any task that requires careful planning and sequencing of multiple tool calls or operations.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed description of the task that needs to be planned, including any constraints, requirements, or context that should be considered in the plan"
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
    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        if (args.detailedInstructions) {
            args.chatHistory.push({role: "user", content: args.detailedInstructions});
        }
        let result = await runAllPrompts({ ...args, stream: false, reasoningEffort: 'high' });        
        resolver.tool = JSON.stringify({ toolUsed: "planner" });          
        return result;
    }
};

