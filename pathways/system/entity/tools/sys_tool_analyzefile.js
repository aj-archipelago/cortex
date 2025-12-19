// sys_tool_analyzefile.js
// Entity tool that analyzes one or more files and answers questions about them

import { Prompt } from '../../../../server/prompt.js';
import { generateFileMessageContent, injectFileIntoChatHistory } from '../../../../lib/fileUtils.js';
import logger from '../../../../lib/logger.js';

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
        contextKey: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 8192,
    model: 'gemini-flash-3-vision',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    geminiSafetySettings: [{category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH'}],
    toolDefinition: [{
        type: "function",
        icon: "📄",
        function: {
            name: "AnalyzePDF",
            description: "Use specifically for reading, analyzing, and answering questions about PDF file content. Do not use this tool for analyzing and answering questions about other file types.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
                    },
                    file: {
                        type: "string",
                        description: "Optional: The file to analyze (from ListFileCollection or SearchFileCollection): can be the hash, the filename, the URL, or the GCS URL. You can find available files in the availableFiles section."
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
        enabled: false,
        icon: "📝",
        function: {
            name: "AnalyzeText",
            description: "Use specifically for reading, analyzing, and answering questions about text files (including csv, json, html, etc.).",
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
        enabled: false,
        icon: "📝",
        function: {
            name: "AnalyzeMarkdown",
            description: "Use specifically for reading, analyzing, and answering questions about markdown files.",
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
        enabled: false,
        icon: "🖼️",
        function: {
            name: "AnalyzeImage",
            description: "Use specifically for reading, analyzing, and answering questions about image files (jpg, gif, bmp, png, etc). This cannot be used for creating or transforming images.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
                    },
                    file: {
                        type: "string",
                        description: "Optional: The file to analyze (from ListFileCollection or SearchFileCollection): can be the hash, the filename, the URL, or the GCS URL. You can find available files in the availableFiles section."
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
            name: "AnalyzeVideo",
            description: "Use specifically for reading, analyzing, and answering questions about video or audio file content. You MUST use this tool to look at video or audio files. This tool supports YouTube URLs (youtube.com, youtu.be), direct video/audio file URLs, and files from the file collection.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do - questions you need answered about the files, etc."
                    },
                    file: {
                        type: "string",
                        description: "Optional: The file to analyze. Can be: (1) A YouTube URL (youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/..., youtube.com/embed/...), (2) A direct video/audio file URL, (3) A file from the collection (hash, filename, URL, or GCS URL from ListFileCollection or SearchFileCollection). You can find available files in the availableFiles section."
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
        try {
            // Generate file message content and inject file if provided
            if (args.file) {
                const fileContent = await generateFileMessageContent(args.file, args.contextId, args.contextKey);
                if (!fileContent) {
                    const errorMessage = `File not found: "${args.file}". Use ListFileCollection or SearchFileCollection to find available files.`;
                    resolver.tool = JSON.stringify({ toolUsed: "vision" });
                    return JSON.stringify({ 
                        error: errorMessage,
                        recoveryMessage: "The file was not found. Please verify the file exists in the collection or provide a valid file reference."
                    });
                }
                args.chatHistory = injectFileIntoChatHistory(args.chatHistory, fileContent);
            }

            if (args.detailedInstructions) {
                args.chatHistory.push({role: "user", content: args.detailedInstructions});
            }
            
            const result = await runAllPrompts({ ...args });
            resolver.tool = JSON.stringify({ toolUsed: "vision" });
            return result;
        } catch (e) {
            // Catch any errors from runAllPrompts or other operations
            const errorMessage = e?.message || e?.toString() || String(e);
            logger.error(`Error in analyzer tool: ${errorMessage}`);
            
            resolver.tool = JSON.stringify({ toolUsed: "vision" });
            return JSON.stringify({ 
                error: errorMessage,
                recoveryMessage: "The file analysis failed. Please verify the file is accessible and in a supported format, or try a different file."
            });
        }
    }
}
