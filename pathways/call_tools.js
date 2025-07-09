// call_tools.js
// Uses OpenAI's tool calling API
import { callPathway, say } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';
import { config } from '../config.js';
import { Prompt } from '../server/prompt.js';

// Define the available tools in OpenAI's tool calling format
const TOOLS = [
    {
        type: "function",
        function: {
            name: "SearchMemory",
            description: "Use specifically to search your long term memory for information or details that may not be present in your short term memory.",
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
    },
    {
        type: "function",
        function: {
            name: "Search",
            description: "Use for current events, news, fact-checking, and information requiring citation. This tool allows you to search the internet, all Al Jazeera news articles and the latest news wires from multiple sources.",
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
    },
    {
        type: "function",
        function: {
            name: "Document",
            description: "Access user's personal document index. Use for user-specific uploaded information.",
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
    },
    {
        type: "function",
        function: {
            name: "Write",
            description: "Engage for any task related to composing, editing, or refining written content.",
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
    },
    {
        type: "function",
        function: {
            name: "Image",
            description: "Use when asked to create, generate, or revise visual content.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about the image(s) you want to create"
                    }
                },
                required: ["detailedInstructions"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "Code",
            description: "Engage for any programming-related tasks, including creating, modifying, reviewing, or explaining code.",
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
    },
    {
        type: "function",
        function: {
            name: "CodeExecution",
            description: "Use when explicitly asked to run or execute code, or when a coding agent is needed to perform specific tasks.",
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
    },
    {
        type: "function",
        function: {
            name: "Reason",
            description: "Employ for reasoning, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices.",
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
    },
    {
        type: "function",
        function: {
            name: "PDF",
            description: "Use specifically for analyzing and answering questions about PDF file content.",
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
    },
    {
        type: "function",
        function: {
            name: "Vision",
            description: "Use specifically for analyzing and answering questions about image files (jpg, gif, bmp, png, etc).",
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
    },
    {
        type: "function",
        function: {
            name: "Video",
            description: "Use specifically for analyzing and answering questions about video or audio file content.",
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
    }
];

export default {
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    inputParameters: { 
        chatHistory: [{role: '', content: []}],
        contextId: ``,   
        language: "English",
        aiName: "Jarvis",
        aiStyle: "OpenAI",
        model: 'oai-gpt41',
    },
    timeout: 600,
  
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // add the entity constants to the args
        args = {
            ...args,
            ...config.get('entityConstants')
        };

        // set the style model if applicable
        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI } = args;
        const styleModel = aiStyle === "Anthropic" ? AI_STYLE_ANTHROPIC : AI_STYLE_OPENAI;
        
        const promptMessages = [
            {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_TOOLS}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_MEMORY_DIRECTIVES}}\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

        try {
            let currentMessages = [...args.chatHistory];
            let finalResponse = null;

            while (!finalResponse) {
                const response = await runAllPrompts({
                    ...args,
                    chatHistory: currentMessages,
                    tools: TOOLS,
                    tool_choice: "auto",
                    stream: false
                });

                // If response is a string, treat it as the final response
                if (typeof response === 'string') {
                    finalResponse = response;
                    break;
                }

                // Check if the model made any tool calls
                const toolCalls = response.tool_calls || [];
                
                if (toolCalls.length > 0) {
                    // Execute all tool calls in parallel
                    const toolResults = await Promise.all(toolCalls.map(async (toolCall) => {
                        try {
                            const toolArgs = JSON.parse(toolCall.function.arguments);
                            const toolFunction = toolCall.function.name.toLowerCase();
                            
                            // Set the appropriate generator pathway based on the tool function
                            let generatorPathway;
                            switch (toolFunction) {
                                case "codeexecution":
                                    generatorPathway = 'sys_router_code';
                                    break;
                                case "image":
                                    generatorPathway = 'sys_generator_image';
                                    break;
                                case "vision":
                                case "video":
                                case "audio":
                                case "pdf":
                                case "text":
                                    generatorPathway = 'sys_generator_video_vision';
                                    break;
                                case "code":
                                case "write":
                                    generatorPathway = 'sys_generator_expert';
                                    break;
                                case "reason":
                                    generatorPathway = 'sys_generator_reasoning';
                                    break;
                                case "search":
                                    generatorPathway = 'sys_generator_results';
                                    break;
                                case "document":
                                    generatorPathway = 'sys_generator_document';
                                    break;
                                case "searchmemory":
                                    generatorPathway = 'sys_generator_memory';
                                    break;
                                default:
                                    generatorPathway = 'sys_generator_quick';
                                    break;
                            }

                            // Call sys_entity_continue with the appropriate generator pathway
                            const toolResult = await callPathway('sys_entity_continue', {
                                ...args,
                                chatHistory: [{
                                    role: 'user',
                                    content: toolArgs.detailedInstructions || toolArgs.lastUserMessage
                                }],
                                generatorPathway,
                                detailedInstructions: toolArgs.detailedInstructions || toolArgs.lastUserMessage
                            }, resolver);

                            // Add the tool call to the chat history
                            currentMessages.push({
                                role: "assistant",
                                content: "",
                                tool_calls: [{
                                    id: toolCall.id,
                                    type: "function",
                                    function: {
                                        name: toolCall.function.name,
                                        arguments: JSON.stringify(toolArgs)
                                    }
                                }]
                            });

                            // Add the tool result to the chat history
                            currentMessages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                name: toolCall.function.name,
                                content: JSON.stringify(toolResult)
                            });

                            return { success: true, result: toolResult };
                        } catch (error) {
                            logger.error(`Error executing tool ${toolCall.function.name}: ${error.message}`);
                            
                            // Add the error to the chat history
                            currentMessages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                name: toolCall.function.name,
                                content: `Error: ${error.message}`
                            });

                            return { success: false, error: error.message };
                        }
                    }));

                    // Check if any tool calls failed
                    const failedTools = toolResults.filter(result => !result.success);
                    if (failedTools.length > 0) {
                        logger.warn(`Some tool calls failed: ${failedTools.map(t => t.error).join(', ')}`);
                    }
                } else {
                    // No tool calls, this is the final response
                    finalResponse = response.content;
                }
            }

            // Update the chat history with the final messages
            args.chatHistory = currentMessages.filter(msg => msg.role !== "tool");

            // Return the final response
            return finalResponse;

        } catch (e) {
            resolver.logError(e);
            const chatResponse = await callPathway('sys_generator_quick', {...args, model: styleModel}, resolver);
            resolver.tool = JSON.stringify({ search: false, title: args.title });
            return args.stream ? null : chatResponse;
        }
    }
}; 