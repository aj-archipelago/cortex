import { ModelExecutor } from './modelExecutor.js';
import { modelEndpoints } from '../lib/requestExecutor.js';
import { v4 as uuidv4 } from 'uuid';
import { encode } from '../lib/encodeCache.js';
import { getFirstNToken, getLastNToken, getSemanticChunks } from './chunker.js';
import { PathwayResponseParser } from './pathwayResponseParser.js';
import { Prompt } from './prompt.js';
import { getv, setv } from '../lib/keyValueStorageClient.js';
import { requestState } from './requestState.js';
import { callPathway } from '../lib/pathwayTools.js';
import { publishRequestProgress } from '../lib/redisSubscription.js';
import logger from '../lib/logger.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import { createParser } from 'eventsource-parser';

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
        this.requestId = uuidv4();
        this.responseParser = new PathwayResponseParser(pathway);
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

    // This code handles async and streaming responses for either long-running
    // tasks or streaming model responses
    async asyncResolve(args) {
        let streamErrorOccurred = false;
        let responseData = null;

        try {
            responseData = await this.executePathway(args);
        }
        catch (error) {
            if (!args.async) {
                publishRequestProgress({
                    requestId: this.requestId,
                    progress: 1,
                    data: '[DONE]',
                });
            }
            return;
        }

        // If the response is a string, it's a regular long running response
        if (args.async || typeof responseData === 'string') {
            const { completedCount, totalCount } = requestState[this.requestId];
            requestState[this.requestId].data = responseData;
            
            // some models don't support progress updates
            if (!modelTypesExcludedFromProgressUpdates.includes(this.model.type)) {
                await publishRequestProgress({
                        requestId: this.requestId,
                        progress: completedCount / totalCount,
                        data: JSON.stringify(responseData),
                });
            }
        // If the response is an object, it's a streaming response
        } else {
            try {
                const incomingMessage = responseData;
                let streamEnded = false;

                const onParse = (event) => {
                    let requestProgress = {
                        requestId: this.requestId
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
                        logger.error(`Stream error: ${error.message}`);
                        incomingMessage.off('data', processStream);
                        return;
                    }

                    try {
                        if (!streamEnded && requestProgress.data) {
                            //logger.info(`Publishing stream message to requestId ${this.requestId}: ${message}`);
                            publishRequestProgress(requestProgress);
                            streamEnded = requestProgress.progress === 1;
                        }
                    } catch (error) {
                        logger.error(`Could not publish the stream message: "${event.data}", ${error}`);
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
                logger.error(`Could not subscribe to stream: ${error}`);
            }

            if (streamErrorOccurred) {
                logger.error(`Stream read failed. Finishing stream...`);
                publishRequestProgress({
                    requestId: this.requestId,
                    progress: 1,
                    data: '[DONE]',
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
            requestState[this.requestId] = { ...requestState[this.requestId], args, resolver: this.asyncResolve.bind(this) };
            return this.requestId;
        }
        else {
            // Syncronously process the request
            return await this.executePathway(args);
        }
    }

    async executePathway(args) {
        if (this.pathway.executePathway && typeof this.pathway.executePathway === 'function') {
            return await this.pathway.executePathway({ args, runAllPrompts: this.promptAndParse.bind(this) });
        }
        else {
            return await this.promptAndParse(args);
        }
    }

    async promptAndParse(args) {
        // Get saved context from contextId or change contextId if needed
        const { contextId } = args;
        this.savedContextId = contextId ? contextId : uuidv4();
        this.savedContext = contextId ? (getv && (await getv(contextId)) || {}) : {};

        // Save the context before processing the request
        const savedContextStr = JSON.stringify(this.savedContext);

        const MAX_RETRIES = 3;
        let data = null;
        
        for (let retries = 0; retries < MAX_RETRIES; retries++) {
            data = await this.processRequest(args);
            if (!data) {
                break;
            }

            data = this.responseParser.parse(data);
            if (data !== null) {
                break;
            }

            logger.warn(`Bad pathway result - retrying pathway. Attempt ${retries + 1} of ${MAX_RETRIES}`);
            this.savedContext = JSON.parse(savedContextStr);
        }

        // Update saved context if it has changed, generating a new contextId if necessary
        if (savedContextStr !== JSON.stringify(this.savedContext)) {
            this.savedContextId = this.savedContextId || uuidv4();
            setv && setv(this.savedContextId, this.savedContext);
        }

        return data;
    }

    // Add a warning and log it
    logWarning(warning) {
        this.warnings.push(warning);
        logger.warn(warning);
    }

    // Here we choose how to handle long input - either summarize or chunk
    processInputText(text) {
        let chunkTokenLength = 0;
        if (this.pathway.inputChunkSize) {
            chunkTokenLength = Math.min(this.pathway.inputChunkSize, this.chunkMaxTokenLength);
        } else {
            chunkTokenLength = this.chunkMaxTokenLength;
        }
        const encoded = text ? encode(text) : [];
        if (!this.useInputChunking || encoded.length <= chunkTokenLength) { // no chunking, return as is
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
        // find the longest prompt
        const maxPromptTokenLength = Math.max(...this.prompts.map((promptData) => this.modelExecutor.plugin.getCompiledPrompt('', this.args, promptData).tokenLength));
        
        // find out if any prompts use both text input and previous result
        const hasBothProperties = this.prompts.some(prompt => prompt.usesTextInput && prompt.usesPreviousResult);
        
        // the token ratio is the ratio of the total prompt to the result text - both have to be included
        // in computing the max token length
        const promptRatio = this.modelExecutor.plugin.getPromptTokenRatio();
        let chunkMaxTokenLength = promptRatio * this.modelExecutor.plugin.getModelMaxTokenLength() - maxPromptTokenLength - 1;
        
        // if we have to deal with prompts that have both text input
        // and previous result, we need to split the maxChunkToken in half
        chunkMaxTokenLength = hasBothProperties ? chunkMaxTokenLength / 2 : chunkMaxTokenLength;
        
        return chunkMaxTokenLength;
    }

    // Process the request and return the result        
    async processRequest({ text, ...parameters }) {
        text = await this.summarizeIfEnabled({ text, ...parameters }); // summarize if flag enabled
        const chunks = this.processInputText(text);

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
                    previousResult = this.truncate(previousResult, 2 * this.chunkMaxTokenLength);
                    result = await this.applyPrompt(this.prompts[i], null, currentParameters);
                } else {
                    // Limit context to N characters
                    previousResult = this.truncate(previousResult, this.chunkMaxTokenLength);
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

    async applyPrompt(prompt, text, parameters) {
        if (requestState[this.requestId].canceled) {
            return;
        }
        let result = '';

        // If this text is empty, skip applying the prompt as it will likely be a nonsensical result
        if (!/^\s*$/.test(text) || parameters?.file || parameters?.inputVector || this?.modelName.includes('cognitive')) {
            result = await this.modelExecutor.execute(text, { ...parameters, ...this.savedContext }, prompt, this);
        } else {
            result = text;
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

        if (prompt.saveResultTo) {
            this.savedContext[prompt.saveResultTo] = result;
        }
        return result;
    }
}

export { PathwayResolver };
