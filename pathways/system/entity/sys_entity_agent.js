// sys_entity_agent.js
// Agentic extension of the entity system that allows for multi-step tool use
import { callPathway, say } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { addToolCalls, addToolResults } from './memory/shared/sys_memory_helpers.js';

// Helper function to add a tool call and its result together as a pair
function addToolCallWithResult(chatHistory, toolMessage, toolFunction, result) {
    // First add the tool call
    const { toolCallId } = addToolCalls(chatHistory, toolMessage || "Executing tool", toolFunction);
    
    // Then immediately add the result
    addToolResults(chatHistory, result || "No result available.", toolCallId);
    
    // Return the tool call ID in case it's needed
    return toolCallId;
}

export default {
    useInputChunking: false,
    enableDuplicateRequests: false,
    model: 'oai-gpt4o',
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
        maxAgentSteps: 5, // Maximum number of steps the agent can take
        agentTask: '', // The task for the agent to complete
        agentStepCount: 0, // Current step count
        agentWorkingMemory: [], // Working memory for the agent
        agentToolHistory: [] // History of tools used by the agent
    },
    timeout: 600,
  
    executePathway: async ({args, resolver}) => {
        // add the entity constants to the args
        args = {
            ...args,
            ...config.get('entityConstants')
        };

        // if the model has been overridden, make sure to use it
        if (resolver.modelName) {
            args.model = resolver.modelName;
        }

        // set the style model if applicable
        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI } = args;
        const styleModel = aiStyle === "Anthropic" ? AI_STYLE_ANTHROPIC : AI_STYLE_OPENAI;

        // Initialize agent state if this is the first step
        if (!args.agentStepCount) {
            args.agentStepCount = 0;
            args.agentWorkingMemory = [];
            args.agentToolHistory = [];

            // Limit the chat history to 20 messages to speed up processing
            if (args.messages && args.messages.length > 0) {
                args.chatHistory = args.messages.slice(-20);
            } else {
                args.chatHistory = args.chatHistory.slice(-20);
            }

            // We'll get an initial acknowledgment from the LLM instead of using a canned message
            const ackResponse = await callPathway('sys_generator_ack', { ...args, stream: false });
            if (ackResponse && ackResponse !== "none") {
                await say(resolver.requestId, ackResponse, 100);
                args.chatHistory.push({ role: 'assistant', content: ackResponse });
            }

            // Asynchronously manage memory for this context
            if (args.aiMemorySelfModify) {
                callPathway('sys_memory_manager', {  ...args, stream: false })    
                .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
            }

            const memoryContext = await callPathway('sys_read_memory', { ...args, section: 'memoryContext', priority: 0, recentHours: 0, stream: false }, resolver);
            if (memoryContext) {
                // Use the new function to add both call and result together
                addToolCallWithResult(args.chatHistory, { section: 'memoryContext' }, "memory_lookup", memoryContext);
            }
            
            // If no specific task was provided, extract it from the last user message
            if (!args.agentTask) {
                const lastUserMessage = [...args.chatHistory].reverse().find(msg => msg.role === 'user');
                if (lastUserMessage) {
                    args.agentTask = typeof lastUserMessage.content === 'string' 
                        ? lastUserMessage.content 
                        : JSON.stringify(lastUserMessage.content);
                }
            }
        }

        // Check if we've reached the maximum number of steps
        if (args.agentStepCount >= args.maxAgentSteps) {            
            // Call the final response generator
            const finalResponse = await callPathway('sys_agent_final_response', { 
                ...args, 
                stream: args.stream 
            }, resolver);

            return finalResponse;
        }
        
        let ackResponse = null;
        if (args.voiceResponse) {
            ackResponse = await callPathway('sys_generator_ack', { ...args, stream: false });
            if (ackResponse && ackResponse !== "none") {
                await say(resolver.requestId, ackResponse, 100);
                args.chatHistory.push({ role: 'assistant', content: ackResponse });
            }
        }

        try {
            // Get agent planning response
            let agentPlanResponse = await callPathway('sys_agent_planner', { 
                ...args,
                chatHistory: args.chatHistory,
                agentTask: args.agentTask,
                agentStepCount: args.agentStepCount,
                agentWorkingMemory: args.agentWorkingMemory,
                agentToolHistory: args.agentToolHistory,
                stream: false
            }, resolver);
            
            try {
                const agentPlan = JSON.parse(agentPlanResponse);
                
                // Use the new function to add both call and result together
                addToolCallWithResult(
                    args.chatHistory, 
                    { 
                        step: args.agentStepCount,
                        nextTool: agentPlan.nextTool,
                        reason: agentPlan.toolReason
                    }, 
                    "agent_plan", 
                    agentPlan.planMessage || "Planning next step..."
                );
                
                // If the agent has completed the task, generate response
                if (agentPlan.taskComplete) {
                    // If we're at step 0, just use generator_quick for a conversational response
                    if (args.agentStepCount < 1) {
                        logger.info(`[executePathway] Task complete at step ${args.agentStepCount}, using generator_quick for response`);
                        const chatResponse = await callPathway('sys_generator_quick', {
                            ...args, 
                            model: styleModel, 
                            ackResponse
                        }, resolver);
                        
                        resolver.tool = JSON.stringify({ search: false, title: args.title });
                        return args.stream ? null : chatResponse;
                    } else {
                        // For multi-step tasks, use the final response generator
                        logger.info(`[executePathway] Task complete after ${args.agentStepCount} steps, using final response generator`);
                        const finalResponse = await callPathway('sys_agent_final_response', { 
                            ...args, 
                            stream: args.stream 
                        }, resolver);
                        
                        return finalResponse;
                    }
                }
                
                // Update the tool selection based on the agent's plan
                if (agentPlan.nextTool) {
                    args.agentToolHistory.push({
                        step: args.agentStepCount,
                        tool: agentPlan.nextTool,
                        reason: agentPlan.toolReason
                    });
                    
                    // Override the tool router with the agent's decision
                    return await executeAgentToolStep({
                        args,
                        resolver,
                        toolFunction: agentPlan.nextTool,
                        toolMessage: agentPlan.toolMessage,
                        styleModel
                    });
                }
            } catch (error) {
                logger.error(`Error parsing agent plan: ${error.message}`);
                // Fall back to regular tool routing if agent planning fails
            }

            // Get tool routing response (if agent planning fails)
            const toolRequiredResponse = await callPathway('sys_router_tool', { 
                ...args,
                chatHistory: args.chatHistory.slice(-4),
                stream: false
            });

            const { toolRequired, toolMessage, toolFunction } = JSON.parse(toolRequiredResponse || '{}');
            
            if (toolRequired && toolFunction) {
                // Don't add the tool call yet - wait until we have the result
                // We'll add both together in executeToolStep
                return await executeToolStep({
                    args,
                    resolver,
                    toolFunction,
                    toolMessage,
                    styleModel
                });
            }

            // If no tool is required, generate a quick response
            const chatResponse = await callPathway('sys_generator_quick', {...args, model: styleModel, ackResponse}, resolver);           
            resolver.tool = JSON.stringify({ search: false, title: args.title });
            return args.stream ? null : chatResponse;

        } catch (e) {
            resolver.logError(e);
            const chatResponse = await callPathway('sys_generator_quick', {...args, model: styleModel, ackResponse}, resolver);
            resolver.tool = JSON.stringify({ search: false, title: args.title });
            return args.stream ? null : chatResponse;
        }
    }
};

