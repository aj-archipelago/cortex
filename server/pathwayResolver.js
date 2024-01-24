import { PathwayPrompter } from './pathwayPrompter.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import { v4 as uuidv4 } from 'uuid';
import pubsub from './pubsub.js';
import { encode } from 'gpt-3-encoder';
import { getFirstNToken, getLastNToken, getSemanticChunks } from './chunker.js';
import { PathwayResponseParser } from './pathwayResponseParser.js';
import { Prompt } from './prompt.js';
import { getv, setv } from '../lib/keyValueStorageClient.js';
import { requestState } from './requestState.js';
import { callPathway } from '../lib/pathwayTools.js';

const modelTypesExcludedFromProgressUpdates = ['OPENAI-DALLE2', 'OPENAI-DALLE3'];

class PathwayResolver {
    constructor({ config, pathway, args }) {
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
            ].find(modelName => modelName && Object.prototype.hasOwnProperty.call(config.get('models'), modelName));
        this.model = config.get('models')[this.modelName];

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
        this.pathwayPrompter = new PathwayPrompter(this.config, this.pathway, this.modelName, this.model);

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

    // This code handles async and streaming responses.  In either case, we use
    // the graphql subscription to send progress updates to the client.  Most of 
    // the time the client will be an external client, but it could also be the
    // Cortex REST api code.
    async asyncResolve(args) {
        const MAX_RETRY_COUNT = 3;
        let attempt = 0;
        let streamErrorOccurred = false;

        while (attempt < MAX_RETRY_COUNT) {
            const responseData = await this.executePathway(args);

            if (args.async || typeof responseData === 'string') {
                const { completedCount, totalCount } = requestState[this.requestId];
                requestState[this.requestId].data = responseData;
                
                // if model type is OPENAI-IMAGE
                if (!modelTypesExcludedFromProgressUpdates.includes(this.model.type)) {
                    pubsub.publish('REQUEST_PROGRESS', {
                        requestProgress: {
                            requestId: this.requestId,
                            progress: completedCount / totalCount,
                            data: JSON.stringify(responseData),
                        }
                    });
                }
            } else {
                try {
                    const incomingMessage = responseData;

                    let messageBuffer = '';

                    const processData = (data) => {
                        try {
                            //console.log(`\n\nReceived stream data for requestId ${this.requestId}`, data.toString());
                            let events = data.toString().split('\n');
                            
                            //events = "data: {\"id\":\"chatcmpl-20bf1895-2fa7-4ef9-abfe-4d142aba5817\",\"object\":\"chat.completion.chunk\",\"created\":1689303423723,\"model\":\"gpt-4\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":{\"error\":{\"message\":\"The server had an error while processing your request. Sorry about that!\",\"type\":\"server_error\",\"param\":null,\"code\":null}}},\"finish_reason\":null}]}\n\n".split("\n");

                            for (let event of events) {
                                if (streamErrorOccurred) break;
                                
                                // skip empty events
                                if (!(event.trim() === '')) {
                                    //console.log(`Processing stream event for requestId ${this.requestId}`, event);
                                    messageBuffer += event.replace(/^data: /, '');

                                    const requestProgress = {
                                        requestId: this.requestId,
                                        data: messageBuffer,
                                    }

                                    // check for end of stream or in-stream errors
                                    if (messageBuffer.trim() === '[DONE]') {
                                        requestProgress.progress = 1;
                                    } else {
                                        let parsedMessage;
                                        try {
                                            parsedMessage = JSON.parse(messageBuffer);
                                            messageBuffer = '';
                                        } catch (error) {
                                            // incomplete stream message, try to buffer more data
                                            return;
                                        }

                                        const streamError = parsedMessage?.error || parsedMessage?.choices?.[0]?.delta?.content?.error || parsedMessage?.choices?.[0]?.text?.error;
                                        if (streamError) {
                                            streamErrorOccurred = true;
                                            console.error(`Stream error: ${streamError.message}`);
                                            incomingMessage.off('data', processData); // Stop listening to 'data'
                                            return;
                                        }
                                    }

                                    try {
                                        //console.log(`Publishing stream message to requestId ${this.requestId}`, message);
                                        pubsub.publish('REQUEST_PROGRESS', {
                                            requestProgress: requestProgress
                                        });
                                    } catch (error) {
                                        console.error('Could not publish the stream message', messageBuffer, error);
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('Could not process stream data', error);
                        }
                    };

                    if (incomingMessage) {
                        await new Promise((resolve, reject) => {
                            incomingMessage.on('data', processData);
                            incomingMessage.on('end', resolve);
                            incomingMessage.on('error', reject);
                        });
                    }

                } catch (error) {
                    console.error('Could not subscribe to stream', error);
                }
            }

            if (streamErrorOccurred) {
                attempt++;
                console.error(`Stream attempt ${attempt} failed. Retrying...`);
                streamErrorOccurred = false; // Reset the flag for the next attempt
            } else {
                return;
            }
        }
        // if all retries failed, publish the stream end message
        pubsub.publish('REQUEST_PROGRESS', {
            requestProgress: {
                requestId: this.requestId,
                progress: 1,
                data: '[DONE]',
            }
        });
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

        // Process the request
        const data = await this.processRequest(args);

        // Update saved context if it has changed, generating a new contextId if necessary
        if (savedContextStr !== JSON.stringify(this.savedContext)) {
            this.savedContextId = this.savedContextId || uuidv4();
            setv && setv(this.savedContextId, this.savedContext);
        }

        // Return the result
        return this.responseParser.parse(data);
    }

    // Add a warning and log it
    logWarning(warning) {
        this.warnings.push(warning);
        console.warn(warning);
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
        if (this.pathwayPrompter.plugin.promptParameters.truncateFromFront) {
            return getFirstNToken(str, n);
        }
        return getLastNToken(str, n);
    }

    async summarizeIfEnabled({ text, ...parameters }) {
        if (this.pathway.useInputSummarization) {
            return await callPathway(this.config, 'summary', { ...this.args, ...parameters, targetLength: 0});
        }
        return text;
    }

    // Calculate the maximum token length for a chunk
    getChunkMaxTokenLength() {
        // find the longest prompt
        const maxPromptTokenLength = Math.max(...this.prompts.map((promptData) => this.pathwayPrompter.plugin.getCompiledPrompt('', this.args, promptData).tokenLength));
        
        // find out if any prompts use both text input and previous result
        const hasBothProperties = this.prompts.some(prompt => prompt.usesTextInput && prompt.usesPreviousResult);
        
        // the token ratio is the ratio of the total prompt to the result text - both have to be included
        // in computing the max token length
        const promptRatio = this.pathwayPrompter.plugin.getPromptTokenRatio();
        let chunkMaxTokenLength = promptRatio * this.pathwayPrompter.plugin.getModelMaxTokenLength() - maxPromptTokenLength - 1;
        
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
            return data.join("\n\n");
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
                        result = result.join("\n\n");
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
            result = await this.pathwayPrompter.execute(text, { ...parameters, ...this.savedContext }, prompt, this);
        } else {
            result = text;
        }
        
        requestState[this.requestId].completedCount++;

        const { completedCount, totalCount } = requestState[this.requestId];

        if (completedCount < totalCount) {
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId: this.requestId,
                    progress: completedCount / totalCount,
                }
            });
        }

        if (prompt.saveResultTo) {
            this.savedContext[prompt.saveResultTo] = result;
        }
        return result;
    }
}

export { PathwayResolver };
