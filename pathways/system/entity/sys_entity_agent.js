// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const MAX_TOOL_CALLS = 50;
const TOOL_TIMEOUT_MS = 120000; // 2 minute timeout per tool call
const MAX_TOOL_RESULT_LENGTH = 50000; // Truncate oversized tool results to prevent context overflow

import { callPathway, callTool, say, sendToolStart, sendToolFinish, withTimeout } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { syncAndStripFilesFromChatHistory } from '../../../lib/fileUtils.js';
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

// Helper function to insert a system message, removing any existing ones first
function insertSystemMessage(messages, text, requestId = null) {
    // Create a unique marker to avoid collisions with legitimate content
    const marker = requestId ? `[system message: ${requestId}]` : '[system message]';
    
    // Remove any existing challenge messages with this specific requestId to avoid spamming the model
    const filteredMessages = messages.filter(msg => {
        if (msg.role !== 'user') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return !content.startsWith(marker);
    });
    
    // Insert the new system message
    filteredMessages.push({
        role: "user",
        content: `${marker} ${text}`
    });
    
    return filteredMessages;
}

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    manageTokenLength: false, // Agentic models handle context management themselves
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        agentContext: [
            { contextId: ``, contextKey: ``, default: true }
        ],
        chatId: ``,
        language: "English",
        aiName: "Jarvis",
        aiMemorySelfModify: true,
        title: ``,
        messages: [],
        voiceResponse: false,
        codeRequestId: ``,
        skipCallbackMessage: false,
        entityId: ``,
        researchMode: false,
        userInfo: '',
        model: 'oai-gpt41',
        contextKey: ``,
        clientSideTools: {
            type: 'array',
            items: { type: 'object' },
            default: []
        }
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
        let finalMessages = JSON.parse(JSON.stringify(preToolCallMessages));

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
                        
                        // Get the tool definition to check for icon and timeout
                        const toolDefinition = entityTools[toolFunction]?.definition;
                        const toolIcon = toolDefinition?.icon || '🛠️';
                        
                        // Get timeout from tool definition or use default
                        const toolTimeout = toolDefinition?.timeout || TOOL_TIMEOUT_MS;
                        
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

                        // Wrap tool call with timeout to prevent hanging
                        const toolResult = await withTimeout(
                            callTool(toolFunction, {
                                ...args,
                                ...toolArgs,
                                toolFunction,
                                chatHistory: toolMessages,
                                stream: false,
                                useMemory: false  // Disable memory synthesis for tool calls
                            }, entityTools, pathwayResolver),
                            toolTimeout,
                            `Tool ${toolCall.function.name} timed out after ${toolTimeout / 1000}s`
                        );

                        // Tool calls and results need to be paired together in the message history
                        // Add the tool call to the isolated message history
                        // Preserve thoughtSignature for Gemini 3+ models
                        const toolCallEntry = {
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: JSON.stringify(toolArgs)
                            }
                        };
                        if (toolCall.thoughtSignature) {
                            toolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        toolMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [toolCallEntry]
                        });

                        // Add the tool result to the isolated message history
                        // Extract the result - if it's already a string, use it directly; only stringify objects
                        let toolResultContent;
                        if (typeof toolResult === 'string') {
                            toolResultContent = toolResult;
                        } else if (typeof toolResult?.result === 'string') {
                            toolResultContent = toolResult.result;
                        } else if (toolResult?.result !== undefined) {
                            toolResultContent = JSON.stringify(toolResult.result);
                        } else {
                            toolResultContent = JSON.stringify(toolResult);
                        }

                        toolMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResultContent
                        });

                        // Add the screenshots/images using OpenAI image format
                        if (toolResult?.toolImages && toolResult.toolImages.length > 0) {
                            toolMessages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "The tool with id " + toolCall.id + " has also supplied you with these images."
                                    },
                                    ...toolResult.toolImages.map(toolImage => {
                                        // Handle both base64 strings (screenshots) and image_url objects (file collection images)
                                        if (typeof toolImage === 'string') {
                                            // Base64 string format (screenshots)
                                            return {
                                                type: "image_url",
                                                image_url: {
                                                    url: `data:image/png;base64,${toolImage}`
                                                }
                                            };
                                        } else if (typeof toolImage === 'object' && toolImage.image_url) {
                                            // Image URL object format (file collection images)
                                            return {
                                                type: "image_url",
                                                url: toolImage.url,
                                                gcs: toolImage.gcs,
                                                image_url: toolImage.image_url,
                                                originalFilename: toolImage.originalFilename
                                            };
                                        } else {
                                            // Fallback for any other format
                                            return {
                                                type: "image_url",
                                                image_url: {
                                                    url: toolImage.url || toolImage
                                                }
                                            };
                                        }
                                    })
                                ]
                            });
                        }

                        // Check for errors in tool result
                        // callTool returns { result: parsedResult, toolImages: [] }
                        // We need to check if result has an error field
                        let hasError = false;
                        let errorMessage = null;
                        
                        if (toolResult?.error !== undefined) {
                            // Direct error from callTool (e.g., tool returned null)
                            hasError = true;
                            errorMessage = typeof toolResult.error === 'string' ? toolResult.error : String(toolResult.error);
                        } else if (toolResult?.result) {
                            // Check if result is a string that might contain error JSON
                            if (typeof toolResult.result === 'string') {
                                try {
                                    const parsed = JSON.parse(toolResult.result);
                                    if (parsed.error !== undefined) {
                                        hasError = true;
                                        // Tools return { error: true, message: "..." } so we want the message field
                                        if (parsed.message) {
                                            errorMessage = parsed.message;
                                        } else if (typeof parsed.error === 'string') {
                                            errorMessage = parsed.error;
                                        } else {
                                            // error is true/boolean, so use a generic message
                                            errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                                        }
                                    }
                                } catch (e) {
                                    // Not JSON, ignore
                                }
                            } else if (typeof toolResult.result === 'object' && toolResult.result !== null) {
                                // Check if result object has error field
                                if (toolResult.result.error !== undefined) {
                                    hasError = true;
                                    // Tools return { error: true, message: "..." } so we want the message field
                                    // If message exists, use it; otherwise fall back to error field (if it's a string)
                                    if (toolResult.result.message) {
                                        errorMessage = toolResult.result.message;
                                    } else if (typeof toolResult.result.error === 'string') {
                                        errorMessage = toolResult.result.error;
                                    } else {
                                        // error is true/boolean, so use a generic message
                                        errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                                    }
                                }
                            }
                        }
                        
                        // Send tool finish message
                        try {
                            await sendToolFinish(requestId, toolCallId, !hasError, errorMessage);
                        } catch (finishError) {
                            logger.error(`Error sending tool finish message: ${finishError.message}`);
                            // Continue execution even if finish message fails
                        }

                        return { 
                            success: !hasError, 
                            result: toolResult,
                            error: errorMessage,
                            toolCall,
                            toolArgs,
                            toolFunction,
                            messages: toolMessages
                        };
                    } catch (error) {
                        // Detect if this is a timeout error for clearer logging
                        const isTimeout = error.message?.includes('timed out');
                        logger.error(`${isTimeout ? 'Timeout' : 'Error'} executing tool ${toolCall?.function?.name || 'unknown'}: ${error.message}`);
                        
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
                        // Preserve thoughtSignature for Gemini 3+ models
                        const errorToolCallEntry = {
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: JSON.stringify(toolCall.function.arguments)
                            }
                        };
                        if (toolCall.thoughtSignature) {
                            errorToolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        errorMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [errorToolCallEntry]
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

                // Check if any of the executed tools are hand-off tools (async agents)
                // Hand-off tools don't return results immediately, so we skip the completion check
                const hasHandoffTool = toolResults.some(result => {
                    if (!result || !result.toolFunction) return false;
                    const toolDefinition = entityTools[result.toolFunction]?.definition;
                    return toolDefinition?.handoff === true;
                });

                // Inject challenge message after tools are executed to encourage task completion
                // Only inject in research mode - in normal mode, let the model be more decisive
                // Skip this check if a hand-off tool was used (async agents handle their own completion)
                if (!hasHandoffTool && args.researchMode) {
                    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    finalMessages = insertSystemMessage(finalMessages, 
                        "Review the tool results above. If your task is incomplete or requires additional steps or information, call the necessary tools now. Adapt your approach and re-plan if you are not finding the information you need. Only respond to the user once the task is complete and sufficient information has been gathered.",
                        requestId
                    );
                }

            } else {
                const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                finalMessages = insertSystemMessage(finalMessages,
                    "Maximum tool call limit reached - no more tool calls will be executed. Provide your response based on the information gathered so far.",
                    requestId
                );
            }

            // Truncate oversized tool results to prevent context overflow
            args.chatHistory = finalMessages.map(msg => {
                if (msg.role === 'tool' && msg.content && msg.content.length > MAX_TOOL_RESULT_LENGTH) {
                    logger.warn(`Truncating oversized tool result (${msg.content.length} chars) for ${msg.name || 'unknown tool'}`);
                    return {
                        ...msg,
                        content: msg.content.substring(0, MAX_TOOL_RESULT_LENGTH) + '\n\n[Content truncated due to length]'
                    };
                }
                return msg;
            });

            // clear any accumulated pathwayResolver errors from the tools
            pathwayResolver.errors = [];

            // Add a line break to avoid running output together
            await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

            try {
                const result = await pathwayResolver.promptAndParse({
                    ...args,
                    tools: entityToolsOpenAiFormat,
                    tool_choice: "auto",
                });
                
                // Check if promptAndParse returned null (model call failed)
                if (!result) {
                    const errorMessage = pathwayResolver.errors.length > 0 
                        ? pathwayResolver.errors.join(', ')
                        : 'Model request failed - no response received';
                    logger.error(`promptAndParse returned null during tool callback: ${errorMessage}`);
                    const errorResponse = await generateErrorResponse(new Error(errorMessage), args, pathwayResolver);
                    // Ensure errors are cleared before returning
                    pathwayResolver.errors = [];
                    return errorResponse;
                }
                
                return result;
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
        let { entityId, voiceResponse, aiMemorySelfModify, chatId, researchMode, clientSideTools } = { ...pathwayResolver.pathway.inputParameters, ...args };
        
        // Parse clientSideTools if it's a string (from GraphQL)
        if (typeof clientSideTools === 'string') {
            try {
                clientSideTools = JSON.parse(clientSideTools);
            } catch (e) {
                logger.error(`Failed to parse clientSideTools: ${e.message}`);
                clientSideTools = [];
            }
        }
        
        const entityConfig = loadEntityConfig(entityId);
        let { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);
        const { name: entityName, instructions: entityInstructions } = entityConfig || {};
        
        // Determine useMemory: entityConfig.useMemory === false is a hard disable (entity can't use memory)
        // Otherwise args.useMemory can disable it, default true
        args.useMemory = entityConfig?.useMemory === false ? false : (args.useMemory ?? true);

        // Add client-side tools from the caller
        if (clientSideTools && Array.isArray(clientSideTools) && clientSideTools.length > 0) {
            logger.info(`Adding ${clientSideTools.length} client-side tools from caller`);
            clientSideTools.forEach(tool => {
                const toolName = tool.function?.name?.toLowerCase();
                if (toolName) {
                    // Mark as client-side tool and add to available tools
                    entityTools[toolName] = {
                        definition: {
                            ...tool,
                            clientSide: true,  // Mark it as client-side
                            icon: tool.icon || '📱'
                        },
                        pathwayName: 'client_side_execution',  // Placeholder pathway
                        clientSide: true
                    };
                    entityToolsOpenAiFormat.push(tool);
                    logger.info(`Registered client-side tool: ${toolName}`);
                }
            });
        }

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
        if (args.useMemory) {
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
            entityInstructions,
            voiceResponse,
            aiMemorySelfModify,
            chatId,
            researchMode
        };

        pathwayResolver.args = {...args};

        const promptPrefix = '';

        const memoryTemplates = args.useMemory ? 
            `{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n\n{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_MEMORY_CONTEXT}}\n\n` : '';

        const instructionTemplates = entityInstructions ? (entityInstructions + '\n\n') : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n{{renderTemplate AI_EXPERTISE}}\n\n`;

        const promptMessages = [
            {"role": "system", "content": `${promptPrefix}${instructionTemplates}{{renderTemplate AI_TOOLS}}\n\n{{renderTemplate AI_SEARCH_RULES}}\n\n{{renderTemplate AI_SEARCH_SYNTAX}}\n\n{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n${memoryTemplates}{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        // Use 'high' reasoning effort in research mode for thorough analysis, 'none' in normal mode for faster responses
        const reasoningEffort = researchMode ? 'high' : 'low';

        // Limit the chat history to 20 messages to speed up processing
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }

        // Process files in chat history:
        // - Files in collection (all agentContext contexts): stripped, accessible via tools
        // - Files not in collection: left in message for model to see directly
        const { chatHistory: strippedHistory, availableFiles } = await syncAndStripFilesFromChatHistory(
            args.chatHistory, args.agentContext, chatId
        );
        args.chatHistory = strippedHistory;

        // truncate the chat history in case there is really long content
        const truncatedChatHistory = resolver.modelExecutor.plugin.truncateMessagesToTargetLength(args.chatHistory, null, 1000);
      
        // Asynchronously manage memory for this context
        if (args.aiMemorySelfModify && args.useMemory) {
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
                chatHistory: currentMessages,
                availableFiles,
                reasoningEffort,
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