// Helper function to execute a tool step
async function executeToolStep({ args, resolver, toolFunction, toolMessage, styleModel }) {
    try {
        logger.info(`[executeToolStep] Starting execution for tool: ${toolFunction}`);
        
        // Stream the actual tool message for single-step operations
        if (!args.skipCallbackMessage && args.agentStepCount === 0 && toolMessage) {
            // Use the actual tool message from the LLM
            const messageToStream = typeof toolMessage === 'string' ? 
                toolMessage : 
                (toolMessage?.message || `Using ${toolFunction}...`);
                
            await say(resolver.requestId, messageToStream, 100);
            args.chatHistory.push({ role: 'assistant', content: messageToStream });
        }
        
        // We'll get the result first, then add both call and result together
        let result = null;
        
        let toolCallbackName, toolCallbackId, toolCallbackMessage;
        
        switch (toolFunction.toLowerCase()) {
            case "codeexecution":
                {
                    const codingRequiredResponse = await callPathway('sys_router_code', { ...args, stream: false });
                    let parsedCodingRequiredResponse;
                    try {
                        parsedCodingRequiredResponse = JSON.parse(codingRequiredResponse || "{}");
                    } catch (error) {
                        logger.error(`Error parsing codingRequiredResponse: ${error.message}, codingRequiredResponse was: ${codingRequiredResponse}`);
                        parsedCodingRequiredResponse = {};
                    }
                    const { codingRequired } = parsedCodingRequiredResponse;
                    if (codingRequired) {
                        const { codingMessage, codingTask, codingTaskKeywords } = parsedCodingRequiredResponse;
                        const message = typeof codingTask === 'string' 
                            ? codingTask 
                            : JSON.stringify(codingTask);
                        const { contextId } = args;
                        logger.info(`Sending task message coding agent: ${message}`);
                        const codeRequestId = await sendMessageToQueue({ message, contextId, keywords: codingTaskKeywords });

                        toolCallbackId = codeRequestId;
                        toolCallbackName = "coding";
                        toolCallbackMessage = codingMessage;
                        break;
                    }
                }
                break;
            case "image":
                toolCallbackName = 'sys_generator_image';
                toolCallbackMessage = toolMessage;
                break;
            case "vision":
            case "video":
            case "audio":
            case "pdf":
            case "text":
                const visionContentPresent = chatArgsHasImageUrl(args);
                if (visionContentPresent) {
                    toolCallbackName = 'sys_generator_video_vision';
                    toolCallbackMessage = toolMessage;
                }
                break;
            case "code":
            case "write":
                toolCallbackName = 'sys_generator_expert';
                toolCallbackMessage = toolMessage;
                break;
            case "reason":
                toolCallbackName = 'sys_generator_reasoning';
                toolCallbackMessage = toolMessage;
                break;
            case "search":
                toolCallbackName = 'sys_generator_results';
                toolCallbackId = null;
                toolCallbackMessage = toolMessage;
                break;
            case "document":
                toolCallbackName = 'sys_generator_document';
                toolCallbackId = null;
                toolCallbackMessage = toolMessage;
                break;
            case "clarify":
                toolCallbackName = null;
                toolCallbackId = null;
                toolCallbackMessage = toolMessage;
                break;
            case "memory":
                toolCallbackName = 'sys_generator_memory';
                toolCallbackId = null;
                toolCallbackMessage = toolMessage;
                break;
            default:
                toolCallbackName = null;
                toolCallbackId = null;
                toolCallbackMessage = null;
                break;
        }

        resolver.tool = JSON.stringify({ 
            hideFromModel: toolCallbackName ? true : false, 
            toolCallbackName, 
            title: args.title,
            search: toolCallbackName === 'sys_generator_results' ? true : false,
            coding: toolCallbackName === 'coding' ? true : false,
            codeRequestId: args.codeRequestId,
            toolCallbackId
        });

        logger.info(`[executeToolStep] Tool callback determined: ${toolCallbackName || 'none'}`);
        
        if (toolCallbackMessage) {
            if (args.skipCallbackMessage) {
                logger.info(`[executeToolStep] Skipping callback message, calling sys_entity_continue`);
                
                try {
                    result = await callPathway('sys_entity_continue', { ...args, stream: false, model: styleModel, generatorPathway: toolCallbackName }, resolver);
                } catch (error) {
                    logger.error(`Error in sys_entity_continue: ${error.message}`);
                    result = "I encountered an error while processing your request.";
                }
                
                // Use the new function to add both call and result together
                addToolCallWithResult(args.chatHistory, toolMessage || "Executing tool", toolFunction, result || "No result available.");
                
                return result;
            }
            
            logger.info(`[executeToolStep] Returning tool callback message`);
            // Use the new function to add both call and result together
            addToolCallWithResult(args.chatHistory, toolMessage || "Executing tool", toolFunction, toolCallbackMessage || "One moment please.");
            
            return toolCallbackMessage || "One moment please.";
        }

        logger.info(`[executeToolStep] No tool callback message, calling sys_generator_quick`);
        try {
            result = await callPathway('sys_generator_quick', {...args, model: styleModel, ackResponse: args.ackResponse}, resolver);
        } catch (error) {
            logger.error(`Error in sys_generator_quick: ${error.message}`);
            result = "I encountered an error while processing your request.";
        }
        
        // Use the new function to add both call and result together
        addToolCallWithResult(args.chatHistory, toolMessage || "Executing tool", toolFunction, result || "No result available.");
        
        resolver.tool = JSON.stringify({ search: false, title: args.title });
        return args.stream ? null : result;
    } catch (error) {
        logger.error(`[executeToolStep] Error: ${error.message}`);
        logger.error(error.stack);
        
        // Even in case of error, use the new function to add both call and result together
        addToolCallWithResult(args.chatHistory, toolMessage || "Error executing tool", toolFunction, "I encountered an error while processing your request.");
        
        throw error; // Re-throw to maintain the error chain
    }
}

