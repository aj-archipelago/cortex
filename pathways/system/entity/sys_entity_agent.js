// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const MAX_TOOL_CALLS = 50;

import { callPathway, callTool, say, sendToolStart, sendToolFinish } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { chatArgsHasImageUrl, removeOldImageAndFileContent } from '../../../lib/util.js';
import { getAvailableFiles } from '../../../lib/fileUtils.js';
import { Prompt } from '../../../server/prompt.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import CortexResponse from '../../../lib/cortexResponse.js';

// Helper function to generate a smart error response using the agent
async function generateErrorResponse(error, args, pathwayResolver) {
    const errorMessage = error?.message || error?.toString() || String(error);
    
    // Clear any accumulated errors since we're handling them intelligently
    pathwayResolver.errors = [];
    
    // Use sys_generator_error to create a smart response
    try {
        const errorResponse = await callPathway('sys_generator_error', {
            ...args,
            text: errorMessage,
            chatHistory: args.chatHistory || [],
            stream: false
        }, pathwayResolver);
        
        return errorResponse;
    } catch (errorResponseError) {
        // Fallback if sys_generator_error itself fails
        logger.error(`Error generating error response: ${errorResponseError.message}`);
        return `I apologize, but I encountered an error while processing your request: ${errorMessage}. Please try again or contact support if the issue persists.`;
    }
}

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        chatId: ``,
        language: "English",
        aiName: "Jarvis",
        aiMemorySelfModify: true,
        aiStyle: "OpenAI",
        title: ``,
        messages: [],
        voiceResponse: false,
        codeRequestId: ``,
        skipCallbackMessage: false,
        entityId: ``,
        researchMode: false, 
        model: 'oai-gpt41',
        contextKey: ``
    },
    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        if (!args || !message || !resolver) {
            return;
        }

        // Handle both CortexResponse objects and plain message objects
        let tool_calls;
        if (message instanceof CortexResponse) {
            tool_calls = [...(message.toolCalls || [])];
            if (message.functionCall) {
                tool_calls.push(message.functionCall);
            }
        } else {
            tool_calls = [...(message.tool_calls || [])];
        }
        
        const pathwayResolver = resolver;
        const { entityTools, entityToolsOpenAiFormat } = args;

        pathwayResolver.toolCallCount = (pathwayResolver.toolCallCount || 0);
        
        const preToolCallMessages = JSON.parse(JSON.stringify(args.chatHistory || []));
        const finalMessages = JSON.parse(JSON.stringify(preToolCallMessages));

        if (tool_calls && tool_calls.length > 0) {
            if (pathwayResolver.toolCallCount < MAX_TOOL_CALLS) {
                // Execute tool calls in parallel but with isolated message histories
                // Filter out any undefined or invalid tool calls
                const invalidToolCalls = tool_calls.filter(tc => !tc || !tc.function || !tc.function.name);
                if (invalidToolCalls.length > 0) {
                    logger.warn(`Found ${invalidToolCalls.length} invalid tool calls: ${JSON.stringify(invalidToolCalls, null, 2)}`);
                    // bail out if we're getting invalid tool calls
                    pathwayResolver.toolCallCount = MAX_TOOL_CALLS;
                }
                
                const validToolCalls = tool_calls.filter(tc => tc && tc.function && tc.function.name);
                
                const toolResults = await Promise.all(validToolCalls.map(async (toolCall) => {
                    try {
                        if (!toolCall?.function?.arguments) {
                            throw new Error('Invalid tool call structure: missing function arguments');
                        }

                        const toolArgs = JSON.parse(toolCall.function.arguments);
                        const toolFunction = toolCall.function.name.toLowerCase();
                        
                        // Create an isolated copy of messages for this tool
                        const toolMessages = JSON.parse(JSON.stringify(preToolCallMessages));
                        
                        // Get the tool definition to check for icon
                        const toolDefinition = entityTools[toolFunction]?.definition;
                        const toolIcon = toolDefinition?.icon || '🛠️';
                        
                        // Get the user message for the tool
                        const toolUserMessage = toolArgs.userMessage || `Executing tool: ${toolCall.function.name}`;
                        
                        // Send tool start message
                        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                        const toolCallId = toolCall.id;
                        try {
                            await sendToolStart(requestId, toolCallId, toolIcon, toolUserMessage);
                        } catch (startError) {
                            logger.error(`Error sending tool start message: ${startError.message}`);
                            // Continue execution even if start message fails
                        }

                        const toolResult = await callTool(toolFunction, {
                            ...args,
                            ...toolArgs,
                            toolFunction,
                            chatHistory: toolMessages,
                            stream: false
                        }, entityTools, pathwayResolver);

                        // Tool calls and results need to be paired together in the message history
                        // Add the tool call to the isolated message history
                        toolMessages.push({
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

                        // Add the tool result to the isolated message history
                        const toolResultContent = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult?.result || toolResult);

                        toolMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResultContent
                        });

                        // Add the screenshots using OpenAI image format
                        if (toolResult?.toolImages && toolResult.toolImages.length > 0) {
                            toolMessages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "The tool with id " + toolCall.id + " has also supplied you with these images."
                                    },
                                    ...toolResult.toolImages.map(toolImage => ({
                                        type: "image_url",
                                        image_url: {
                                            url: `data:image/png;base64,${toolImage}`
                                        }
                                    }))
                                ]
                            });
                        }

                        // Send tool finish message (success)
                        const hasError = toolResult?.error !== undefined;
                        try {
                            await sendToolFinish(requestId, toolCallId, !hasError, hasError ? toolResult.error : null);
                        } catch (finishError) {
                            logger.error(`Error sending tool finish message: ${finishError.message}`);
                            // Continue execution even if finish message fails
                        }

                        return { 
                            success: true, 
                            result: toolResult,
                            toolCall,
                            toolArgs,
                            toolFunction,
                            messages: toolMessages
                        };
                    } catch (error) {
                        logger.error(`Error executing tool ${toolCall?.function?.name || 'unknown'}: ${error.message}`);
                        
                        // Send tool finish message (error)
                        // Get requestId and toolCallId if not already defined (in case error occurred before they were set)
                        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                        const toolCallId = toolCall.id;
                        try {
                            await sendToolFinish(requestId, toolCallId, false, error.message);
                        } catch (finishError) {
                            logger.error(`Error sending tool finish message: ${finishError.message}`);
                            // Continue execution even if finish message fails
                        }
                        
                        // Create error message history
                        const errorMessages = JSON.parse(JSON.stringify(preToolCallMessages));
                        errorMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [{
                                id: toolCall.id,
                                type: "function",
                                function: {
                                    name: toolCall.function.name,
                                    arguments: JSON.stringify(toolCall.function.arguments)
                                }
                            }]
                        });
                        errorMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: `Error: ${error.message}`
                        });

                        return { 
                            success: false, 
                            error: error.message,
                            toolCall,
                            toolArgs: toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {},
                            toolFunction: toolCall?.function?.name?.toLowerCase() || 'unknown',
                            messages: errorMessages
                        };
                    }
                }));

                // Merge all message histories in order
                for (const result of toolResults) {
                    try {
                        if (!result?.messages) {
                            logger.error('Invalid tool result structure, skipping message history update');
                            continue;
                        }

                        // Add only the new messages from this tool's history
                        const newMessages = result.messages.slice(preToolCallMessages.length);
                        finalMessages.push(...newMessages);
                    } catch (error) {
                        logger.error(`Error merging message history for tool result: ${error.message}`);
                    }
                }

                // Check if any tool calls failed
                const failedTools = toolResults.filter(result => result && !result.success);
                if (failedTools.length > 0) {
                    logger.warn(`Some tool calls failed: ${failedTools.map(t => t.error).join(', ')}`);
                }

                pathwayResolver.toolCallCount = (pathwayResolver.toolCallCount || 0) + toolResults.length;

            } else {
                finalMessages.push({
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "This agent has reached the maximum number of tool calls - no more tool calls will be executed."
                        }
                    ]
                });
                
            }

            args.chatHistory = finalMessages;

            // clear any accumulated pathwayResolver errors from the tools
            pathwayResolver.errors = [];

            // Add a line break to avoid running output together
            await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

            try {
                return await pathwayResolver.promptAndParse({
                    ...args,
                    tools: entityToolsOpenAiFormat,
                    tool_choice: "auto",
                });
            } catch (parseError) {
                // If promptAndParse fails, generate error response instead of re-throwing
                logger.error(`Error in promptAndParse during tool callback: ${parseError.message}`);
                const errorResponse = await generateErrorResponse(parseError, args, pathwayResolver);
                // Ensure errors are cleared before returning
                pathwayResolver.errors = [];
                return errorResponse;
            }
        }
    },
  
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // Load input parameters and information into args
        const { entityId, voiceResponse, aiMemorySelfModify, chatId, researchMode } = { ...pathwayResolver.pathway.inputParameters, ...args };
        
        const entityConfig = loadEntityConfig(entityId);
        const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);
        const { useMemory: entityUseMemory = true, name: entityName, instructions: entityInstructions } = entityConfig || {};

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

        if(entityConfig?.files && entityConfig?.files.length > 0) {
            //get last user message if not create one to add files to
            let lastUserMessage = args.chatHistory.filter(message => message.role === "user").slice(-1)[0];
            if(!lastUserMessage) {
                lastUserMessage = {
                    role: "user",
                    content: []
                };
                args.chatHistory.push(lastUserMessage);
            }

            //if last user message content is not array then convert to array
            if(!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = lastUserMessage.content ? [lastUserMessage.content] : [];
            }

            //add files to the last user message content
            lastUserMessage.content.push(...entityConfig?.files.map(file => ({
                    type: "image_url",
                    gcs: file?.gcs,
                    url: file?.url,
                    image_url: { url: file?.url },
                    originalFilename: file?.name
                })
            ));
        }

        // Kick off the memory lookup required pathway in parallel - this takes like 500ms so we want to start it early
        let memoryLookupRequiredPromise = null;
        if (entityUseMemory) {
            const chatHistoryLastTurn = args.chatHistory.slice(-2);
            const chatHistorySizeOk = (JSON.stringify(chatHistoryLastTurn).length < 5000);
            if (chatHistorySizeOk) {
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Memory lookup timeout')), 800)
                );
                memoryLookupRequiredPromise = Promise.race([
                    callPathway('sys_memory_lookup_required', { ...args, chatHistory: chatHistoryLastTurn, stream: false }),
                    timeoutPromise
                ]).catch(error => {
                    // Handle timeout or other errors gracefully - return null so the await doesn't throw
                    logger.warn(`Memory lookup promise rejected: ${error.message}`);
                    return null;
                });
            }
        }
        
        args = {
            ...args,
            ...config.get('entityConstants'),
            entityId,
            entityTools,
            entityToolsOpenAiFormat,
            entityUseMemory,
            entityInstructions,
            voiceResponse,
            aiMemorySelfModify,
            chatId,
            researchMode
        };

        pathwayResolver.args = {...args};

        const promptPrefix = researchMode ? 'Formatting re-enabled\n' : '';

        const memoryTemplates = entityUseMemory ? 
            `{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n\n{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_MEMORY_CONTEXT}}\n\n` : '';

        const instructionTemplates = entityInstructions ? (entityInstructions + '\n\n') : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n{{renderTemplate AI_EXPERTISE}}\n\n`;

        const promptMessages = [
            {"role": "system", "content": `${promptPrefix}${instructionTemplates}{{renderTemplate AI_TOOLS}}\n\n{{renderTemplate AI_SEARCH_RULES}}\n\n{{renderTemplate AI_SEARCH_SYNTAX}}\n\n{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n${memoryTemplates}{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        // set the style model if applicable
        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI, AI_STYLE_ANTHROPIC_RESEARCH, AI_STYLE_OPENAI_RESEARCH, AI_STYLE_OPENAI_LEGACY, AI_STYLE_OPENAI_LEGACY_RESEARCH, AI_STYLE_XAI, AI_STYLE_XAI_RESEARCH, AI_STYLE_GOOGLE, AI_STYLE_GOOGLE_RESEARCH } = args;

        // Create a mapping of AI styles to their corresponding models
        const styleModelMap = {
            "Anthropic": { normal: AI_STYLE_ANTHROPIC, research: AI_STYLE_ANTHROPIC_RESEARCH },
            "OpenAI": { normal: AI_STYLE_OPENAI, research: AI_STYLE_OPENAI_RESEARCH },
            "OpenAI_Legacy": { normal: AI_STYLE_OPENAI_LEGACY, research: AI_STYLE_OPENAI_LEGACY_RESEARCH },
            "XAI": { normal: AI_STYLE_XAI, research: AI_STYLE_XAI_RESEARCH },
            "Google": { normal: AI_STYLE_GOOGLE, research: AI_STYLE_GOOGLE_RESEARCH }
        };

        // Get the appropriate model based on AI style and research mode
        const styleConfig = styleModelMap[aiStyle] || styleModelMap["OpenAI"]; // Default to OpenAI
        const styleModel = researchMode ? styleConfig.research : styleConfig.normal;

        // Limit the chat history to 20 messages to speed up processing
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }

        // Get available files from collection (async, syncs files from chat history)
        const availableFiles = await getAvailableFiles(args.chatHistory, args.contextId, args.contextKey);

        // remove old image and file content
        const visionContentPresent = chatArgsHasImageUrl(args);
        visionContentPresent && (args.chatHistory = removeOldImageAndFileContent(args.chatHistory));

        // truncate the chat history in case there is really long content
        const truncatedChatHistory = resolver.modelExecutor.plugin.truncateMessagesToTargetLength(args.chatHistory, null, 1000);
      
        // Asynchronously manage memory for this context
        if (args.aiMemorySelfModify && entityUseMemory) {
            callPathway('sys_memory_manager', {  ...args, chatHistory: truncatedChatHistory, stream: false })    
            .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
        }

        let memoryLookupRequired = false;

        try {
            if (memoryLookupRequiredPromise) {
                const result = await memoryLookupRequiredPromise;
                // If result is null (timeout) or empty, default to false
                if (result && typeof result === 'string') {
                    try {
                        memoryLookupRequired = JSON.parse(result)?.memoryRequired || false;
                    } catch (parseError) {
                        logger.warn(`Failed to parse memory lookup result: ${parseError.message}`);
                        memoryLookupRequired = false;
                    }
                } else {
                    memoryLookupRequired = false;
                }
            } else {
                memoryLookupRequired = false;
            }
        } catch (error) {
            logger.warn(`Failed to test memory lookup requirement: ${error.message}`);
            // If we hit the timeout or any other error, we'll proceed without memory lookup
            memoryLookupRequired = false;
        }

        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            let response = await runAllPrompts({
                ...args,
                modelOverride: styleModel,
                chatHistory: currentMessages,
                availableFiles,
                tools: entityToolsOpenAiFormat,
                tool_choice: memoryLookupRequired ? "required" : "auto"
            });

            // Handle null response (can happen when ModelExecutor catches an error)
            if (!response) {
                throw new Error('Model execution returned null - the model request likely failed');
            }

            let toolCallback = pathwayResolver.pathway.toolCallback;

            // Handle both CortexResponse objects and plain responses
            while (response && (
                (response instanceof CortexResponse && response.hasToolCalls()) ||
                (typeof response === 'object' && response.tool_calls)
            )) {
                try {
                    response = await toolCallback(args, response, pathwayResolver);
                    
                    // Handle null response from tool callback
                    if (!response) {
                        throw new Error('Tool callback returned null - a model request likely failed');
                    }
                } catch (toolError) {
                    // Handle errors in tool callback
                    logger.error(`Error in tool callback: ${toolError.message}`);
                    // Generate error response for tool callback errors
                    const errorResponse = await generateErrorResponse(toolError, args, pathwayResolver);
                    // Ensure errors are cleared before returning
                    pathwayResolver.errors = [];
                    return errorResponse;
                }
            }

            return response;

        } catch (e) {
            logger.error(`Error in sys_entity_agent: ${e.message}`);
            
            // Generate a smart error response instead of throwing
            // Note: We don't call logError here because generateErrorResponse will clear errors
            // and we want to handle the error gracefully rather than tracking it
            const errorResponse = await generateErrorResponse(e, args, pathwayResolver);
            
            // Ensure errors are cleared before returning (in case any were added during error response generation)
            pathwayResolver.errors = [];
            
            return errorResponse;
        }
    }
}; 