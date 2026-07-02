import { ModelExecutor } from './modelExecutor.js';
import { modelEndpoints, resolveModelName } from '../lib/requestExecutor.js';
import { v4 as uuidv4 } from 'uuid';
import { encode } from '../lib/encodeCache.js';
import { getFirstNToken, getLastNToken, getSemanticChunks } from './chunker.js';
import { PathwayResponseParser } from './pathwayResponseParser.js';
import { Prompt } from './prompt.js';
import { getv, setv } from '../lib/keyValueStorageClient.js';
import { getvWithDoubleDecryption, setvWithDoubleEncryption } from '../lib/keyValueStorageClient.js';
import { requestState } from './requestState.js';
import { normalizeUsage } from './rest/restUtils.js';
import { callPathway, addCitationsToResolver } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';
import { clearPendingMessages } from './pendingUserMessages.js';
import { publishRequestProgress } from '../lib/redisSubscription.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import { createParser } from 'eventsource-parser';
import CortexResponse from '../lib/cortexResponse.js';
import latencyTrace from '../lib/latencyTrace.js';

const modelTypesExcludedFromProgressUpdates = ['OPENAI-DALLE2', 'OPENAI-DALLE3'];

const extractTextFromStreamData = (data) => {
    if (!data || typeof data !== 'string') return '';

    try {
        const parsed = JSON.parse(data);
        const deltaContent = parsed?.choices?.[0]?.delta?.content;
        if (typeof deltaContent === 'string') return deltaContent;
        const text = parsed?.choices?.[0]?.text;
        if (typeof text === 'string') return text;
    } catch {
        return data;
    }

    return '';
};

class PathwayResolver {
    // Optional endpoints override parameter is for testing purposes
    constructor({ config, pathway, args, endpoints }) {
        this.endpoints = endpoints || modelEndpoints;
        this.config = config;
        this.pathway = pathway;
        this.args = args;
        this.useInputChunking = pathway.useInputChunking;
        this.chunkMaxTokenLength = 0;
        this.warnings = [];
        this.errors = [];
        this.requestId = uuidv4();
        this.rootRequestId = null;
        this.responseParser = new PathwayResponseParser(pathway);
        this.pathwayResultData = {};
        this.modelName = [
            pathway.model,
            args?.model,
            pathway.inputParameters?.model,
            config.get('defaultModelName')
            ].map(name => name ? resolveModelName(name) : name)
            .find(modelName => modelName && Object.prototype.hasOwnProperty.call(this.endpoints, modelName));
        this.model = this.endpoints[this.modelName];

        if (!this.model) {
            throw new Error(`Model ${this.modelName} not found in config`);
        }

        const specifiedModelName = pathway.model || args?.model || pathway.inputParameters?.model;

        if (this.modelName !== (specifiedModelName)) {
            if (specifiedModelName) {
                const modelGroups = config.get('modelGroups') || {};
                const isResolvedModelGroup = Object.prototype.hasOwnProperty.call(modelGroups, specifiedModelName)
                    && resolveModelName(specifiedModelName) === this.modelName;
                if (!isResolvedModelGroup) {
                    this.logWarning(`Specified model ${specifiedModelName} not found in config, using ${this.modelName} instead.`);
                }
            } else {
                this.logWarning(`No model specified in the pathway, using ${this.modelName}.`);
            }
        }

        this.previousResult = '';
        this.prompts = [];
        this.modelExecutor = new ModelExecutor(this.pathway, this.model);

        Object.defineProperty(this, 'pathwayPrompt', {
            get() {
                return this.prompts
            },
            set(value) {
                if (!Array.isArray(value)) {
                    value = [value];
                }
                this.prompts = value.map(p => (p instanceof Prompt) ? p : new Prompt({ prompt:p }));
                this.chunkMaxTokenLength = this.getChunkMaxTokenLength();
            }
        });

        // set up initial prompt
        this.pathwayPrompt = pathway.prompt;

        latencyTrace.mark('resolver.created', {
            requestId: this.requestId,
            pathway: this.pathway?.name,
            model: this.modelName,
            stream: Boolean(args?.stream),
            async: Boolean(args?.async),
            chatHistoryLength: Array.isArray(args?.chatHistory) ? args.chatHistory.length : undefined,
            tools: Array.isArray(args?.entityToolsOpenAiFormat) ? args.entityToolsOpenAiFormat.length : undefined,
        });
    }
    
    // Legacy 'tool' property is now stored in pathwayResultData
    get tool() {      
        // Select fields to serialize for legacy compat, excluding undefined values
        const legacyFields = Object.fromEntries(
            Object.entries({
                hideFromModel: this.pathwayResultData.hideFromModel,    
                toolCallbackName: this.pathwayResultData.toolCallbackName, 
                title: this.pathwayResultData.title,
                search: this.pathwayResultData.search,
                toolCallbackId: this.pathwayResultData.toolCallbackId,
                toolUsed: this.pathwayResultData.toolUsed,
                citations: this.pathwayResultData.citations,

            }).filter(([_, value]) => value !== undefined)
        );
        return JSON.stringify(legacyFields);
    }

