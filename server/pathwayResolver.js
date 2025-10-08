import { ModelExecutor } from './modelExecutor.js';
import { modelEndpoints } from '../lib/requestExecutor.js';
import { v4 as uuidv4 } from 'uuid';
import { encode } from '../lib/encodeCache.js';
import { getFirstNToken, getLastNToken, getSemanticChunks } from './chunker.js';
import { PathwayResponseParser } from './pathwayResponseParser.js';
import { Prompt } from './prompt.js';
import { getv, setv } from '../lib/keyValueStorageClient.js';
import { requestState } from './requestState.js';
import { callPathway, addCitationsToResolver } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';
import { publishRequestProgress } from '../lib/redisSubscription.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import { createParser } from 'eventsource-parser';
import CortexResponse from '../lib/cortexResponse.js';

const modelTypesExcludedFromProgressUpdates = ['OPENAI-DALLE2', 'OPENAI-DALLE3'];

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
            ].find(modelName => modelName && Object.prototype.hasOwnProperty.call(this.endpoints, modelName));
        this.model = this.endpoints[this.modelName];

        if (!this.model) {
            throw new Error(`Model ${this.modelName} not found in config`);
        }

        const specifiedModelName = pathway.model || args?.model || pathway.inputParameters?.model;

        if (this.modelName !== (specifiedModelName)) {
            if (specifiedModelName) {
                this.logWarning(`Specified model ${specifiedModelName} not found in config, using ${this.modelName} instead.`);
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
                coding: this.pathwayResultData.coding,
                codeRequestId: this.pathwayResultData.codeRequestId,
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
                requestProgress.error = this.errors.join(', ') || '';
            }
            publishRequestProgress(requestProgress);
        }

    }

    // This code handles async and streaming responses for either long-running
    // tasks or streaming model responses
    async asyncResolve(args) {
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

    async handleStream(response) {
        let streamErrorOccurred = false;

        if (response && typeof response.on === 'function') {
            try {
                const incomingMessage = response;
                let streamEnded = false;

                const onParse = (event) => {
                    let requestProgress = {
                        requestId: this.rootRequestId || this.requestId
                    };

                    logger.debug(`Received event: ${event.type}`);

                    if (event.type === 'event') {
                        logger.debug('Received event!')
                        logger.debug(`id: ${event.id || '<none>'}`)
                        logger.debug(`name: ${event.name || '<none>'}`)
                        logger.debug(`data: ${event.data}`)
                    } else if (event.type === 'reconnect-interval') {
                        logger.debug(`We should set reconnect interval to ${event.value} milliseconds`)
                    }

                    try {
                        requestProgress = this.modelExecutor.plugin.processStreamEvent(event, requestProgress);
                    } catch (error) {
                        streamErrorOccurred = true;
                        logger.error(`Stream error: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
                        incomingMessage.off('data', processStream);
                        return;
                    }

                    try {
                        if (!streamEnded && requestProgress.data) {
                            this.publishNestedRequestProgress(requestProgress);
                            streamEnded = requestProgress.progress === 1;
                        }
                    } catch (error) {
                        logger.error(`Could not publish the stream message: "${event.data}", ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
                    }

                }
                
                const sseParser = createParser(onParse);

                const processStream = (data) => {
                    //logger.warn(`RECEIVED DATA: ${JSON.stringify(data.toString())}`);
                    sseParser.feed(data.toString());
                }

                if (incomingMessage) {
                    await new Promise((resolve, reject) => {
                        incomingMessage.on('data', processStream);
                        incomingMessage.on('end', resolve);
                        incomingMessage.on('error', reject);
                    });
                }

            } catch (error) {
                logger.error(`Could not subscribe to stream: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
            }

            if (streamErrorOccurred) {
                logger.error(`Stream read failed. Finishing stream...`);
                publishRequestProgress({
                    requestId: this.requestId,
                    progress: 1,
                    data: '',
                    info: '',
                    error: 'Stream read failed'
                });
            } else {
                return;
            }
        }
    }

    async resolve(args) {
        // Either we're dealing with an async request, stream, or regular request
        if (args.async || args.stream) {
            if (!requestState[this.requestId]) {
                requestState[this.requestId] = {}
            }
            this.rootRequestId = args.rootRequestId ?? null;
            requestState[this.requestId] = { ...requestState[this.requestId], args, resolver: this.asyncResolve.bind(this), pathwayResolver: this };
            return this.requestId;
        }
        else {
            // Syncronously process the request
            return await this.executePathway(args);
        }
    }

    async executePathway(args) {
        if (this.pathway.executePathway && typeof this.pathway.executePathway === 'function') {
            return await this.pathway.executePathway({ args, runAllPrompts: this.promptAndParse.bind(this), resolver: this });
        }
        else {
            return await this.promptAndParse(args);
        }
    }

    async promptAndParse(args) {
        // Check if model is specified in args and swap if different from current model
        if (args.modelOverride && args.modelOverride !== this.modelName) {
            try {
                this.swapModel(args.modelOverride);
            } catch (error) {
                this.logError(`Failed to swap model to ${args.modelOverride}: ${error.message}`);
            }
        }

        // Get saved context from contextId or change contextId if needed
        const { contextId } = args;
        this.savedContextId = contextId ? contextId : uuidv4();
        
        const loadMemory = async () => {
            try {
                // Load saved context and core memory if it exists
                const [savedContext, memorySelf, memoryDirectives, memoryTopics, memoryUser, memoryContext] = await Promise.all([
                    (getv && await getv(this.savedContextId)) || {},
                    callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memorySelf', priority: 1, stripMetadata: true }),
                    callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryDirectives', priority: 1, stripMetadata: true }),
                    callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryTopics', priority: 0, numResults: 10 }),
                    callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryUser', priority: 1, stripMetadata: true }),
                    callPathway('sys_read_memory', { contextId: this.savedContextId, section: 'memoryContext', priority: 0 }),
                ]).catch(error => {
                    this.logError(`Failed to load memory: ${error.message}`);
                    return [{},'','','','',''];
                });

                this.savedContext = savedContext;
                this.memorySelf = memorySelf || '';
                this.memoryDirectives = memoryDirectives || '';
                this.memoryTopics = memoryTopics || '';
                this.memoryUser = memoryUser || '';
                this.memoryContext = memoryContext || '';

                // Store initial state for comparison
                this.initialState = {
                    savedContext: this.savedContext,
                };
            } catch (error) {
                this.logError(`Error in loadMemory: ${error.message}`);
                // Set default values in case of error
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
            this.savedContextId = this.savedContextId || uuidv4();
            
            const currentState = {
                savedContext: this.savedContext,
            };

            if (currentState.savedContext !== this.initialState.savedContext) {
                setv && await setv(this.savedContextId, this.savedContext);
            }
        };

        const MAX_RETRIES = 3;
        let data = null;
        
        for (let retries = 0; retries < MAX_RETRIES; retries++) {
            await loadMemory(); // Reset memory state on each retry
            
            data = await this.processRequest(args);
            if (!data) {
                break;
            }

            // if data is a stream, handle it
            if (data && typeof data.on === 'function') {
                await this.handleStream(data);
                return data;
            }

            data = await this.responseParser.parse(data);
            if (data !== null) {
                break;
            }

            logger.warn(`Bad pathway result - retrying pathway. Attempt ${retries + 1} of ${MAX_RETRIES}`);
        }

        if (data !== null) {
            await saveChangedMemory();
        }

        addCitationsToResolver(this, data);

        return data;
    }

    // Add a warning and log it
    logWarning(warning) {
        this.warnings.push(warning);
        logger.warn(warning);
    }

    // Add an error and log it
    logError(error) {
        this.errors.push(error);
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
        text = await this.summarizeIfEnabled({ text, ...parameters }); // summarize if flag enabled
        const chunks = text && this.processInputText(text) || [text];

        let anticipatedRequestCount = chunks.length * this.prompts.length   

        if ((requestState[this.requestId] || {}).canceled) {
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
            return data.join(this.pathway.joinChunksWith || "\n\n");
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
        // Validate that the new model exists in endpoints
        if (!this.endpoints[newModelName]) {
            throw new Error(`Model ${newModelName} not found in config`);
        }

        // Update model references
        this.modelName = newModelName;
        this.model = this.endpoints[newModelName];

        // Create new ModelExecutor with the new model
        this.modelExecutor = new ModelExecutor(this.pathway, this.model);

        // Recalculate chunk max token length as it depends on the model
        this.chunkMaxTokenLength = this.getChunkMaxTokenLength();

        this.logWarning(`Model swapped to ${newModelName}`);
    }

    async applyPrompt(prompt, text, parameters) {
        if (requestState[this.requestId].canceled) {
            return;
        }
        let result = '';

        result = await this.modelExecutor.execute(text, { 
            ...parameters, 
            ...this.savedContext,
            memorySelf: this.memorySelf,
            memoryDirectives: this.memoryDirectives,
            memoryTopics: this.memoryTopics,
            memoryUser: this.memoryUser,
            memoryContext: this.memoryContext
        }, prompt, this);
        
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
