const { PathwayPrompter } = require('./pathwayPrompter');
const { parseNumberedList, parseNumberedObjectList } = require('./parser')
const {
    v4: uuidv4,
} = require('uuid');
const pubsub = require('./pubsub');
const { encode } = require('gpt-3-encoder')
const { chunker, getLastNChar, estimateCharPerToken, getLastNToken, getSemanticChunks } = require('./chunker');

// TODO: Use redis or similar to store state
// in a multi-server environment
const requestState = {}

const MAX_PREVIOUS_CONTEXT_TOKEN_LENGTH = 1000;

class PathwayResponseParser {
    constructor(pathway) {
        this.pathway = pathway;
    }

    parse(data) {
        if (this.pathway.parser) {
            return this.pathway.parser(data);
        }

        if (this.pathway.list) {
            if (this.pathway.format) {
                return parseNumberedObjectList(data, this.pathway.format);
            }
            return parseNumberedList(data)
        }

        return data;
    }
}

class PathwayResolver {
    constructor({ config, pathway }) {
        this.pathway = pathway;
        this.useInputChunking = pathway.useInputChunking;
        this.warnings = [];
        this.responseParser = new PathwayResponseParser(pathway);
        this.pathwayPrompter = new PathwayPrompter({ config, pathway });
        this.lastContext = '';
        this.prompts = null;
        this._pathwayPrompt = '';

        Object.defineProperty(this, 'pathwayPrompt', {
            get() {
              return this._pathwayPrompt;
            },
            set(value) {
              this._pathwayPrompt = value;
              this.prompts = Array.isArray(this._pathwayPrompt) ? this._pathwayPrompt : [this._pathwayPrompt];
            }
          });
          
        this.pathwayPrompt = pathway.prompt;

    }

    async resolve(args, requestState) {
        const requestId = uuidv4();

        if (args.async) {
            // Asynchronously process the request
            this.promptAndParse(args, requestId, requestState).then((data) => {
                requestState[requestId].data = data;
                pubsub.publish('REQUEST_PROGRESS', {
                    requestProgress: {
                        requestId,
                        data: JSON.stringify(data)
                    }
                });
            });

            return requestId;
        }
        else {
            // Syncronously process the request
            return await this.promptAndParse(args, requestId, requestState);
        }
    }

    async promptAndParse(args, requestId, requestState) {
        const data = await this.processRequest(args, requestId, requestState);
        return this.responseParser.parse(data);
    }

    getChunkMaxTokenLength() {
        const maxPromptTokenLength = Math.max(...this.prompts.map(p => encode(String(p)).length)) - (this.usePreviousContext ? MAX_PREVIOUS_CONTEXT_TOKEN_LENGTH : 0);
        const promptRatio = this.pathwayPrompter.getPromptTokenRatio();
        const maxChunkToken = promptRatio * this.pathwayPrompter.getModelMaxChunkTokenLength() - maxPromptTokenLength;
        if (maxChunkToken && maxChunkToken <= 0) { // prompt is too long covering all the input
            throw new Error(`Your prompt is too long! Split to multiple prompts or reduce length of your prompt, prompt length: ${maxPromptLength}`);
        }
        return maxChunkToken;
    }

    chunkText(text) {
        const chunkMaxChunkTokenLength = this.getChunkMaxTokenLength();
        const encoded = encode(text);
        if (!this.useInputChunking || encoded.length <= chunkMaxChunkTokenLength) { // no chunking, return as is
            if (encoded.length >= chunkMaxChunkTokenLength) {
                const warnText = `Your input is possibly too long, truncating! Text length: ${text.length}`;
                this.warnings.push(warnText);
                console.warn(warnText);
                text = getLastNToken(text, chunkMaxChunkTokenLength);
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

    async processRequest({ text, ...parameters }, requestId, requestState) {
        const chunks = this.chunkText(text);

        const anticipatedRequestCount = chunks.length * this.prompts.length;

        if ((requestState[requestId] || {}).canceled) {
            throw new Error('Request canceled');
        }

        // Store the request state
        requestState[requestId] = { totalCount: anticipatedRequestCount, completedCount: 0 };

        // If pre information is needed, apply current prompt with previous prompt info, only parallelize current call
        if (this.pathway.usePreviousContext) {
            let previousContext = '';
            let result = '';

            for (let i = 0; i < this.prompts.length; i++) {
                // If the prompt doesn't contain {{text}} then we can skip the chunking, and also give that token space to the previous context
                if (this.prompts[i].indexOf("{{text}}") == -1) {
                    // Limit context to it's N + text's characters
                    previousContext = this.truncate(previousContext, MAX_PREVIOUS_CONTEXT_TOKEN_LENGTH + this.getChunkMaxTokenLength());
                    result = await this.applyPrompt(this.prompts[i], null, { ...parameters, previousContext }, requestId, requestState);   
                } else {
                    // Limit context to N characters
                    previousContext = this.truncate(previousContext, MAX_PREVIOUS_CONTEXT_TOKEN_LENGTH);
                    result = await Promise.all(chunks.map(chunk =>
                        this.applyPrompt(this.prompts[i], chunk, { ...parameters, previousContext }, requestId, requestState)));
                    result = result.join("\n\n")
                }

                // If this is any prompt other than the last, use the result as the previous context
                if (i < this.prompts.length - 1) {
                    previousContext = result;
                }
            }
            // store the previous context in the PathwayResolver
            this.lastContext = previousContext;
            return result;
        }

        // Paralellize chunks and for each chunk of text apply all prompts serially
        const data = await Promise.all(chunks.map(chunk =>
            this.applyPromptsSerially(chunk, parameters, requestId, requestState)));

        return data.join("\n\n");
    }

    async applyPromptsSerially(text, parameters, requestId, requestState) {
        let cumulativeText = text;
        for (const prompt of this.prompts) {
            cumulativeText = await this.applyPrompt(prompt, cumulativeText, parameters, requestId, requestState);
        }
        return cumulativeText;
    }

    async applyPrompt(prompt, text, parameters, requestId, requestState) {
        if (requestState[requestId].canceled) {
            return;
        }
        const result = await this.pathwayPrompter.execute(text, parameters, prompt);
        requestState[requestId].completedCount++;

        const { completedCount, totalCount } = requestState[requestId];

        pubsub.publish('REQUEST_PROGRESS', {
            requestProgress: {
                requestId,
                progress: completedCount / totalCount,
            }
        });
        return result;
    }
}

module.exports = { PathwayResolver };