    set tool(value) {
        // Accepts a JSON string, parses, merges into pathwayResultData
        let parsed;
        try {
            parsed = (typeof value === 'string') ? JSON.parse(value) : value;
            this.pathwayResultData = this.mergeResultData(parsed);
        } catch (e) {
            // Optionally warn: invalid format or merge error
            console.warn('Invalid tool property assignment:', e);
        }
    }

    /**
     * Check if this request has been canceled. Checks both the direct
     * requestId and rootRequestId (for nested/child requests).
     */
    isCanceled() {
        return !!(
            (requestState[this.requestId] || {}).canceled ||
            (this.rootRequestId && (requestState[this.rootRequestId] || {}).canceled)
        );
    }

    publishNestedRequestProgress(requestProgress) {

        if (this.rootRequestId) {
            // if this is a nested request, don't end the stream
            if (requestProgress.progress === 1) {
                delete requestProgress.progress;
            }
            publishRequestProgress(requestProgress);
        } else {
            // this is a root request, so we add the pathwayResultData to the info
            // and allow the end stream message to be sent
            if (requestProgress.progress === 1) {
                const infoObject = { ...this.pathwayResultData || {} };
                requestProgress.info = JSON.stringify(infoObject);
                requestProgress.error = requestProgress.error || this.errors.join(', ') || '';
            }
            publishRequestProgress(requestProgress);
        }

    }

    // This code handles async and streaming responses for either long-running
    // tasks or streaming model responses
    async asyncResolve(args) {
        const span = latencyTrace.start('resolver.asyncResolve', {
            requestId: this.requestId,
            rootRequestId: this.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
        });
        let responseData = null;

        try {
            responseData = await this.executePathway(args);
        }
        catch (error) {
            this.errors.push(error.message || error.toString());
            publishRequestProgress({
                requestId: this.rootRequestId || this.requestId,
                progress: 1,
                data: '',
                info: '',
                error: this.errors.join(', ')
            });
            latencyTrace.end(span, { responseKind: 'error', errors: this.errors.length });
            return;
        }

        if (!responseData) {
            publishRequestProgress({
                requestId: this.rootRequestId || this.requestId,
                progress: 1,
                data: '',
                info: '',
                error: this.errors.join(', ')
            });
            latencyTrace.end(span, { responseKind: 'empty', errors: this.errors.length });
            return;
        }

        // Handle CortexResponse objects - merge them into pathwayResultData
        if (responseData && typeof responseData === 'object' && responseData.constructor && responseData.constructor.name === 'CortexResponse') {
            this.pathwayResultData = this.mergeResultData(responseData);
        }

        // If the response is a stream, handle it as streaming response
        if (responseData && typeof responseData.on === 'function') {
            await this.handleStream(responseData);
        } else {
            const { completedCount = 1, totalCount = 1 } = requestState[this.requestId];
            requestState[this.requestId].data = responseData;
            
            // some models don't support progress updates
            if (!modelTypesExcludedFromProgressUpdates.includes(this.model.type)) {
                const infoObject = { ...this.pathwayResultData || {} };
                this.publishNestedRequestProgress({
                        requestId: this.rootRequestId || this.requestId,
                        progress: Math.min(completedCount, totalCount) / totalCount,
                        // Clients expect these to be strings
                        data: JSON.stringify(responseData || ''),
                        info: JSON.stringify(infoObject) || '',
                        error: this.errors.join(', ') || ''
                });
            }
        }

        latencyTrace.end(span, {
            responseKind: responseData && typeof responseData.on === 'function' ? 'stream' : typeof responseData,
            errors: this.errors.length,
        });
    }

    mergeResolver(otherResolver) {
        if (otherResolver) {
            this.previousResult = otherResolver.previousResult ? otherResolver.previousResult : this.previousResult;
            this.warnings = [...this.warnings, ...otherResolver.warnings];
            this.errors = [...this.errors, ...otherResolver.errors];

            // Use the shared mergeResultData method
            this.pathwayResultData = this.mergeResultData(otherResolver.pathwayResultData);
        }
    }

    // Merge pathwayResultData with either another pathwayResultData object or a CortexResponse
    mergeResultData(newData) {
        if (!newData) return this.pathwayResultData;

        const currentData = this.pathwayResultData || {};

        // Handle CortexResponse objects
        if (newData.constructor && newData.constructor.name === 'CortexResponse') {
            const cortexResponse = newData;
            const cortexData = {
                citations: cortexResponse.citations,
                toolCalls: cortexResponse.toolCalls,
                functionCall: cortexResponse.functionCall,
                usage: cortexResponse.usage,
                finishReason: cortexResponse.finishReason,
                artifacts: cortexResponse.artifacts
            };
            newData = cortexData;
        }

        // Create merged result
        const merged = { ...currentData, ...newData };

        // Handle array fields that should be concatenated
        const arrayFields = ['citations', 'toolCalls', 'artifacts'];
        for (const field of arrayFields) {
            const currentArray = currentData[field] || [];
            const newArray = newData[field] || [];
            if (newArray.length > 0) {
                merged[field] = [...currentArray, ...newArray];
            } else if (currentArray.length > 0) {
                merged[field] = currentArray;
            }
        }

        // Handle usage and toolUsed data - convert to arrays with most recent first
        const createArrayFromData = (currentValue, newValue) => {
            if (!currentValue && !newValue) return null;

            const array = [];

            // Add new value first (most recent)
            if (newValue) {
                if (Array.isArray(newValue)) {
                    array.push(...newValue);
                } else {
                    array.push(newValue);
                }
            }

            // Add current value second (older)
            if (currentValue) {
                if (Array.isArray(currentValue)) {
                    array.push(...currentValue);
                } else {
                    array.push(currentValue);
                }
            }

            return array;
        };

        const usageArray = createArrayFromData(currentData.usage, newData.usage);
        if (usageArray) {
            merged.usage = usageArray;
        }

        const toolUsedArray = createArrayFromData(currentData.toolUsed, newData.toolUsed);
        if (toolUsedArray) {
            merged.toolUsed = toolUsedArray;
        }

        return merged;
    }