// Helper function to execute an agent tool step
async function executeAgentToolStep({ args, resolver, toolFunction, toolMessage, styleModel }) {
    // Increment the agent step count
    args.agentStepCount++;
    
    try {
        logger.info(`[executeAgentToolStep] Starting tool execution for step ${args.agentStepCount}, tool: ${toolFunction}`);
        
        // Find the tool reason from the agent history
        const toolStep = args.agentToolHistory.find(step => step.step === args.agentStepCount - 1);
        
        // Stream the actual tool message or reason to the user
        let messageToStream;
        
        if (toolMessage && typeof toolMessage === 'string') {
            // Use the tool message if it's a string
            messageToStream = toolMessage;
        } else if (toolMessage?.message) {
            // Use the message property if available
            messageToStream = toolMessage.message;
        } else if (toolStep?.reason) {
            // Use the reason from the tool history
            messageToStream = `Step ${args.agentStepCount}: ${toolStep.reason}`;
        } else {
            // Fallback to a generic message with the tool name
            messageToStream = `Step ${args.agentStepCount}: Using ${toolFunction} to continue working on your request...`;
        }
        
        await say(resolver.requestId, messageToStream, 100);
        args.chatHistory.push({ role: 'assistant', content: messageToStream });
        
        // We'll get the result first, then add both call and result together
        let result = null;
        
        try {
            // First get the result
            result = await executeToolStep({
                args: { ...args, stream: false, skipCallbackMessage: true },
                resolver,
                toolFunction,
                toolMessage,
                styleModel
            });
            
            // The tool call and result are already added in executeToolStep
            
        } catch (error) {
            logger.error(`[executeAgentToolStep] Error in executeToolStep: ${error.message}`);
            // If executeToolStep fails, we still need to add a result to maintain the conversation flow
            result = `Execution failed for ${toolFunction}: ${error.message}`;
            
            // Use the new function to add both call and result together
            addToolCallWithResult(args.chatHistory, toolMessage || "Error executing tool", toolFunction, result);
        }
        
        logger.info(`[executeAgentToolStep] Tool execution completed for step ${args.agentStepCount}, got result: ${result ? 'yes' : 'no'}`);
        
        // If we're not at the maximum number of steps, continue to the next step
        if (args.agentStepCount < args.maxAgentSteps) {
            // Store the tool result in working memory
            args.agentWorkingMemory.push({
                step: args.agentStepCount,
                tool: toolFunction,
                result: result || "No result"
            });
            
            logger.info(`[executeAgentToolStep] Continuing to next agent step, current step: ${args.agentStepCount}`);
            
            // Continue to the next agent step
            return await callPathway('sys_entity_agent', args, resolver);
        }
        
        return result;
    } catch (error) {
        logger.error(`[executeAgentToolStep] Error during step ${args.agentStepCount}: ${error.message}`);
        logger.error(error.stack);
        throw error; // Re-throw to maintain the error chain
    }
}

// Helper function to check if chat args has image URL
function chatArgsHasImageUrl(args) {
    if (!args.chatHistory || !Array.isArray(args.chatHistory)) {
        return false;
    }
    
    for (const message of args.chatHistory) {
        if (message.role === 'user' && Array.isArray(message.content)) {
            for (const content of message.content) {
                if (content.type === 'image_url') {
                    return true;
                }
            }
        }
    }
    
    return false;
}

// Helper function to send message to queue (placeholder - you'll need to implement this)
async function sendMessageToQueue(data) {
    logger.info(`[PLACEHOLDER] Sending message to queue: ${JSON.stringify(data)}`);
    return "placeholder-message-id";
} 