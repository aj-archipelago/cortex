// sys_tool_readfile.js
// Entity tool that reads one or more files and answers questions about them

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `You are the part of an AI entity named {{aiName}} that can view, hear, and understand files of all sorts (images, videos, audio, pdfs, text, etc.) - you provide the capability to view and analyze files that the user provides.\nThe user has provided you with one or more files in this conversation - you should consider them for context when you respond.\nIf you don't see any files, something has gone wrong in the upload and you should inform the user and have them try again.\n{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 8192,
    model: 'gemini-flash-20-vision',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: [{
        type: "function",
        icon: "📄",
        function: {
            name: "PDF",
            description: "Use specifically for analyzing and answering questions about PDF file content.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
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
        icon: "📝",
        function: {
            name: "Text",
            description: "Use specifically for analyzing and answering questions about text files.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
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
        icon: "🖼️",
        function: {
            name: "Vision",
            description: "Use specifically for analyzing and answering questions about image files (jpg, gif, bmp, png, etc).",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
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
        icon: "🎥",
        function: {
            name: "Video",
            description: "Use specifically for analyzing and answering questions about video or audio file content. You MUST use this tool to look at video or audio files.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
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
        const result = await runAllPrompts({ ...args });
        resolver.tool = JSON.stringify({ toolUsed: "vision" });
        return result;
    }
}
