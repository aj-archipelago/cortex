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
                    files: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Array of files to analyze. Prefer blobPath, workspacePath like /workspace/files/..., URL, or GCS URL from the file object. Legacy hashes and filenames are supported as fallbacks."
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
                    files: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Array of files to analyze. Each can be: (1) A YouTube URL (youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/..., youtube.com/embed/...), (2) a direct video/audio file URL, (3) a file reference such as blobPath, workspacePath like /workspace/files/..., URL, GCS URL, legacy hash, or filename."
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
            // Create a clean chat history with just the file and task - don't include previous chat history
            // This prevents confusion from function results and other context
            const cleanChatHistory = [];
            
            // Generate file message content if provided
            // Support both 'files' array and legacy 'file' parameter for backward compatibility
            const filesToProcess = args.files && Array.isArray(args.files) && args.files.length > 0
                ? args.files
                : (args.file ? [args.file] : []);
            
            if (filesToProcess.length > 0) {
                const fileAccessPlan = Array.isArray(args.fileAccessPlan)
                    ? args.fileAccessPlan
                    : null;

                if (!fileAccessPlan || fileAccessPlan.length === 0) {
                    const errorMessage = `Files not found: fileAccessPlan is required to look up files in the collection.`;
                    resolver.tool = JSON.stringify({ toolUsed: "vision" });
                    return JSON.stringify({ 
                        error: errorMessage,
                        recoveryMessage: "The files were not found. Please verify the files exist in the collection or provide valid file references."
                    });
                }
                
                // Process all files
                const fileContents = [];
                const errors = [];
                
                for (const fileParam of filesToProcess) {
                    const fileContent = await generateFileMessageContent(fileParam, fileAccessPlan);
                    if (!fileContent) {
                        errors.push(`File not found: "${fileParam}"`);
                        continue;
                    }
                    fileContents.push(fileContent);
                }
                
                // If no files were found, return error
                if (fileContents.length === 0) {
                    const errorMessage = errors.length > 0 
                        ? errors.join('; ')
                        : 'No files found. Use FileCollection to find available files.';
                    resolver.tool = JSON.stringify({ toolUsed: "vision" });
                    return JSON.stringify({ 
                        error: errorMessage,
                        recoveryMessage: "The files were not found. Please verify the files exist in the collection or provide valid file references."
                    });
                }
                
                // Combine files and instructions in the same message so Gemini sees both together
                const messageContent = [...fileContents];
                if (args.detailedInstructions) {
                    messageContent.push({type: 'text', text: args.detailedInstructions});
                }
                
                cleanChatHistory.push({role: "user", content: messageContent});
            } else if (args.detailedInstructions) {
                // No files, just add instructions
                cleanChatHistory.push({role: "user", content: args.detailedInstructions});
            }
            
            // Use clean chat history instead of the full chat history
            args.chatHistory = cleanChatHistory;
            
            // Explicitly disable function calling - this tool is just for vision analysis, not tool calls
            // This prevents MALFORMED_FUNCTION_CALL errors
            const result = await runAllPrompts({ ...args, tool_choice: 'none' });
            
            // Check for errors in resolver (ModelExecutor logs errors here when it catches exceptions)
            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                
                const errorMessageStr = errorMessages.join('; ');
                logger.error(`Analyzer tool error: ${errorMessageStr}`);
                
                resolver.tool = JSON.stringify({ toolUsed: "vision" });
                return JSON.stringify({ 
                    error: errorMessageStr,
                    recoveryMessage: "The file analysis failed. Please verify the file is accessible and in a supported format, or try a different file."
                });
            }
            
            // Handle null response (can happen when ModelExecutor catches an error but doesn't log it)
            if (!result) {
                const errorMessage = 'Model execution returned null - the model request likely failed';
                logger.error(`Error in analyzer tool: ${errorMessage}`);
                resolver.tool = JSON.stringify({ toolUsed: "vision" });
                return JSON.stringify({ 
                    error: errorMessage,
                    recoveryMessage: "The file analysis failed. Please verify the file is accessible and in a supported format, or try a different file."
                });
            }
            
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
