const { PathwayPrompter } = require('./pathwayPrompter');
const { parseNumberedList, parseNumberedObjectList } = require('./parser')
const {
    v4: uuidv4,
} = require('uuid');
const pubsub = require('./pubsub');
const { encode } = require('gpt-3-encoder')
const { chunker, getLastNChar, estimateCharPerToken, getFirstNToken, getLastNToken, getSemanticChunks } = require('./chunker');

// TODO: Use redis or similar to store state
// in a multi-server environment
const requestState = {}

const MAX_PREVIOUS_RESULT_TOKEN_LENGTH = 1000;


const callPathway = async (config, pathwayName, { text, ...parameters }) => {
    const pathwayResolver = new PathwayResolver({ config, pathway: config.get(`pathways.${pathwayName}`) });
    return await pathwayResolver.resolve({ text, ...parameters }, requestState);
}


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
        this.config = config;
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

    async resolve(args) {
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
        const maxPromptTokenLength = Math.max(...this.prompts.map(p => encode(String(p)).length)) - (this.usePreviousResult ? MAX_PREVIOUS_RESULT_TOKEN_LENGTH : 0);
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

    // function to check if a Handlebars template prompt contains a variable
    promptContains(variable, prompt) {
        const regexp = /{{+(.*?)}}+/g;
        let matches = [];
        let match;

        while ((match = regexp.exec(prompt)) !== null) {
            matches.push(match[1]);
        }

        const variables = matches.filter(function(varName) {
            return varName.indexOf("#") !== 0 && varName.indexOf("/") !== 0;
        })

        return variables.includes(variable);
    }

    async summarizeIfEnabled({ text, ...parameters }) {
        if (this.pathway.useInputSummarization) {
            return await callPathway(this.config, 'summary', { text, targetLength:1000, ...parameters });
        }
        return text;
    }

    async processRequest({ text, ...parameters }, requestId, requestState) {
        text = await this.summarizeIfEnabled({ text, ...parameters }, requestState); // summarize if flag enabled

        const chunks = this.chunkText(text);

        const anticipatedRequestCount = chunks.length * this.prompts.length;

        if ((requestState[requestId] || {}).canceled) {
            throw new Error('Request canceled');
        }

        // Store the request state
        requestState[requestId] = { totalCount: anticipatedRequestCount, completedCount: 0 };

        // If pre information is needed, apply current prompt with previous prompt info, only parallelize current call
        if (this.pathway.usePreviousResult) {
            let previousResult = '';
            let result = '';

            for (let i = 0; i < this.prompts.length; i++) {
                // If the prompt doesn't contain {{text}} then we can skip the chunking, and also give that token space to the previous context
                if (!this.promptContains('text', this.prompts[i])) {
                    // Limit context to it's N + text's characters
                    previousResult = this.truncate(previousResult, MAX_PREVIOUS_RESULT_TOKEN_LENGTH + this.getChunkMaxTokenLength());
                    result = await this.applyPrompt(this.prompts[i], null, { ...parameters, previousResult }, requestId, requestState);   
                } else {
                    // Limit context to N characters
                    previousResult = this.truncate(previousResult, MAX_PREVIOUS_RESULT_TOKEN_LENGTH);
                    result = await Promise.all(chunks.map(chunk =>
                        this.applyPrompt(this.prompts[i], chunk, { ...parameters, previousResult }, requestId, requestState)));
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

module.exports = { PathwayResolver, requestState };
