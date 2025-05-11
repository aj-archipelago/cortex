// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const MAX_TOOL_CALLS = 50;

import { callPathway, callTool, say } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { chatArgsHasImageUrl, removeOldImageAndFileContent } from '../../../lib/util.js';
import { Prompt } from '../../../server/prompt.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';

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
        model: 'oai-gpt41'
    },
    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        if (!args || !message || !resolver) {
            return;
        }

        const { tool_calls } = message;
        const pathwayResolver = resolver;
        const { entityTools, entityToolsOpenAiFormat } = args;

        pathwayResolver.toolCallCount = (pathwayResolver.toolCallCount || 0);
        
        const preToolCallMessages = JSON.parse(JSON.stringify(args.chatHistory || []));
        const finalMessages = JSON.parse(JSON.stringify(preToolCallMessages));

        if (tool_calls) {
            if (pathwayResolver.toolCallCount < MAX_TOOL_CALLS) {
                // Execute tool calls in parallel but with isolated message histories
                const toolResults = await Promise.all(tool_calls.map(async (toolCall) => {
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
                        
                        // Report status to the user
                        const toolUserMessage = toolArgs.userMessage || `Executing tool: ${toolCall.function.name} - ${JSON.stringify(toolArgs)}`;
                        const messageWithIcon = toolIcon ? `${toolIcon}&nbsp;&nbsp;${toolUserMessage}` : toolUserMessage;
                        await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `${messageWithIcon}\n\n`, 1000, false);

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
                const failedTools = toolResults.filter(result => !result.success);
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

            return await pathwayResolver.promptAndParse({
                ...args,
                tools: entityToolsOpenAiFormat,
                tool_choice: "auto",
            });
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
                ]);
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
            {"role": "system", "content": `${promptPrefix}${instructionTemplates}{{renderTemplate AI_TOOLS}}\n\n{{renderTemplate AI_SEARCH_RULES}}\n\n{{renderTemplate AI_SEARCH_SYNTAX}}\n\n{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n${memoryTemplates}{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        // set the style model if applicable
        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI } = args;
        const styleModel = aiStyle === "Anthropic" ? AI_STYLE_ANTHROPIC : AI_STYLE_OPENAI;

        // Limit the chat history to 20 messages to speed up processing
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }

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
                memoryLookupRequired = JSON.parse(await memoryLookupRequiredPromise)?.memoryRequired;
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
                tools: entityToolsOpenAiFormat,
                tool_choice: memoryLookupRequired ? "required" : "auto"
            });

            let toolCallback = pathwayResolver.pathway.toolCallback;
            while (response?.tool_calls) {
                response = await toolCallback(args, response, pathwayResolver);
            }

            return response;

        } catch (e) {
            pathwayResolver.logError(e);
            const chatResponse = await callPathway('sys_generator_quick', {...args, model: styleModel, stream: false}, pathwayResolver);
            return chatResponse;
        }
    }
}; 