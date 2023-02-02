const PathwayPrompter = require('./pathwayPrompter');
const nlp = require('compromise')
const plugin = require('compromise-paragraphs');
const { parseNumberedList, parseNumberedObjectList } = require('./parser')
const {
    v4: uuidv4,
} = require('uuid');
const pubsub = require('./pubsub');
nlp.extend(plugin);

// TODO: Use redis or similar to store state
// in a multi-server environment
const requestState = {}

const DEFAULT_CHUNK_LENGTH = 1500;
const MAX_PREVIOUS_CONTEXT_LENGTH = 500;

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
        this.responseParser = new PathwayResponseParser(pathway);
        this.pathwayPrompter = new PathwayPrompter({ config, pathway });

        const pathwayPrompt = pathway.prompt;

        // Normalize prompts to an array
        this.prompts = Array.isArray(pathwayPrompt) ?
            pathwayPrompt :
            [pathwayPrompt];
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

    chunkText(text) {
        const maxPromptLength = Math.max(...this.prompts.map(p => p.length)) - (this.usePreviousContext ? MAX_PREVIOUS_CONTEXT_LENGTH : 0); // longest prompt
        const maxChunkLength = (this.pathwayPrompter.model.maxChunkLength ?? this.DEFAULT_CHUNK_LENGTH) - maxPromptLength; 
        if (maxChunkLength <= 0) { // prompt is too long covering all the input
            throw new Error(`Your prompt is too long! Split or reduce length of your prompt, long prompt length: ${maxPromptLength}`);
        }
        if (!this.useInputChunking) { // no chunking, return as is
            if (text.length >= maxChunkLength) {
                console.warn(`Your input is possibly too long! Length: ${text.length}`);
            }
            return [text];
        }

        // Chunk input into paragraphs if needed
        let paragraphChunks = nlp(text).paragraphs().views.map(v => v.text());

        // Chunk paragraphs into sentences if needed
        const sentenceChunks = [];
        for (let i = 0; i < paragraphChunks.length; i++) {
            if (paragraphChunks[i].length > maxChunkLength) { // too long paragraph, chunk into sentences
                sentenceChunks.push(...nlp(paragraphChunks[i]).sentences().json().map(v => v.text));
            } else {
                sentenceChunks.push(paragraphChunks[i]);
            }
        }

        // Chunk sentences with newlines if needed
        const newlineChunks = [];
        for (let i = 0; i < sentenceChunks.length; i++) {
            if (sentenceChunks[i].length > maxChunkLength) { // too long, split into lines
                newlineChunks.push(...sentenceChunks[i].split('\n'));
            } else {
                newlineChunks.push(sentenceChunks[i]);
            }
        }

        // Chunk sentences into word chunks if needed
        let chunks = [];
        for (let j = 0; j < newlineChunks.length; j++) {
            if (newlineChunks[j].length > maxChunkLength) { // too long sentence, chunk into words
                const words = newlineChunks[j].split(' ');
                // merge words into chunks up to maxChunkLength
                let chunk = '';
                for (let k = 0; k < words.length; k++) {
                    if (chunk.length + words[k].length > maxChunkLength) {
                        chunks.push(chunk.trim());
                        chunk = '';
                    }
                    chunk += words[k] + ' ';
                }
                if (chunk.length > 0) {
                    chunks.push(chunk.trim());
                }
            } else {
                chunks.push(newlineChunks[j]);
            }
        }

        chunks = chunks.filter(Boolean).map(chunk => '\n' + chunk + '\n'); //filter empty chunks and add newlines

        // Merge chunks into maxChunkLength chunks
        let mergedChunks = [];
        let chunk = '';
        for (let i = 0; i < chunks.length; i++) {
            if (chunk.length + chunks[i].length > maxChunkLength) {
                mergedChunks.push(chunk);
                chunk = '';
            }
            chunk += chunks[i];
        }
        if (chunk.length > 0) {
            mergedChunks.push(chunk);
        }
        return mergedChunks;
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
            for (let i = 0; i < this.prompts.length; i++) {
                if (previousContext.length > MAX_PREVIOUS_CONTEXT_LENGTH) {
                    //slice previous context to avoid max token limit but keep the last n characters up to a \n or space to avoid cutting words
                    previousContext = previousContext.slice(-MAX_PREVIOUS_CONTEXT_LENGTH);
                    previousContext = previousContext.slice(previousContext.search(/\s/)+1);
                }

                // If the prompt doesn't contain {{text}} then we can skip the chunking
                if (this.prompts[i].indexOf("{{text}}") == -1) {
                    previousContext = await this.applyPrompt(this.prompts[i], null, { ...parameters, previousContext }, requestId, requestState);   
                } else {
                    previousContext = await Promise.all(chunks.map(chunk =>
                        this.applyPrompt(this.prompts[i], chunk, { ...parameters, previousContext }, requestId, requestState)));
                    previousContext = previousContext.join("\n\n")
                }
            }
            return previousContext;
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
