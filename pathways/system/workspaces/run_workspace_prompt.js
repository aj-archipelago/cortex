import { Prompt } from '@aj-archipelago/cortex/server/prompt.js';
import { config } from '@aj-archipelago/cortex/config.js';
import { getAvailableFiles, chatArgsHasImageUrl, removeOldImageAndFileContent, chatArgsHasType } from '@aj-archipelago/cortex/lib/util.js';
import { callTool, say } from '@aj-archipelago/cortex/lib/pathwayTools.js';
import logger from '@aj-archipelago/cortex/lib/logger.js';
import { getToolsForEntity, loadEntityConfig } from '@aj-archipelago/cortex/pathways/system/entity/tools/shared/sys_entity_tools.js';

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,

    inputParameters: {
        prompt: "",
        systemPrompt: "",
        chatHistory: [{role: '', content: []}],
        text: "",
        entityId: "labeeb",
        aiName: "Jarvis",
        language: "English",
        model: "oai-gpt41", // Allow user to specify model
    },

    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        const MAX_TOOL_CALLS = 50;

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
                model: args.model // Pass the model from args
            });
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // Load input parameters and information into args
        const { entityId, aiName, language, model } = { ...pathwayResolver.pathway.inputParameters, ...args };
        
        const entityConfig = loadEntityConfig(entityId);
        const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

        // Limit the chat history to 20 messages to speed up processing
        args.chatHistory = args.chatHistory.slice(-20);

        // Add entity constants for template rendering
        args = {
            ...args,
            ...config.get('entityConstants'),
            entityId,
            entityTools,
            entityToolsOpenAiFormat,
            aiName,
            language,
            model
        };

        // Extract available files from chat history
        const availableFiles = getAvailableFiles(args.chatHistory);

        // Check for both image and file content (CSV files have type 'file', not 'image_url')
        const hasImageContent = chatArgsHasImageUrl(args);
        const hasFileContent = chatArgsHasType(args, 'file');
        const visionContentPresent = hasImageContent || hasFileContent;

        // Remove old image and file content while preserving the latest uploads
        visionContentPresent && (args.chatHistory = removeOldImageAndFileContent(args.chatHistory));

        const promptMessages = [
            {"role": "system", "content": `${args.systemPrompt || "Assistant is an expert journalist's assistant for Al Jazeera Media Network. When a user posts a request, Assistant will come up with the best response while upholding the highest journalistic standards."}\n\n{{renderTemplate AI_TOOLS}}\n\n{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
            {"role": "user", "content": `${args.text || ""}\n\n${args.prompt || ""}`}
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        pathwayResolver.args = {...args};

        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            let response = await runAllPrompts({
                ...args,
                chatHistory: currentMessages,
                availableFiles,
                tools: entityToolsOpenAiFormat,
                tool_choice: "auto",
                model: args.model // Pass the model from args
            });

            let toolCallback = pathwayResolver.pathway.toolCallback;
            while (response?.tool_calls) {
                response = await toolCallback(args, response, pathwayResolver);
            }

            return response;

        } catch (e) {
            pathwayResolver.logError(e);
            throw e;
        }
    }
};