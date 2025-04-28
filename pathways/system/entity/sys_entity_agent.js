// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
import { callPathway, callTool, say } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { chatArgsHasImageUrl, removeOldImageAndFileContent } from '../../../lib/util.js';
import { insertToolCallAndResults } from './memory/shared/sys_memory_helpers.js';
import { Prompt } from '../../../server/prompt.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';

export default {
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        indexName: ``,
        semanticConfiguration: ``,
        roleInformation: ``,    
        calculateEmbeddings: false,
        dataSources: ["mydata", "aja", "aje", "wires", "bing"],
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
        model: 'oai-gpt41'
    },
    timeout: 600,
  
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // add the entity constants to the args
        args = {
            ...args,
            ...config.get('entityConstants')
        };

        const { maxAgentSteps, voiceResponse, entityId } = pathwayResolver.pathway.inputParameters;
        args.maxAgentSteps = maxAgentSteps;
        args.voiceResponse = voiceResponse;
       
        // Load entity configuration and get tools
        const entityConfig = loadEntityConfig(entityId);
        const { tools, openAiTools } = getToolsForEntity(entityId, entityConfig);

        const promptMessages = [
            {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_TOOLS}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_MEMORY_DIRECTIVES}}\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        // if the model has been overridden, make sure to use it
        if (pathwayResolver.modelName) {
            args.model = pathwayResolver.modelName;
        }

        // set the style model if applicable
        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI } = args;
        const styleModel = aiStyle === "Anthropic" ? AI_STYLE_ANTHROPIC : AI_STYLE_OPENAI;

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

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

        // Add the memory context to the chat history if applicable
        if (truncatedChatHistory.length > 1) {
            const memoryContext = await callPathway('sys_read_memory', { ...args, chatHistory: truncatedChatHistory, section: 'memoryContext', priority: 0, recentHours: 0, stream: false }, resolver);
            if (memoryContext) {
                insertToolCallAndResults(args.chatHistory, "Load general memory context information", "LoadMemoryContext", memoryContext);
            }
        }
        
        // Asynchronously manage memory for this context
        if (args.aiMemorySelfModify) {
            callPathway('sys_memory_manager', {  ...args, chatHistory: truncatedChatHistory, stream: false })    
            .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
        }

        try {
            // Loop until we get a final response
            let finalResponse = null;
            // Make a deep copy of the chat history to avoid mutations on the original
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            while (!finalResponse) {
                const response = await runAllPrompts({
                    ...args,
                    chatHistory: JSON.parse(JSON.stringify(currentMessages)),
                    tools: openAiTools,
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
                            
                            // Report status to the user
                            await say(resolver.requestId, `Executing tool: ${toolCall.function.name} - ${JSON.stringify(toolArgs)}\n\n`, 1000, args.voiceResponse);

                            let toolMessages = [...currentMessages];
                            let toolResult = null;

                            if (toolArgs.detailedInstructions) {
                                toolMessages.push({role: "user", content: toolArgs.detailedInstructions});
                            }

                            toolResult = await callTool(toolFunction, {
                                ...args,
                                ...toolArgs,
                                chatHistory: toolMessages,
                                stream: false
                            }, tools, pathwayResolver);

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

                            let toolResultContent = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                            if (pathwayResolver.tool && typeof pathwayResolver.tool === 'string') {
                                try {
                                    let parsedTool = JSON.parse(pathwayResolver.tool);
                                    if (parsedTool.citations) {
                                        toolResultContent += '\n\ncd_source citation array: ' + JSON.stringify(parsedTool.citations);
                                    }
                                } catch (error) {
                                    logger.error(`Error parsing tool result: ${error.message}`);
                                }
                            }

                            // Add the tool result to the chat history
                            currentMessages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                name: toolCall.function.name,
                                content: toolResultContent
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