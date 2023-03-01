const { PathwayPrompter } = require('./pathwayPrompter');
const {
    v4: uuidv4,
} = require('uuid');
const pubsub = require('./pubsub');
const { encode } = require('gpt-3-encoder')
const { getFirstNToken, getLastNToken, getSemanticChunks } = require('./chunker');
const { PathwayResponseParser } = require('./pathwayResponseParser');
const { Prompt } = require('./prompt');
const { getv, setv } = require('../lib/keyValueStorageClient');

const MAX_PREVIOUS_RESULT_TOKEN_LENGTH = 1000;

const callPathway = async (config, pathwayName, requestState, { text, ...parameters }) => {
    const pathwayResolver = new PathwayResolver({ config, pathway: config.get(`pathways.${pathwayName}`), requestState });
    return await pathwayResolver.resolve({ text, ...parameters });
}

class PathwayResolver {
    constructor({ config, pathway, requestState }) {
        this.config = config;
        this.requestState = requestState;
        this.pathway = pathway;
        this.useInputChunking = pathway.useInputChunking;
        this.warnings = [];
        this.requestId = uuidv4();
        this.responseParser = new PathwayResponseParser(pathway);
        this.pathwayPrompter = new PathwayPrompter({ config, pathway });
        this.lastContext = '';
        this.prompts = [];
        this._pathwayPrompt = '';

        Object.defineProperty(this, 'pathwayPrompt', {
            get() {
                return this._pathwayPrompt;
            },
            set(value) {
                this._pathwayPrompt = value;
                if (!Array.isArray(this._pathwayPrompt)) {
                    this._pathwayPrompt = [this._pathwayPrompt];
                }
                this.prompts = this._pathwayPrompt.map(p => (p instanceof Prompt) ? p : new Prompt({ prompt:p }));
                this.usePreviousResult = this.prompts.some(object => object.usesPreviousResult);
            }
        });

        this.pathwayPrompt = pathway.prompt;
    }

    async resolve(args) {
        if (args.async) {
            // Asynchronously process the request
            this.promptAndParse(args).then((data) => {
                this.requestState[this.requestId].data = data;
                pubsub.publish('REQUEST_PROGRESS', {
                    requestProgress: {
                        requestId: this.requestId,
                        data: JSON.stringify(data)
                    }
                });
            });

            return this.requestId;
        }
        else {
            // Syncronously process the request
            return await this.promptAndParse(args);
        }
    }

    async promptAndParse(args) {
        // Get saved context
        const { contextId } = args;
        if (contextId) {
            this.savedContextId = contextId;
            try { // try to get the savedContext from the store
                this.savedContext = await getv(contextId) || null;
            } catch (e) {
                throw new Error(`Context ${contextId} not found`);
            }
        } else {
            this.savedContextId = null;
            this.savedContext = {};
        }
        const savedContextStr = JSON.stringify(this.savedContext); //store original state as string

        // Process the request
        const data = await this.processRequest(args);

        // Update saved context if needed, generating a new contextId if necessary
        if (savedContextStr !== JSON.stringify(this.savedContext)) {
            this.savedContextId = this.savedContextId || uuidv4();
            setv(this.savedContextId, this.savedContext);
        }

        // Return the result
        return this.responseParser.parse(data);
    }

    getChunkMaxTokenLength() {
        const maxPromptTokenLength = Math.max(...this.prompts.map(({ prompt }) => encode(String(prompt)).length)) - (this.usePreviousResult ? MAX_PREVIOUS_RESULT_TOKEN_LENGTH : 0);
        const promptRatio = this.pathwayPrompter.getPromptTokenRatio();
        const maxChunkToken = promptRatio * this.pathwayPrompter.getModelMaxChunkTokenLength() - maxPromptTokenLength;
        if (maxChunkToken && maxChunkToken <= 0) { // prompt is too long covering all the input
            throw new Error(`Your prompt is too long! Split to multiple prompts or reduce length of your prompt, prompt length: ${maxPromptLength}`);
        }
        return maxChunkToken;
    }

