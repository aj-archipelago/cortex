import Gemini15ChatPlugin from './gemini15ChatPlugin.js';
import CortexResponse from '../../lib/cortexResponse.js';
import { requestState } from '../requestState.js';
import { addCitationsToResolver } from '../../lib/pathwayTools.js';
import logger from '../../lib/logger.js';
import mime from 'mime-types';

function parseFunctionCallArgs(args) {
    if (typeof args !== 'string') {
        return args || {};
    }

    try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { value: parsed };
    } catch {
        return {};
    }
}

function normalizeGeminiFunctionCallArgs(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map((message) => {
        if (!Array.isArray(message?.parts)) return message;

        let changed = false;
        const parts = message.parts.map((part) => {
            const functionCall = part?.functionCall || part?.function_call;
            if (!functionCall || typeof functionCall.args !== 'string') return part;

            changed = true;
            const normalizedPart = { ...part };
            const key = part.functionCall ? 'functionCall' : 'function_call';
            normalizedPart[key] = {
                ...functionCall,
                args: parseFunctionCallArgs(functionCall.args),
            };
            return normalizedPart;
        });

        return changed ? { ...message, parts } : message;
    });
}

class Gemini15VisionPlugin extends Gemini15ChatPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.isMultiModal = true;
        this.pathwayToolCallback = pathway.toolCallback;
        this.toolCallsBuffer = [];
        this.contentBuffer = '';
        this.hadToolCalls = false;
        this._currentResponseId = null;
    }

    resolveMimeType(fileUrl, explicitMimeType = null, fallback = 'image/jpeg') {
        if (explicitMimeType) {
            return explicitMimeType;
        }

        if (!fileUrl) {
            return fallback;
        }

        try {
            const parsed = new URL(fileUrl);
            return mime.lookup(parsed.pathname) || mime.lookup(fileUrl) || fallback;
        } catch (e) {
            return mime.lookup(fileUrl) || fallback;
        }
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
            modifiedMessages = normalizeGeminiFunctionCallArgs(messages);
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

                // Handle assistant messages with tool_calls (OpenAI format → Gemini functionCall)
                if (role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
                    const parts = [];
                    // Add any text content first
                    if (content && typeof content === 'string' && content.trim()) {
                        parts.push({ text: content });
                    }
                    // Convert each tool_call to a Gemini functionCall part
                    for (const tc of message.tool_calls) {
                        if (tc?.function?.name) {
                            let args;
                            try {
                                args = typeof tc.function.arguments === 'string'
                                    ? JSON.parse(tc.function.arguments)
                                    : (tc.function.arguments || {});
                            } catch (e) {
                                args = {};
                            }
                            const fcPart = {
                                functionCall: {
                                    name: tc.function.name,
                                    args,
                                }
                            };
                            // Preserve thoughtSignature for Gemini 3+ models
                            if (tc.thoughtSignature) {
                                fcPart.thoughtSignature = tc.thoughtSignature;
                            }
                            parts.push(fcPart);
                        }
                    }
                    if (parts.length > 0) {
                        modifiedMessages.push({ role: 'model', parts });
                        lastAuthor = 'model';
                    }
                    return; // Skip normal content processing for this message
                }

                // Convert content to Gemini format, trying to maintain compatibility
                const convertPartToGemini = (inputPart) => {
                    try {
                        // First try to parse as JSON if it's a string
                        const part = typeof inputPart === 'string' ? JSON.parse(inputPart) : inputPart;
                        const {type, text, image_url, gcs, url, mimeType, mime_type} = part;
                        // Check for URL in multiple places: gcs, image_url.url, or direct url property
                        let fileUrl = gcs || image_url?.url || url;
                        const resolvedMimeType = this.resolveMimeType(
                            fileUrl,
                            mimeType || mime_type || image_url?.mimeType || image_url?.mime_type,
                        );

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
                                        mimeType: resolvedMimeType,
                                        fileUri: fileUrl
                                    }
                                };
                            } else if (fileUrl.includes('base64,')) {
                                const base64Data = fileUrl.split('base64,')[1];
                                if (!base64Data) {
                                    return null;
                                }
                                // Extract MIME type from data URL if available
                                const mimeMatch = fileUrl.match(/data:([^;]+);base64,/);
                                const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                                return {
                                    inlineData: {
                                        mimeType: mimeType,
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
                            } else if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
                                // Gemini can read directly from HTTP/HTTPS URLs using fileData with fileUri
                                // No need to fetch and convert to base64
                                return {
                                    fileData: {
                                        mimeType: resolvedMimeType,
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
                        
                        // Convert content array to string if needed (Gemini expects string content)
                        let toolContent = content;
                        if (Array.isArray(content)) {
                            toolContent = content
                                .map(item => typeof item === 'string' ? item : 
                                    (typeof item === 'object' && item?.text) ? item.text : 
                                    JSON.stringify(item))
                                .join('\n');
                        }
                        
                        modifiedMessages.push({
                            role: 'function',
                            parts: [{
                                functionResponse: {
                                    name: toolName,
                                    response: {
                                        content: toolContent
                                    }
                                }
                            }]
                        });
                        lastAuthor = 'function';
                    }
                    // Gemini only supports user: and model: roles
                    else if (role === 'user' || role === 'assistant' || author) {
                        // Convert 'assistant' to 'model' for Gemini API compatibility
                        const geminiRole = author || (role === 'assistant' ? 'model' : role);
                        modifiedMessages.push({
                            role: geminiRole,
                            parts: [geminiPart],
                        });
                        lastAuthor = geminiRole;
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
    
        modifiedMessages = normalizeGeminiFunctionCallArgs(modifiedMessages);

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

    // Recursively convert numeric enums to string enums for Gemini compatibility
    convertEnumToStrings(schema) {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }

        // Create a deep copy to avoid mutating the original
        const converted = Array.isArray(schema) ? [...schema] : { ...schema };

        // Convert enum if it exists and contains numbers
        if (converted.enum && Array.isArray(converted.enum)) {
            converted.enum = converted.enum.map(value => {
                // Convert numbers to strings, keep strings as-is
                return typeof value === 'number' ? String(value) : value;
            });
        }

        // Recursively process nested objects
        if (converted.properties && typeof converted.properties === 'object') {
            converted.properties = Object.fromEntries(
                Object.entries(converted.properties).map(([key, value]) => [
                    key,
                    this.convertEnumToStrings(value)
                ])
            );
        }

        // Recursively process array items
        if (converted.items && typeof converted.items === 'object') {
            converted.items = this.convertEnumToStrings(converted.items);
        }

        // Recursively process anyOf, oneOf, allOf arrays
        ['anyOf', 'oneOf', 'allOf'].forEach(key => {
            if (converted[key] && Array.isArray(converted[key])) {
                converted[key] = converted[key].map(item => this.convertEnumToStrings(item));
            }
        });

        return converted;
    }

    // Strip/normalize JSON Schema fields not accepted by Gemini function declarations
    sanitizeSchemaForGemini(schema) {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }

        if (Array.isArray(schema)) {
            return schema.map(item => this.sanitizeSchemaForGemini(item));
        }

        const cleaned = {};

        for (const [key, value] of Object.entries(schema)) {
            if (key === '$schema' || key === 'propertyNames') {
                continue;
            }

            if (key === 'const') {
                cleaned.enum = [value];
                continue;
            }

            if (key === 'exclusiveMinimum') {
                cleaned.minimum = value;
                continue;
            }

            if (key === 'exclusiveMaximum') {
                cleaned.maximum = value;
                continue;
            }

            // Normalize JSON Schema type arrays into Gemini's Schema shape:
            // nullable tuples become nullable, and multi-type unions become anyOf.
            if (key === 'type' && Array.isArray(value)) {
                const nonNull = value.filter(t => t !== 'null');
                if (value.length !== nonNull.length) {
                    cleaned.nullable = true;
                }
                if (nonNull.length === 1) {
                    cleaned.type = nonNull[0];
                } else if (nonNull.length > 1) {
                    cleaned.anyOf = nonNull.map(type => ({ type }));
                }
                continue;
            }

            cleaned[key] = this.sanitizeSchemaForGemini(value);
        }

        return cleaned;
    }

    // Convert OpenAI tools to Gemini format
    convertOpenAIToolsToGemini(openAITools) {
        if (!openAITools || !Array.isArray(openAITools)) {
            return [];
        }

        // Convert OpenAI tools to Gemini functionDeclarations format
        const functionDeclarations = openAITools.map(tool => {
            if (tool.type === 'function' && tool.function) {
                const parameters = tool.function.parameters || {
                    type: 'object',
                    properties: {},
                    required: []
                };
                
                // Convert numeric enums to string enums for Gemini compatibility
                const sanitizedParameters = this.sanitizeSchemaForGemini(parameters);
                const convertedParameters = this.convertEnumToStrings(sanitizedParameters);
                
                return {
                    name: tool.function.name,
                    description: tool.function.description || `Tool for ${tool.function.name}`,
                    parameters: convertedParameters
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
        
        if (toolsArray && Array.isArray(toolsArray) && toolsArray.length > 0) {
            convertedTools = this.convertOpenAIToolsToGemini(toolsArray);
        }

        const baseParameters = super.getRequestParameters(text, parameters, prompt, cortexRequest);

        // Handle tool_choice parameter - convert OpenAI format to Gemini toolConfig
        let toolChoice = parameters.tool_choice;
        if (typeof toolChoice === 'string' && toolChoice !== 'auto' && toolChoice !== 'none' && toolChoice !== 'required' && toolChoice !== 'any') {
            try {
                toolChoice = JSON.parse(toolChoice);
            } catch (e) {
                toolChoice = 'auto';
            }
        }

        if (convertedTools[0]?.functionDeclarations?.length > 0) {
            baseParameters.tools = convertedTools;
            
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
        } else if (toolChoice === 'none') {
            // Even when no tools are provided, if tool_choice is 'none', explicitly disable function calling
            // This prevents MALFORMED_FUNCTION_CALL errors when chat history contains function messages
            baseParameters.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
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

    // Build a toolCall object from a Gemini functionCall response
    // Override in subclasses to capture model-specific fields (e.g., thoughtSignature for Gemini 3+)
    buildToolCallFromFunctionCall(part) {
        return {
            id: part.functionCall.name + '_' + Date.now(),
            type: "function",
            function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
            }
        };
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

        if (data.promptFeedback?.blockReason) {
            return new CortexResponse({
                output_text: `\n\n*** Response blocked: ${data.promptFeedback.blockReason} ***`,
                finishReason: "content_filter",
                usage: data.usageMetadata || null,
                metadata: { model: this.modelName }
            });
        }

        // Handle non-streaming response with tool calls
        if (data.candidates && data.candidates[0]) {
            const candidate = data.candidates[0];
            const { content, finishReason, safetyRatings } = candidate;

            // Check for safety blocks
            if (finishReason === 'SAFETY' || safetyRatings?.some(rating => rating.blocked)) {
                const cortexResponse = new CortexResponse({
                    output_text: "\n\n*** Response blocked due to safety ratings ***",
                    finishReason: "content_filter",
                    usage: data.usageMetadata || null,
                    metadata: { model: this.modelName }
                });
                return cortexResponse;
            }

            if (finishReason === 'UNEXPECTED_TOOL_CALL') {
                const textContent = content?.parts?.find(part => part?.text)?.text || '';
                const finishMessage = candidate.finishMessage || 'Model tried to call an undeclared function';
                logger.warn(`Gemini returned UNEXPECTED_TOOL_CALL: ${finishMessage}`);
                return new CortexResponse({
                    output_text: textContent || 'I encountered an issue processing that request. Please try rephrasing your question.',
                    finishReason: "stop",
                    usage: data.usageMetadata || null,
                    metadata: { model: this.modelName }
                });
            }

            // Check for tool calls
            if (content?.parts) {
                const toolCalls = [];
                let textContent = '';

                for (const part of content.parts) {
                    if (part.functionCall) {
                        // Use hook method to build toolCall (allows override for Gemini 3+ thoughtSignature)
                        toolCalls.push(this.buildToolCallFromFunctionCall(part));
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

            // Handle MALFORMED_FUNCTION_CALL - model tried to call a function but generated invalid JSON
            if (finishReason === 'MALFORMED_FUNCTION_CALL') {
                const textContent = content?.parts?.[0]?.text || '';
                logger.warn(`Gemini returned MALFORMED_FUNCTION_CALL, returning graceful response`);
                return new CortexResponse({
                    output_text: textContent || 'I encountered an issue processing that request. Please try rephrasing your question.',
                    finishReason: "stop",
                    usage: data.usageMetadata || null,
                    metadata: { model: this.modelName }
                });
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
        
        // Reset state for a genuinely new stream (new responseId = new model response).
        // Gemini includes a unique responseId in every SSE event of the same response.
        // Only reset when a NEW responseId is seen, so tool calls accumulate across
        // events within the same model response (e.g. Gemini 3.5 Flash sends each
        // functionCall as a separate SSE event).
        const responseId = eventData.responseId;
        if (responseId && responseId !== this._currentResponseId) {
            this._currentResponseId = responseId;
            this.hadToolCalls = false;
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
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
                    
                    // Use hook method to build toolCall (allows override for Gemini 3+ thoughtSignature)
                    const toolCall = this.buildToolCallFromFunctionCall(part);
                    
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
            let sentFinalChunk = false;
            if (eventData.candidates?.[0]?.content?.parts) {
                const parts = eventData.candidates[0].content.parts;
                for (const part of parts) {
                    if (part.text && part.text.trim()) {
                        // Send the final content chunk with finish reason
                        requestProgress.data = JSON.stringify(createChunk({
                            content: part.text
                        }, finishReason));
                        sentFinalChunk = true;
                        break; // Only process the first text part
                    }
                }
            }
            if (!sentFinalChunk) {
                // If we have tool calls, include them in the finish chunk
                // (Gemini often sends functionCall and finishReason in the same event)
                // Filter out undefined elements before mapping
                const validToolCallsForChunk = this.toolCallsBuffer.filter(tc => tc && tc.function);
                if (this.hadToolCalls && validToolCallsForChunk.length > 0) {
                    requestProgress.data = JSON.stringify(createChunk({
                        tool_calls: validToolCallsForChunk.map((tc, index) => ({
                            index,
                            id: tc.id,
                            type: tc.type,
                            function: tc.function
                        }))
                    }, finishReason));
                } else {
                    // No final text content, just send finish chunk
                    requestProgress.data = JSON.stringify(createChunk({}, finishReason));
                }
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
                // Signal to pathwayResolver that stream close is expected (tool callback invoked)
                requestProgress.toolCallbackInvoked = true;
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

        // Handle MALFORMED_FUNCTION_CALL - model tried to call a function but generated invalid JSON
        if (eventData.candidates?.[0]?.finishReason === "MALFORMED_FUNCTION_CALL") {
            logger.warn(`Gemini streaming returned MALFORMED_FUNCTION_CALL`);
            requestProgress.data = JSON.stringify(createChunk({
                content: '\n\nI encountered an issue processing that request. Please try rephrasing your question.'
            }, "stop"));
            requestProgress.progress = 1;
            // Clear buffers
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            return requestProgress;
        }

        // Handle UNEXPECTED_TOOL_CALL - model tried to call a function not in the declared tools
        if (eventData.candidates?.[0]?.finishReason === "UNEXPECTED_TOOL_CALL") {
            const finishMessage = eventData.candidates[0].finishMessage || 'Model tried to call an undeclared function';
            logger.warn(`Gemini streaming returned UNEXPECTED_TOOL_CALL: ${finishMessage}`);
            requestProgress.data = JSON.stringify(createChunk({
                content: '\n\nI encountered an issue processing that request. Please try rephrasing your question.'
            }, "stop"));
            requestProgress.progress = 1;
            // Clear buffers - don't dispatch the invalid tool call
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            return requestProgress;
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
