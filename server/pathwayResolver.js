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
        this.pathwayPrompter = new PathwayPrompter({ config, pathway });
        this.previousResult = '';
        this.prompts = [];

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

    async asyncResolve(args) {
        const responseData = await this.promptAndParse(args);

        // Either we're dealing with an async request or a stream
        if(args.async || typeof responseData === 'string') {
            const { completedCount, totalCount } = requestState[this.requestId];
            requestState[this.requestId].data = responseData;
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId: this.requestId,
                    progress: completedCount / totalCount,
                    data: JSON.stringify(responseData),
                }
            });
        } else { // stream
            const incomingMessage = Array.isArray(responseData) && responseData.length > 0 ? responseData[0] : responseData;
            incomingMessage.on('data', data => {
                const events = data.toString().split('\n');
        
                events.forEach(event => {
                    if (event.trim() === '') return; // Skip empty lines
        
                    const message = event.replace(/^data: /, '');
                    
                    console.log(`====================================`);
                    console.log(`STREAM EVENT: ${event}`);
                    //console.log(`MESSAGE: ${message}`);
        
                    const requestProgress = {
                        requestId: this.requestId,
                        data: message,
                    }
        
                    if (message.trim() === '[DONE]') {
                        requestProgress.progress = 1;
                    }
        
                    try {
                        pubsub.publish('REQUEST_PROGRESS', {
                            requestProgress: requestProgress
                        });
                    } catch (error) {
                        console.error('Could not JSON parse stream message', message, error);
                    }
                });
            });
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
            return await this.promptAndParse(args);
        }
    }

    async promptAndParse(args) {
        // Get saved context from contextId or change contextId if needed
        const { contextId } = args;
        this.savedContextId = contextId ? contextId : null;
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
        const encoded = encode(text);
        if (!this.useInputChunking || encoded.length <= chunkTokenLength) { // no chunking, return as is
            if (encoded.length > 0 && encoded.length >= chunkTokenLength) {
                const warnText = `Truncating long input text. Text length: ${text.length}`;
                this.logWarning(warnText);
                text = this.truncate(text, chunkTokenLength);
            }
            return [text];
        }

        // chunk the text and return the chunks with newline separators
        return getSemanticChunks(text, chunkTokenLength);
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

        const anticipatedRequestCount = chunks.length * this.prompts.length;

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
                    if (!currentParameters.stream) {
                        result = result.join("\n\n")
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
        if (!/^\s*$/.test(text) || parameters?.file) {
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