            // Here we choose how to handle long input - either summarize or chunk
    processInputText(text) {
        const chunkMaxChunkTokenLength = this.getChunkMaxTokenLength();
        const encoded = encode(text);
        if (!this.useInputChunking || encoded.length <= chunkMaxChunkTokenLength) { // no chunking, return as is
            if (encoded.length >= chunkMaxChunkTokenLength) {
                const warnText = `Your input is possibly too long, truncating! Text length: ${text.length}`;
                this.warnings.push(warnText);
                console.warn(warnText);
                text = truncate(text, chunkMaxChunkTokenLength);
            }
            return [text];
        }

        // chunk the text and return the chunks with newline separators
        return getSemanticChunks({ text, maxChunkToken: chunkMaxChunkTokenLength });
    }

    truncate(str, n) {
        if (this.pathwayPrompter.promptParameters.truncateFromFront) {
            return getFirstNToken(str, n);
        }
        return getLastNToken(str, n);
    }

    async summarizeIfEnabled({ text, ...parameters }) {
        if (this.pathway.useInputSummarization) {
            return await callPathway(this.config, 'summary', this.requestState, { text, targetLength: 1000, ...parameters });
        }
        return text;
    }

    async processRequest({ text, ...parameters }) {

        text = await this.summarizeIfEnabled({ text, ...parameters }); // summarize if flag enabled
        const chunks = this.processInputText(text);

        const anticipatedRequestCount = chunks.length * this.prompts.length;

        if ((this.requestState[this.requestId] || {}).canceled) {
            throw new Error('Request canceled');
        }

        // Store the request state
        this.requestState[this.requestId] = { totalCount: anticipatedRequestCount, completedCount: 0 };

        // If pre information is needed, apply current prompt with previous prompt info, only parallelize current call
        if (this.pathway.usePreviousResult) {
            let previousResult = '';
            let result = '';

            for (let i = 0; i < this.prompts.length; i++) {
                // If the prompt doesn't contain {{text}} then we can skip the chunking, and also give that token space to the previous result
                if (!this.prompts[i].usesTextInput) {
                    // Limit context to it's N + text's characters
                    previousResult = this.truncate(previousResult, MAX_PREVIOUS_RESULT_TOKEN_LENGTH + this.getChunkMaxTokenLength());
                    result = await this.applyPrompt(this.prompts[i], null, { ...parameters, previousResult });
                } else {
                    // Limit context to N characters
                    previousResult = this.truncate(previousResult, MAX_PREVIOUS_RESULT_TOKEN_LENGTH);
                    result = await Promise.all(chunks.map(chunk =>
                        this.applyPrompt(this.prompts[i], chunk, { ...parameters, previousResult })));
                    result = result.join("\n\n")
                }

                // If this is any prompt other than the last, use the result as the previous context
                if (i < this.prompts.length - 1) {
                    previousResult = result;
                }
            }
            // store the previous context in the PathwayResolver
            this.lastContext = previousResult;
            return result;
        }

        // Paralellize chunks and for each chunk of text apply all prompts serially
        const data = await Promise.all(chunks.map(chunk =>
            this.applyPromptsSerially(chunk, parameters)));

        return data.join("\n\n");
    }

    async applyPromptsSerially(text, parameters) {
        let cumulativeText = text;
        for (const prompt of this.prompts) {
            cumulativeText = await this.applyPrompt(prompt, cumulativeText, parameters);
        }
        return cumulativeText;
    }

    async applyPrompt(prompt, text, parameters) {
        if (this.requestState[this.requestId].canceled) {
            return;
        }
        const result = await this.pathwayPrompter.execute(text, { ...parameters, ...this.savedContext }, prompt.prompt);
        this.requestState[this.requestId].completedCount++;

        const { completedCount, totalCount } = this.requestState[this.requestId];

        pubsub.publish('REQUEST_PROGRESS', {
            requestProgress: {
                requestId: this.requestId,
                progress: completedCount / totalCount,
            }
        });

        if (prompt.saveResultTo) {
            this.savedContext[prompt.saveResultTo] = result;
        }
        return result;
    }
}

module.exports = { PathwayResolver };
