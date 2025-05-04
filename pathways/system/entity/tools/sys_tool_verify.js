// sys_tool_verify.js
// Entity tool that provides response verification and critical evaluation capabilities

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `You are the part of an AI entity named {{aiName}} that provides critical evaluation and verification capabilities. You excel at analyzing responses for accuracy, completeness, and potential issues. You do not have the tools to do the verification yourself, but youcan help identify gaps, inconsistencies, questions, and areas that need further verification. Think carefully about the response and provide a detailed plan for verification including questions and follow-up actions to ensure the response is robust and reliable. Always include a section called <VERIFICATION_PLAN> that outlines step by step actions to take to answer questions or further research the response.\n{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}",
                {"role": "user", "content": `Please provide a {{verificationLevel}} review of the following draft response:\n\n<DRAFT_RESPONSE>\n{{responseText}}\n</DRAFT_RESPONSE>\n\n{{context}}`}
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
        model: 'oai-o3'
    },
    max_tokens: 100000,
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: [{
        type: "function",
        icon: "🔍",
        function: {
            name: "Verify",
            description: "Critically evaluate a response and provide verification questions and follow-up actions. You should call this tool and execute the steps provided in the resulting verification plan before presenting a final response to the user to ensure it is accurate, complete, and consistent with the user's request.",
            parameters: {
                type: "object",
                properties: {
                    responseText: {
                        type: "string",
                        description: "The draft response text to be verified"
                    },
                    context: {
                        type: "string",
                        description: "Additional context or instructions about the verification request"
                    },
                    verificationLevel: {
                        type: "string",
                        description: "The level of verification required (basic, thorough, or critical)",
                        enum: ["basic", "thorough", "critical"]
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["responseText", "verificationLevel", "userMessage"]
            }
        }
    }],
    
    executePathway: async ({args, runAllPrompts, resolver}) => {        
        let result = await runAllPrompts({ ...args, stream: false });        
        resolver.tool = JSON.stringify({ toolUsed: "verification" });          
        return result;
    }
} 