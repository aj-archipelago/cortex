import Gemini15ChatPlugin from './gemini15ChatPlugin.js';
import CortexResponse from '../../lib/cortexResponse.js';
import { requestState } from '../requestState.js';
import { addCitationsToResolver } from '../../lib/pathwayTools.js';
import mime from 'mime-types';

class Gemini15VisionPlugin extends Gemini15ChatPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.isMultiModal = true;
        this.pathwayToolCallback = pathway.toolCallback;
        this.toolCallsBuffer = [];
        this.contentBuffer = '';
        this.hadToolCalls = false;
    }

    // Override the convertMessagesToGemini method to handle multimodal vision messages
    // This function can operate on messages in Gemini native format or in OpenAI's format
    // It will convert the messages to the Gemini format
    convertMessagesToGemini(messages) {
        let modifiedMessages = [];
        let lastAuthor = '';
        let systemParts = [];
    
        // Check if the messages are already in the Gemini format
        if (messages[0] && Object.prototype.hasOwnProperty.call(messages[0], 'parts')) {
            modifiedMessages = messages;
        } else {
            messages.forEach(message => {
                const { role, author, content } = message;
    
                if (role === 'system') {
                    if (Array.isArray(content)) {
                        content.forEach(item => systemParts.push({ text: item }));
                    } else {
                        systemParts.push({ text: content });
                    }
                    return;
                }
    
                // Convert content to Gemini format, trying to maintain compatibility
                const convertPartToGemini = (inputPart) => {
                    try {
                        // First try to parse as JSON if it's a string
                        const part = typeof inputPart === 'string' ? JSON.parse(inputPart) : inputPart;
                        const {type, text, image_url, gcs} = part;
                        let fileUrl = gcs || image_url?.url;

                        if (typeof part === 'string') {
                            return { text: inputPart };
                        } else if (type === 'text') {
                            return { text: text };
                        } else if (type === 'image_url') {
                            if (!fileUrl) {
                                return null;
                            }
                            if (fileUrl.startsWith('gs://')) {
                                // Validate GCS URL has at least a bucket name after gs://
                                const gcsPath = fileUrl.slice(5); // Remove 'gs://'
                                if (!gcsPath || gcsPath.length < 1) {
                                    return null;
                                }
                                return {
                                    fileData: {
                                        mimeType: mime.lookup(fileUrl) || 'image/jpeg',
                                        fileUri: fileUrl
                                    }
                                };
                            } else if (fileUrl.includes('base64,')) {
                                const base64Data = fileUrl.split('base64,')[1];
                                if (!base64Data) {
                                    return null;
                                }
                                return {
                                    inlineData: {
                                        mimeType: 'image/jpeg',
                                        data: base64Data
                                    }
                                };
                            } else if (fileUrl.includes('youtube.com/') || fileUrl.includes('youtu.be/')) {
                                return {
                                    fileData: {
                                        mimeType: 'video/youtube',
                                        fileUri: fileUrl
                                    }
                                };
                            }
                            return null;
                        }
                    } catch (e) {
                        // If JSON parsing fails or any other error, treat as plain text
                        return inputPart ? { text: inputPart } : null;
                    }
                    return inputPart ? { text: inputPart } : null;
                };

                const addPartToMessages = (geminiPart) => {
                    if (!geminiPart) { return; }
                    // Gemini requires alternating user: and model: messages
                    if ((role === lastAuthor || author === lastAuthor) && modifiedMessages.length > 0) {
                        modifiedMessages[modifiedMessages.length - 1].parts.push(geminiPart);
                    }
                    // Handle tool result messages
                    else if (role === 'tool') {
                        // Convert OpenAI tool result format to Gemini format
                        // OpenAI: { role: 'tool', tool_call_id: '...', content: '...' }
                        // Gemini: { role: 'function', parts: [{ functionResponse: { name: '...', response: { content: '...' } } }] }
                        const toolCallId = message.tool_call_id || message.toolCallId;
                        const toolName = toolCallId ? toolCallId.split('_')[0] : 'unknown_tool';
                        
                        modifiedMessages.push({
                            role: 'function',
                            parts: [{
                                functionResponse: {
                                    name: toolName,
                                    response: {
                                        content: content
                                    }
                                }
                            }]
                        });
                        lastAuthor = 'function';
                    }
                    // Gemini only supports user: and model: roles
                    else if (role === 'user' || role === 'assistant' || author) {
                        modifiedMessages.push({
                            role: author || role,
                            parts: [geminiPart],
                        });
                        lastAuthor = author || role;
                    }
                };

                // Content can either be in the "vision" format (array) or in the "chat" format (string)
                if (Array.isArray(content)) {
                    content.forEach(part => {
                        addPartToMessages(convertPartToGemini(part));
                    });
                } 
                else {
                    addPartToMessages(convertPartToGemini(content));
                }
            });
        }
    
        // Gemini requires an odd number of messages
        if (modifiedMessages.length % 2 === 0) {
            modifiedMessages = modifiedMessages.slice(1);
        }
    
        let system = null;

        if (systemParts.length > 0) {
            system = { role: 'user', parts: systemParts };
        }

        return {
            modifiedMessages,
            system,
        };
    }

    // Convert OpenAI tools to Gemini format
    convertOpenAIToolsToGemini(openAITools) {
        if (!openAITools || !Array.isArray(openAITools)) {
            return [];
        }

        // Convert OpenAI tools to Gemini functionDeclarations format
        const functionDeclarations = openAITools.map(tool => {
            if (tool.type === 'function' && tool.function) {
                return {
                    name: tool.function.name,
                    description: tool.function.description || `Tool for ${tool.function.name}`,
                    parameters: tool.function.parameters || {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                };
            }
            return null;
        }).filter(Boolean);

        // Return in the correct Gemini format: tools array with functionDeclarations
        return [{
            functionDeclarations: functionDeclarations
        }];
    }

    // Override getRequestParameters to handle tool conversion
    getRequestParameters(text, parameters, prompt, cortexRequest) {
        // Convert OpenAI tools to Gemini format if present
        let convertedTools = [];

        // Handle tools parameter - could be string (from REST) or array
        let toolsArray = parameters?.tools;
        if (typeof toolsArray === 'string') {
            try {
                toolsArray = JSON.parse(toolsArray);
            } catch (e) {
                toolsArray = [];
            }
        }
        
        if (toolsArray && Array.isArray(toolsArray)) {
            convertedTools = this.convertOpenAIToolsToGemini(toolsArray);
        }

        if (cortexRequest?.tools && Array.isArray(cortexRequest.tools)) {
            const requestTools = this.convertOpenAIToolsToGemini(cortexRequest.tools);
            convertedTools = [...convertedTools, ...requestTools];
        }

        if (cortexRequest?.pathway?.tools && Array.isArray(cortexRequest.pathway.tools)) {
            const pathwayTools = this.convertOpenAIToolsToGemini(cortexRequest.pathway.tools);
            convertedTools = [...convertedTools, ...pathwayTools];
        }

        // Temporarily remove geminiTools from pathway to prevent override
        const originalGeminiTools = cortexRequest?.pathway?.geminiTools;
        if (cortexRequest?.pathway) {
            delete cortexRequest.pathway.geminiTools;
        }

        const baseParameters = super.getRequestParameters(text, parameters, prompt, cortexRequest);

        // Restore original geminiTools
        if (cortexRequest?.pathway && originalGeminiTools !== undefined) {
            cortexRequest.pathway.geminiTools = originalGeminiTools;
        }

        if (convertedTools.length > 0) {
            baseParameters.tools = convertedTools;
            
            // Handle tool_choice parameter - convert OpenAI format to Gemini toolConfig
            let toolChoice = parameters.tool_choice;
            if (typeof toolChoice === 'string' && toolChoice !== 'auto' && toolChoice !== 'none' && toolChoice !== 'required' && toolChoice !== 'any') {
                try {
                    toolChoice = JSON.parse(toolChoice);
                } catch (e) {
                    toolChoice = 'auto';
                }
            }
            
            if (toolChoice) {
                if (typeof toolChoice === 'string') {
                    if (toolChoice === 'auto') {
                        baseParameters.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
                    } else if (toolChoice === 'required' || toolChoice === 'any') {
                        baseParameters.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
                    } else if (toolChoice === 'none') {
                        baseParameters.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
                    }
                } else if (toolChoice.type === 'function') {
                    // Force specific function - use ANY mode with allowed function names
                    baseParameters.toolConfig = { 
                        functionCallingConfig: { 
                            mode: 'ANY',
                            allowedFunctionNames: [toolChoice.function.name || toolChoice.function]
                        } 
                    };
                }
            }
        }

        return baseParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        let result = null;
        try {
            result = await super.execute(text, parameters, prompt, cortexRequest);
        } catch (e) {
            const { data } = e;
            if (data && data.error) {
                if (data.error.code === 400 && data.error.message === 'Precondition check failed.') {
                    throw new Error('One or more of the included files is too large to process. Please try again with a smaller file.');
                }
            }
            throw e;
        }
        return result; 
    }

    // Override parseResponse to handle tool calls
    parseResponse(data) {
        if (!data) {
            return data;
        }

        // Handle streaming data (array of chunks)
        if (Array.isArray(data)) {
            // For streaming, we'll handle this in processStreamEvent
            return super.parseResponse(data);
        }

        // Handle non-streaming response with tool calls
        if (data.candidates && data.candidates[0]) {
            const candidate = data.candidates[0];
            const { content, finishReason, safetyRatings } = candidate;

            // Check for safety blocks
            if (safetyRatings?.some(rating => rating.blocked)) {
                const cortexResponse = new CortexResponse({
                    output_text: "\n\n*** Response blocked due to safety ratings ***",
                    finishReason: "content_filter",
                    usage: data.usageMetadata || null,
                    metadata: { model: this.modelName }
                });
                return cortexResponse;
            }

            // Check for tool calls
            if (content?.parts) {
                const toolCalls = [];
                let textContent = '';

                for (const part of content.parts) {
                    if (part.functionCall) {
                        toolCalls.push({
                            id: part.functionCall.name + '_' + Date.now(),
                            type: "function",
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {})
                            }
                        });
                    } else if (part.text) {
                        textContent += part.text;
                    }
                }

                // Create CortexResponse object
                const cortexResponse = new CortexResponse({
                    output_text: textContent,
                    finishReason: toolCalls.length > 0 ? "tool_calls" : (finishReason === "STOP" ? "stop" : "length"),
                    usage: data.usageMetadata || null,
                    metadata: { model: this.modelName }
                });

                if (toolCalls.length > 0) {
                    cortexResponse.toolCalls = toolCalls;
                }

                // Add citations to resolver for non-streaming responses
                const pathwayResolver = requestState[this.requestId]?.pathwayResolver;
                if (pathwayResolver && textContent) {
                    addCitationsToResolver(pathwayResolver, textContent);
                }

                return cortexResponse;
            }
        }

        // Fallback to parent implementation
        return super.parseResponse(data);
    }


    // Override processStreamEvent to handle tool calls
    processStreamEvent(event, requestProgress) {
        const eventData = JSON.parse(event.data);
        
        // Initialize requestProgress if needed
        requestProgress = requestProgress || {};
        requestProgress.data = requestProgress.data || null;
        
        // Reset tool calls flag for new stream
        if (!requestProgress.started) {
            this.hadToolCalls = false;
            this.toolCallsBuffer = [];
            // Don't clear contentBuffer here - it should accumulate across all chunks
            // this.contentBuffer = '';
        }
        
        // Create a helper function to generate message chunks
        const createChunk = (delta, finishReason = null) => ({
            id: eventData.responseId || `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{
                index: 0,
                delta,
                finish_reason: finishReason
            }]
        });

        // Handle content chunks with tool calls
        if (eventData.candidates?.[0]?.content?.parts) {
            const parts = eventData.candidates[0].content.parts;
            
            for (const part of parts) {
                if (part.functionCall) {
                    // Mark that we have tool calls
                    this.hadToolCalls = true;
                    
                    // Create tool call object
                    const toolCall = {
                        id: part.functionCall.name + '_' + Date.now(),
                        type: "function",
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args || {})
                        }
                    };
                    
                    this.toolCallsBuffer.push(toolCall);
                    
                    // Send tool call delta
                    requestProgress.data = JSON.stringify(createChunk({
                        tool_calls: [{
                            index: this.toolCallsBuffer.length - 1,
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: toolCall.function.arguments
                            }
                        }]
                    }));
                    
                } else if (part.text) {
                    // Regular text content
                    this.contentBuffer += part.text;
                    
                    if (!requestProgress.started) {
                        // First chunk - send role
                        requestProgress.data = JSON.stringify(createChunk({ role: "assistant" }));
                        requestProgress.started = true;
                    }
                    
                    // Send content chunk
                    requestProgress.data = JSON.stringify(createChunk({ 
                        content: part.text 
                    }));
                }
            }
        }

        // Handle finish reasons
        if (eventData.candidates?.[0]?.finishReason === "STOP") {
            const finishReason = this.hadToolCalls ? "tool_calls" : "stop";

            // Check if there's any remaining content in the final chunk that needs to be published
            if (eventData.candidates?.[0]?.content?.parts) {
                const parts = eventData.candidates[0].content.parts;
                for (const part of parts) {
                    if (part.text && part.text.trim()) {
                        // Send the final content chunk with finish reason
                        requestProgress.data = JSON.stringify(createChunk({ 
                            content: part.text 
                        }, finishReason));
                        break; // Only process the first text part
                    }
                }
            } else {
                // No content, just send finish chunk
                requestProgress.data = JSON.stringify(createChunk({}, finishReason));
            }

            const pathwayResolver = requestState[this.requestId]?.pathwayResolver;

            if (finishReason === 'tool_calls' && this.toolCallsBuffer.length > 0 && this.pathwayToolCallback && pathwayResolver) {
                // Filter out undefined elements from the tool calls buffer
                const validToolCalls = this.toolCallsBuffer.filter(tc => tc && tc.function && tc.function.name);
                // Execute tool callback and keep stream open
                const toolMessage = {
                    role: 'assistant',
                    content: this.contentBuffer || '',
                    tool_calls: validToolCalls,
                };
                this.pathwayToolCallback(pathwayResolver?.args, toolMessage, pathwayResolver);
                // Clear tool buffer after processing; keep content for citations/continuations
                this.toolCallsBuffer = [];
            } else {
                // Either regular stop, or tool_calls without a callback → close the stream
                requestProgress.progress = 1;
                addCitationsToResolver(pathwayResolver, this.contentBuffer);
                this.toolCallsBuffer = [];
                this.contentBuffer = '';
            }
        }

        // Handle safety blocks
        if (eventData.candidates?.[0]?.safetyRatings?.some(rating => rating.blocked)) {
            requestProgress.data = JSON.stringify(createChunk({ 
                content: "\n\n*** Response blocked due to safety ratings ***" 
            }, "content_filter"));
            requestProgress.progress = 1;
            // Clear buffers on safety block (same as OpenAI plugin)
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            return requestProgress;
        }

        // Handle prompt feedback blocks
        if (eventData.promptFeedback?.blockReason) {
            requestProgress.data = JSON.stringify(createChunk({ 
                content: `\n\n*** Response blocked: ${eventData.promptFeedback.blockReason} ***` 
            }, "content_filter"));
            requestProgress.progress = 1;
            // Clear buffers on prompt feedback block (same as OpenAI plugin)
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            return requestProgress;
        }

        return requestProgress;
    }

}

export default Gemini15VisionPlugin;