    captureStreamUsage(payload) {
        if (!payload || typeof payload !== 'string' || payload.trim() === '[DONE]') {
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return;
        }

        const rawUsage = parsed.usage
            || parsed.message?.usage
            || parsed.response?.usage
            || parsed.usageMetadata
            || parsed.response?.usageMetadata;
        const usage = normalizeUsage(rawUsage);
        if (!usage) return;

        const current = this._streamUsage || {};
        const mergedUsage = {
            ...current,
            ...usage,
        };
        if (mergedUsage.total_tokens == null
            && mergedUsage.input_tokens != null
            && mergedUsage.output_tokens != null) {
            mergedUsage.total_tokens = mergedUsage.input_tokens + mergedUsage.output_tokens;
        }

        this._streamUsage = mergedUsage;
        this.pathwayResultData = {
            ...(this.pathwayResultData || {}),
            usage: [mergedUsage],
        };
    }

    async handleStream(response) {
        const requestId = this.rootRequestId || this.requestId;
        const span = latencyTrace.start('stream.read', {
            requestId,
            resolverRequestId: this.requestId,
            pathway: this.pathway?.name,
            model: this.modelName,
        });
        let streamErrorOccurred = false;
        let streamErrorMessage = null;
        let completionSent = false;
        let receivedSSEData = false; // Track if we actually received SSE events
        let receivedAnyData = false; // Track if we received ANY data from the stream
        let toolCallbackInvoked = false; // Track if a tool callback was invoked (stream close is expected)
        let firstChunkLogged = false;
        let firstSSELogged = false;
        let firstPublishLogged = false;
        let dataChunkCount = 0;
        let sseEventCount = 0;
        let publishedEventCount = 0;
        this.toolCallbackInvoked = false; // Expose to callers (e.g., agent loop) so they know not to race
        // Accumulate streamed content for continuity memory
        this.streamedContent = '';

        if (response && typeof response.on === 'function') {
            try {
                const incomingMessage = response;
                let streamEnded = false;
                const existingAbortRequest = requestState[requestId]?.abortRequest;
                const abortStream = () => {
                    if (typeof existingAbortRequest === 'function') {
                        existingAbortRequest();
                    }
                    if (!streamEnded && typeof incomingMessage.destroy === 'function') {
                        incomingMessage.destroy(new Error('Request canceled'));
                    }
                };
                requestState[requestId] = {
                    ...requestState[requestId],
                    abortRequest: abortStream,
                };
                const clearAbortStream = () => {
                    if (requestState[requestId]?.abortRequest === abortStream) {
                        delete requestState[requestId].abortRequest;
                    }
                };
                let finishStreamRead = null;

                const onParse = (event) => {
                    let requestProgress = {
                        requestId
                    };

                    logger.debug(`Received event: ${event.type}`);

                    if (event.type === 'event') {
                        logger.debug('Received event!')
                        logger.debug(`id: ${event.id || '<none>'}`)
                        logger.debug(`name: ${event.name || '<none>'}`)
                        logger.debug(`data: ${event.data}`)

                        receivedSSEData = true; // Only mark SSE data when we get actual 'event' type
                        sseEventCount++;
                        if (!firstSSELogged) {
                            firstSSELogged = true;
                            latencyTrace.mark('stream.firstSSE', {
                                requestId,
                                resolverRequestId: this.requestId,
                                pathway: this.pathway?.name,
                                model: this.modelName,
                            });
                        }

                        // Check for error events in the stream data
                        try {
                            const eventData = JSON.parse(event.data);
                            if (eventData.error) {
                                streamErrorOccurred = true;
                                streamErrorMessage = eventData.error.message || JSON.stringify(eventData.error);
                                logger.error(`Stream contained error event: ${streamErrorMessage}`);
                            }
                        } catch {
                            // Not JSON or no error field, continue normal processing
                        }
                    } else if (event.type === 'reconnect-interval') {
                        logger.debug(`We should set reconnect interval to ${event.value} milliseconds`)
                    }

                    try {
                        requestProgress = this.modelExecutor.plugin.processStreamEvent(event, requestProgress);
                        this.captureStreamUsage(event.data);
                        if (requestProgress?.data && requestProgress.data !== event.data) {
                            this.captureStreamUsage(requestProgress.data);
                        }
                        if (requestProgress?.error) {
                            streamErrorOccurred = true;
                            streamErrorMessage = requestProgress.error;
                        }
                        const streamedText = extractTextFromStreamData(requestProgress?.data);
                        if (streamedText) {
                            this.streamedContent += streamedText;
                        }
                        // Check if plugin signaled a tool callback was invoked
                        if (requestProgress.toolCallbackInvoked) {
                            toolCallbackInvoked = true;
                            this.toolCallbackInvoked = true;
                            latencyTrace.mark('stream.toolCallbackInvoked', {
                                requestId,
                                resolverRequestId: this.requestId,
                                pathway: this.pathway?.name,
                                model: this.modelName,
                            });
                        }
                    } catch (error) {
                        streamErrorOccurred = true;
                        streamErrorMessage = error instanceof Error ? error.message : String(error);
                        logger.error(`Stream processing error: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
                        incomingMessage.off('data', processStream);
                        finishStreamRead && finishStreamRead();
                        return;
                    }

                    try {
                        if (!streamEnded && requestProgress.data) {
                            publishedEventCount++;
                            if (!firstPublishLogged) {
                                firstPublishLogged = true;
                                latencyTrace.mark('stream.firstPublish', {
                                    requestId,
                                    resolverRequestId: this.requestId,
                                    pathway: this.pathway?.name,
                                    model: this.modelName,
                                    progress: requestProgress.progress,
                                });
                            }
                            this.publishNestedRequestProgress(requestProgress);
                            streamEnded = requestProgress.progress === 1;
                            if (streamEnded) {
                                completionSent = true;
                                incomingMessage.off('data', processStream);
                                if (typeof incomingMessage.destroy === 'function') {
                                    incomingMessage.destroy();
                                }
                                finishStreamRead && finishStreamRead();
                            }
                        } else if (!streamEnded && requestProgress.progress === 1 && !toolCallbackInvoked) {
                            publishedEventCount++;
                            if (!firstPublishLogged) {
                                firstPublishLogged = true;
                                latencyTrace.mark('stream.firstPublish', {
                                    requestId,
                                    resolverRequestId: this.requestId,
                                    pathway: this.pathway?.name,
                                    model: this.modelName,
                                    progress: requestProgress.progress,
                                });
                            }
                            this.publishNestedRequestProgress({
                                ...requestProgress,
                                data: '',
                            });
                            streamEnded = true;
                            completionSent = true;
                            incomingMessage.off('data', processStream);
                            if (typeof incomingMessage.destroy === 'function') {
                                incomingMessage.destroy();
                            }
                            finishStreamRead && finishStreamRead();
                        }
                    } catch (error) {
                        logger.error(`Could not publish the stream message: "${event.data}", ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
                    }

                }
                
                const sseParser = createParser(onParse);

                const processStream = (data) => {
                    receivedAnyData = true; // Track that we got data from the stream
                    dataChunkCount++;
                    if (!firstChunkLogged) {
                        firstChunkLogged = true;
                        if (response._cortexTtfbMonitor && response._cortexTtfbStart) {
                            response._cortexTtfbMonitor.recordTTFB(
                                Date.now() - response._cortexTtfbStart,
                                response._cortexTtfbSource || 'live',
                            );
                        }
                        latencyTrace.mark('stream.firstChunk', {
                            requestId,
                            resolverRequestId: this.requestId,
                            pathway: this.pathway?.name,
                            model: this.modelName,
                            bytes: data?.length,
                        });
                    }
                    sseParser.feed(data.toString());
                }

                if (incomingMessage) {
                    try {
                        await new Promise((resolve, reject) => {
                            let settled = false;
                            const resolveOnce = () => {
                                if (settled) {
                                    return;
                                }
                                settled = true;
                                resolve();
                            };
                            const rejectOnce = (err) => {
                                if (settled) {
                                    return;
                                }
                                settled = true;
                                reject(err);
                            };
                            finishStreamRead = resolveOnce;
                            incomingMessage.on('data', processStream);
                            incomingMessage.on('end', resolveOnce);
                            incomingMessage.on('error', (err) => {
                                if (this.isCanceled()) {
                                    resolveOnce();
                                    return;
                                }
                                streamErrorOccurred = true;
                                streamErrorMessage = err instanceof Error ? err.message : String(err);
                                rejectOnce(err);
                            });
                            incomingMessage.on('close', () => {
                                if (this.isCanceled()) {
                                    resolveOnce();
                                    return;
                                }
                                // Stream closed - detect various incomplete states
                                if (!receivedAnyData && !streamErrorOccurred && !toolCallbackInvoked) {
                                    // Stream opened but closed with NO data at all - this is likely a provider issue
                                    logger.warn('Stream closed with no data received (empty stream)');
                                } else if (receivedSSEData && !completionSent && !streamErrorOccurred && !toolCallbackInvoked) {
                                    // Got SSE data but no completion signal
                                    logger.warn('Stream closed before terminal event; final usage may be missing');
                                }
                                resolveOnce();
                            });
                        });
                    } finally {
                        finishStreamRead = null;
                        clearAbortStream();
                    }
                }

            } catch (error) {
                streamErrorOccurred = true;
                if (!streamErrorMessage) {
                    streamErrorMessage = error instanceof Error ? error.message : String(error);
                }
                logger.error(`Could not subscribe to stream: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
            }

            // Safety net: if the stream ended without a finishReason but the plugin
            // has pending tool calls that were never dispatched, dispatch them now.
            // This handles edge-case models that never send finishReason: "STOP".
            if (!toolCallbackInvoked && !completionSent && !streamErrorOccurred) {
                const plugin = this.modelExecutor.plugin;
                if (plugin.hadToolCalls && plugin.toolCallsBuffer?.length > 0 && plugin.pathwayToolCallback) {
                    const validToolCalls = plugin.toolCallsBuffer.filter(tc => tc?.function?.name);
                    if (validToolCalls.length > 0) {
                        const toolMessage = {
                            role: 'assistant',
                            content: plugin.contentBuffer || '',
                            tool_calls: validToolCalls,
                        };
                        plugin.pathwayToolCallback(this.args, toolMessage, this);
                        toolCallbackInvoked = true;
                        this.toolCallbackInvoked = true;
                        latencyTrace.mark('stream.toolCallbackInvoked', {
                            requestId,
                            resolverRequestId: this.requestId,
                            pathway: this.pathway?.name,
                            model: this.modelName,
                            source: 'safetyNet',
                        });
                        plugin.toolCallsBuffer = [];
                    }
                }
            }

            // Detect empty stream (opened but closed with no data) - this should be retried
            const emptyStream = !receivedAnyData && !streamErrorOccurred && !toolCallbackInvoked;

            // Ensure completion is sent if not already done
            // Send completion if:
            // 1. Stream error occurred (always notify client of errors)
            // 2. OR we received SSE data but no completion was sent (and no tool callback)
            // 3. OR empty stream (will only happen if retry logic exhausted - see executePathway)
            // Don't send completion if a tool callback was invoked (stream will resume)
            const shouldSendCompletion = !toolCallbackInvoked && !completionSent &&
                (streamErrorOccurred || receivedSSEData);

            if (shouldSendCompletion) {
                if (streamErrorOccurred) {
                    logger.error(`Stream read failed: ${streamErrorMessage}`);
                }
                const errorMessage = streamErrorOccurred
                    ? (streamErrorMessage || this.errors.join(', ') || 'Stream read failed')
                    : '';
                this.publishNestedRequestProgress({
                    requestId,
                    progress: 1,
                    data: '',
                    info: JSON.stringify(this.pathwayResultData || {}),
                    error: errorMessage
                });
                completionSent = true;
                publishedEventCount++;
            }

            // Return stream result for retry logic
            latencyTrace.end(span, {
                success: completionSent || toolCallbackInvoked,
                emptyStream,
                streamErrorOccurred,
                completionSent,
                toolCallbackInvoked,
                dataChunkCount,
                sseEventCount,
                publishedEventCount,
            });
            return {
                success: completionSent || toolCallbackInvoked,
                emptyStream,
                error: streamErrorOccurred ? streamErrorMessage : null
            };
        }

        // Non-stream response
        latencyTrace.end(span, { success: true, emptyStream: false, nonStream: true });
        return { success: true, emptyStream: false, error: null };
    }

    async resolve(args) {
        const span = latencyTrace.start('resolver.resolve', {
            requestId: this.requestId,
            rootRequestId: args?.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
            stream: Boolean(args?.stream),
            async: Boolean(args?.async),
        });
        // Either we're dealing with an async request, stream, or regular request
        if (args.async || args.stream) {
            if (!requestState[this.requestId]) {
                requestState[this.requestId] = {}
            }
            this.rootRequestId = args.rootRequestId ?? null;
            requestState[this.requestId] = { ...requestState[this.requestId], args, resolver: this.asyncResolve.bind(this), pathwayResolver: this };
            latencyTrace.end(span, { returnedRequestId: true });
            return this.requestId;
        }
        else {
            // Syncronously process the request
            try {
                return await this.executePathway(args);
            } finally {
                latencyTrace.end(span, { returnedRequestId: false });
            }
        }
    }

    async executePathway(args) {
        const span = latencyTrace.start('resolver.executePathway', {
            requestId: this.requestId,
            rootRequestId: this.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
            customExecutePathway: Boolean(this.pathway.executePathway),
        });
        if (this.pathway.executePathway && typeof this.pathway.executePathway === 'function') {
            try {
                return await this.pathway.executePathway({ args, runAllPrompts: this.promptAndParse.bind(this), resolver: this });
            } finally {
                latencyTrace.end(span);
            }
        }
        else {
            try {
                return await this.promptAndParse(args);
            } finally {
                latencyTrace.end(span);
            }
        }
    }

    async promptAndParse(args) {
        const span = latencyTrace.start('resolver.promptAndParse', {
            requestId: this.requestId,
            rootRequestId: this.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
            stream: Boolean(args?.stream),
            async: Boolean(args?.async),
        });
        // Reset per-call flag — will be set by handleStream() if a tool callback fires
        this.toolCallbackInvoked = false;

        // Check if model is specified in args and swap if different from current model
        if (args.modelOverride && args.modelOverride !== this.modelName) {
            try {
                this.swapModel(args.modelOverride);
            } catch (error) {
                this.logError(`Failed to swap model to ${args.modelOverride}: ${error.message}`);
            }
        }

        // Get saved context from contextId or change contextId if needed
        const { contextId, useMemory } = args;
        this.savedContextId = contextId ? contextId : uuidv4();
        
        // Check if memory is enabled (default true for backward compatibility)
        const memoryEnabled = useMemory !== false;
        
        const loadMemory = async () => {
            try {
                // Always load savedContext (legacy feature)
                this.savedContext = (getvWithDoubleDecryption && await getvWithDoubleDecryption(this.savedContextId, this.args?.contextKey)) || {};
                this.initialState = { savedContext: this.savedContext };
                
                // Only load memory* sections if memory is enabled
                if (memoryEnabled) {
                    const [memorySelf, memoryDirectives, memoryTopics, memoryUser, memoryContext] = await Promise.all([
                        callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memorySelf', priority: 1, stripMetadata: true, contextKey: this.args?.contextKey }),
                        callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryDirectives', priority: 1, stripMetadata: true, contextKey: this.args?.contextKey }),
                        callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryTopics', priority: 0, numResults: 10, contextKey: this.args?.contextKey }),
                        callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryUser', priority: 1, stripMetadata: true, contextKey: this.args?.contextKey }),
                        callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryContext', priority: 0, contextKey: this.args?.contextKey }),
                    ]).catch(error => {
                        this.logError(`Failed to load memory: ${error.message}`);
                        return ['','','','',''];
                    });

                    this.memorySelf = memorySelf || '';
                    this.memoryDirectives = memoryDirectives || '';
                    this.memoryTopics = memoryTopics || '';
                    this.memoryUser = memoryUser || '';
                    this.memoryContext = memoryContext || '';
                } else {
                    this.memorySelf = '';
                    this.memoryDirectives = '';
                    this.memoryTopics = '';
                    this.memoryUser = '';
                    this.memoryContext = '';
                }
            } catch (error) {
                this.logError(`Error in loadMemory: ${error.message}`);
                this.savedContext = {};
                this.memorySelf = '';
                this.memoryDirectives = '';
                this.memoryTopics = '';
                this.memoryUser = '';
                this.memoryContext = '';
                this.initialState = { savedContext: {} };
            }
        };

        const saveChangedMemory = async () => {
            // Always save savedContext (legacy feature, not governed by useMemory)
            this.savedContextId = this.savedContextId || uuidv4();
            
            const currentState = {
                savedContext: this.savedContext,
            };

            if (currentState.savedContext !== this.initialState.savedContext) {
                setvWithDoubleEncryption && await setvWithDoubleEncryption(this.savedContextId, this.savedContext, this.args?.contextKey);
            }
        };

        const MAX_RETRIES = 3;
        let data = null;
        
        for (let retries = 0; retries < MAX_RETRIES; retries++) {
            const loadMemorySpan = latencyTrace.start('resolver.loadMemory', {
                requestId: this.requestId,
                rootRequestId: this.rootRequestId || undefined,
                pathway: this.pathway?.name,
                retry: retries,
                memoryEnabled,
            });
            await loadMemory(); // Reset memory state on each retry
            latencyTrace.end(loadMemorySpan, {
                memorySelfChars: this.memorySelf?.length || 0,
                memoryDirectivesChars: this.memoryDirectives?.length || 0,
                memoryTopicsChars: this.memoryTopics?.length || 0,
                memoryUserChars: this.memoryUser?.length || 0,
                memoryContextChars: this.memoryContext?.length || 0,
            });
            
            data = await this.processRequest(args);
            if (!data) {
                break;
            }

            // if data is a stream, handle it
            if (data && typeof data.on === 'function') {
                const streamResult = await this.handleStream(data);
                // Check if stream was empty (opened but closed with no data) - retry if so
                if (streamResult?.emptyStream) {
                    logger.warn(`Empty stream received - retrying. Attempt ${retries + 1} of ${MAX_RETRIES}`);
                    if (retries === MAX_RETRIES - 1) {
                        // Last retry - send error completion so client doesn't hang
                        logger.error('All stream retries exhausted - empty stream from provider');
                        publishRequestProgress({
                            requestId: this.rootRequestId || this.requestId,
                            progress: 1,
                            data: '',
                            info: JSON.stringify(this.pathwayResultData || {}),
                            error: 'Provider returned empty stream - please try again'
                        });
                    }
                    continue; // Retry
                }
                return data;
            }

            data = await this.responseParser.parse(data);
            if (data !== null) {
                break;
            }

            logger.warn(`Bad pathway result - retrying pathway. Attempt ${retries + 1} of ${MAX_RETRIES}`);
        }

        if (data !== null) {
            const saveMemorySpan = latencyTrace.start('resolver.saveChangedMemory', {
                requestId: this.requestId,
                rootRequestId: this.rootRequestId || undefined,
                pathway: this.pathway?.name,
            });
            await saveChangedMemory();
            latencyTrace.end(saveMemorySpan);
        }

        addCitationsToResolver(this, data);

        latencyTrace.end(span, {
            resultKind: data && typeof data.on === 'function' ? 'stream' : typeof data,
            errors: this.errors.length,
            warnings: this.warnings.length,
        });
        return data;
    }

    // Add a warning and log it
    logWarning(warning) {
        this.warnings.push(warning);
        logger.warn(warning);
    }

    // Add an error and log it (GraphQL exposes errors as [String] — store strings only)
    logError(error) {
        let msg = 'Unknown error';
        if (error != null) {
            if (typeof error === 'string') msg = error;
            else if (error instanceof Error) msg = error.message || String(error);
            else if (typeof error === 'object' && typeof error.message === 'string') {
                msg = error.message;
            } else {
                try {
                    msg = JSON.stringify(error);
                } catch {
                    msg = String(error);
                }
            }
        }
        this.errors.push(msg);
        logger.error(error);
    }

    // Here we choose how to handle long input - either summarize or chunk
    processInputText(text) {
        let chunkTokenLength = 0;
        if (this.pathway.inputChunkSize) {
            chunkTokenLength = this.pathway.inputChunkSize;
        } else {
            chunkTokenLength = this.chunkMaxTokenLength;
        }
        const encoded = text ? encode(text) : [];
        if (!this.useInputChunking) { // no chunking, return as is
            if (encoded.length > 0 && encoded.length >= chunkTokenLength) {
                const warnText = `Truncating long input text. Text length: ${text.length}`;
                this.logWarning(warnText);
                text = this.truncate(text, chunkTokenLength);
            }
            return [text];
        }

        // chunk the text and return the chunks with newline separators
        return getSemanticChunks(text, chunkTokenLength, this.pathway.inputFormat);
    }

    truncate(str, n) {
        if (this.modelExecutor.plugin.promptParameters.truncateFromFront) {
            return getFirstNToken(str, n);
        }
        return getLastNToken(str, n);
    }

    async summarizeIfEnabled({ text, ...parameters }) {
        if (this.pathway.useInputSummarization) {
            return await callPathway('summary', { ...this.args, ...parameters, targetLength: 0});
        }
        return text;
    }

    // Calculate the maximum token length for a chunk
    getChunkMaxTokenLength() {
        // Skip expensive calculations if not using input chunking
        if (!this.useInputChunking) {
            return this.modelExecutor.plugin.getModelMaxPromptTokens();
        }

        // find the longest prompt
        const maxPromptTokenLength = Math.max(...this.prompts.map((promptData) => this.modelExecutor.plugin.getCompiledPrompt('', this.args, promptData).tokenLength));
        
        // find out if any prompts use both text input and previous result
        const hasBothProperties = this.prompts.some(prompt => prompt.usesTextInput && prompt.usesPreviousResult);
        
        let chunkMaxTokenLength = this.modelExecutor.plugin.getModelMaxPromptTokens() - maxPromptTokenLength - 1;
        
        // if we have to deal with prompts that have both text input
        // and previous result, we need to split the maxChunkToken in half
        chunkMaxTokenLength = hasBothProperties ? chunkMaxTokenLength / 2 : chunkMaxTokenLength;
        
        return chunkMaxTokenLength;
    }

    // Process the request and return the result        
    async processRequest({ text, ...parameters }) {
        const span = latencyTrace.start('resolver.processRequest', {
            requestId: this.requestId,
            rootRequestId: this.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
            promptCount: this.prompts.length,
            stream: Boolean(parameters?.stream),
            async: Boolean(parameters?.async),
        });
        text = await this.summarizeIfEnabled({ text, ...parameters }); // summarize if flag enabled
        const chunks = text && this.processInputText(text) || [text];
        latencyTrace.mark('resolver.chunks', {
            requestId: this.requestId,
            rootRequestId: this.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
            chunkCount: chunks.length,
            promptCount: this.prompts.length,
            anticipatedRequestCount: chunks.length * this.prompts.length,
            textChars: typeof text === 'string' ? text.length : undefined,
        });

        let anticipatedRequestCount = chunks.length * this.prompts.length   

        if ((requestState[this.requestId] || {}).canceled) {
            clearPendingMessages(this.requestId);
            throw new Error('Request canceled');
        }

        // Store the request state
        requestState[this.requestId] = { ...requestState[this.requestId], totalCount: anticipatedRequestCount, completedCount: 0 };

        if (chunks.length > 1) { 
            // stream behaves as async if there are multiple chunks
            if (parameters.stream) {
                parameters.async = true;
                parameters.stream = false;
            }
        }

        // If pre information is needed, apply current prompt with previous prompt info, only parallelize current call
        if (this.pathway.useParallelChunkProcessing) {
            // Apply each prompt across all chunks in parallel
            // this.previousResult is not available at the object level as it is different for each chunk
            this.previousResult = '';
            const data = await Promise.all(chunks.map(chunk =>
                this.applyPromptsSerially(chunk, parameters)));
            // Join the chunks with newlines
            const joined = data.join(this.pathway.joinChunksWith || "\n\n");
            latencyTrace.end(span, { chunkCount: chunks.length, parallel: true });
            return joined;
        } else {
            // Apply prompts one by one, serially, across all chunks
            // This is the default processing mode and will make previousResult available at the object level
            let previousResult = '';
            let result = '';

            for (let i = 0; i < this.prompts.length; i++) {
                const currentParameters = { ...parameters, previousResult };

                if (currentParameters.stream) { // stream special flow
                    if (i < this.prompts.length - 1) { 
                        currentParameters.stream = false; // if not the last prompt then don't stream
                    }
                    else {
                        // use the stream parameter if not async
                        currentParameters.stream = currentParameters.async ? false : currentParameters.stream;
                    }
                }

                // If the prompt doesn't contain {{text}} then we can skip the chunking, and also give that token space to the previous result
                if (!this.prompts[i].usesTextInput) {
                    // Limit context to it's N + text's characters
                    if (previousResult) {
                        previousResult = this.truncate(previousResult, 2 * this.chunkMaxTokenLength);
                    }
                    result = await this.applyPrompt(this.prompts[i], text, currentParameters);
                } else {
                    // Limit context to N characters
                    if (previousResult) {
                        previousResult = this.truncate(previousResult, this.chunkMaxTokenLength);
                    }
                    result = await Promise.all(chunks.map(chunk =>
                        this.applyPrompt(this.prompts[i], chunk, currentParameters)));

                    if (result.length === 1) {
                        result = result[0];
                    } else if (!currentParameters.stream) {
                        result = result.join(this.pathway.joinChunksWith || "\n\n");
                    }
                }

                // If this is any prompt other than the last, use the result as the previous context
                if (i < this.prompts.length - 1) {
                    previousResult = result;
                    if (result instanceof CortexResponse) {
                        previousResult = result.output_text;
                    }
                }
            }
            // store the previous result in the PathwayResolver
            this.previousResult = previousResult;
            latencyTrace.end(span, { chunkCount: chunks.length, parallel: false });
            return result;
        }

    }

    async applyPromptsSerially(text, parameters) {
        let previousResult = '';
        let result = '';
        for (const prompt of this.prompts) {
            previousResult = result;
            result = await this.applyPrompt(prompt, text, { ...parameters, previousResult });
        }
        return result;
    }

    /**
     * Swaps the model used by this PathwayResolver
     * @param {string} newModelName - The name of the new model to use
     * @throws {Error} If the new model is not found in the endpoints
     */
    swapModel(newModelName) {
        const resolvedName = resolveModelName(newModelName);
        if (!this.endpoints[resolvedName]) {
            throw new Error(`Model ${resolvedName} not found in config`);
        }

        this.modelName = resolvedName;
        this.model = this.endpoints[resolvedName];

        // Create new ModelExecutor with the new model
        this.modelExecutor = new ModelExecutor(this.pathway, this.model);

        // Recalculate chunk max token length as it depends on the model
        this.chunkMaxTokenLength = this.getChunkMaxTokenLength();

        this.logWarning(`Model swapped to ${newModelName}`);
    }

    async applyPrompt(prompt, text, parameters) {
        if (requestState[this.requestId].canceled) {
            clearPendingMessages(this.requestId);
            return;
        }
        const span = latencyTrace.start('resolver.applyPrompt', {
            requestId: this.requestId,
            rootRequestId: this.rootRequestId || undefined,
            pathway: this.pathway?.name,
            model: this.modelName,
            stream: Boolean(parameters?.stream),
            async: Boolean(parameters?.async),
            textChars: typeof text === 'string' ? text.length : undefined,
            previousResultChars: typeof parameters?.previousResult === 'string' ? parameters.previousResult.length : undefined,
        });
        let result = '';

        try {
            result = await this.modelExecutor.execute(text, {
                ...parameters,
                ...this.savedContext,
                memorySelf: this.memorySelf,
                memoryDirectives: this.memoryDirectives,
                memoryTopics: this.memoryTopics,
                memoryUser: this.memoryUser,
                memoryContext: this.memoryContext
            }, prompt, this);
        } finally {
            latencyTrace.end(span, {
                resultKind: result && typeof result.on === 'function' ? 'stream' : typeof result,
                resultChars: typeof result === 'string' ? result.length : undefined,
            });
        }
        
        requestState[this.requestId].completedCount++;

        if (parameters.async) {
            const { completedCount, totalCount } = requestState[this.requestId];

            if (completedCount < totalCount) {
                await publishRequestProgress({
                        requestId: this.requestId,
                        progress: completedCount / totalCount,
                });
            }
        }

        // save the result to the context if requested and no errors
        if (prompt.saveResultTo && this.errors.length === 0) {
            // Update memory property if it matches a known type
            if (["memorySelf", "memoryUser", "memoryDirectives", "memoryTopics"].includes(prompt.saveResultTo)) {
                this[prompt.saveResultTo] = result;
            }
            this.savedContext[prompt.saveResultTo] = result;
        }
        return result;
    }
}

export { PathwayResolver };
