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

const MAX_CHUNK_LENGTH = 1000;

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
        this.enableChunking = pathway.chunk;
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
        if (!this.enableChunking && text.length < MAX_CHUNK_LENGTH) { // no chunking, return as is
            return [text];
        } 

        // Chunk input into paragraphs if needed
        let paragraphChunks = nlp(text).paragraphs().views.map(v => v.text());

        // Chunk paragraphs into sentences if needed
        const sentenceChunks = [];
        for (let i = 0; i < paragraphChunks.length; i++) {
            if (paragraphChunks[i].length > MAX_CHUNK_LENGTH) { // too long paragraph, chunk into sentences
                sentenceChunks.push(...nlp(paragraphChunks[i]).sentences().json().map(v => v.text));
            } else {
                sentenceChunks.push(paragraphChunks[i]);
            }
        }

        // Chunk sentences into word chunks if needed
        const chunks = [];
        for (let j = 0; j < sentenceChunks.length; j++) {
            if (sentenceChunks[j].length > MAX_CHUNK_LENGTH) { // too long sentence, chunk into words
                const words = sentenceChunks[j].split(' ');
                // merge words into chunks up to MAX_CHUNK_LENGTH
                let chunk = '';
                for (let k = 0; k < words.length; k++) {
                    if (chunk.length + words[k].length > MAX_CHUNK_LENGTH) {
                        chunks.push(chunk.trim());
                        chunk = '';
                    }
                    chunk += words[k] + ' ';
                }
                if (chunk.length > 0) {
                    chunks.push(chunk.trim());
                }
            } else {
                chunks.push(sentenceChunks[j]);
            }
        }

        return chunks.map(chunk => '\n\n' + chunk + '\n\n');
    }

    async processRequest({ text, ...parameters }, requestId, requestState) {
        const chunks = this.chunkText(text);

        const anticipatedRequestCount = chunks.length * this.prompts.length;

        if ((requestState[requestId] || {}).canceled) {
            throw new Error('Request canceled');
        }

        // Store the request state
        requestState[requestId] = { totalCount: anticipatedRequestCount, completedCount: 0 };

        // To each paragraph of text, apply all prompts serially
        const data = await Promise.all(chunks.map(paragraph =>
            this.applyPromptsSerially(paragraph, parameters, requestId, requestState)));

        return data.join("\n\n");
    }

    async applyPromptsSerially(text, parameters, requestId, requestState) {
        let cumulativeText = text;
        for (const prompt of this.prompts) {
            if (requestState[requestId].canceled) {
                return;
            }

            cumulativeText = await this.pathwayPrompter.execute(cumulativeText, parameters, prompt);
            requestState[requestId].completedCount++;

            const { completedCount, totalCount } = requestState[requestId];

            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    progress: completedCount / totalCount,
                }
            });

        }
        return cumulativeText;
    }
}

module.exports = { PathwayResolver };