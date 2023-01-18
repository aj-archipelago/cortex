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

// parse response based on pathway definition
const parseResponse = (args) => {
    const { pathway, data } = args;
    if (pathway.parser) {
        return pathway.parser(data);
    }

    if (pathway.list) {
        if (pathway.format) {
            return parseNumberedObjectList(data, pathway.format);
        }
        return parseNumberedList(data)
    }

    return data;
};


class PathwayResolver {
    constructor({ config, pathway }) {
        this.pathway = pathway;
        this.pathwayPrompt = pathway.prompt;
        this.responseParser = pathway.parser;
        this.enableChunking = pathway.chunk;
        this.returnType = pathway.returnType?.type ?? 'string';

        this.pathwayPrompter = new PathwayPrompter({ config, pathway });

        // Normalize prompts to an array
        this.prompts = Array.isArray(this.pathwayPrompt) ?
            this.pathwayPrompt :
            [this.pathwayPrompt];
    }

    async resolve(args) {
        const data = await this.processRequest(args);
        return parseResponse({ pathway: this.pathway, pathwayResolver: this, data })
    }

    async processRequest({ text, ...parameters }) {
        const requestId = uuidv4();

        if (args.async) {
            // Asynchronously process the request
            this.requestAndParse(args, requestId).then((data) => {
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
            return await this.requestAndParse(args, requestId);
        }
    }

    async requestAndParse(args, requestId) {
        const data = await this.processRequest(args, this.enableChunking, requestId);
        const reprompt = (params) => this.processRequest(params, this.enableChunking, requestId);

        // If a parser is defined, use it to parse the data
        if (this.responseParser) {
            return await this.responseParser(
                // data returned from the model
                data,
                // function to reprompt the model - the parser can prompt the model
                // again with different parameters
                reprompt);
        }

        // If the pathway is configured to return a list, parse the data
        // using the defautl list parser
        if (this.returnType === 'list') {
            return parseNumberedList(data)
        }

        // Otherwise, return the data as is
        return data;
    }

    async processRequest({ text, ...parameters }, enableChunking, requestId) {
        // Chunk input into paragraphs if needed
        let paragraphs = this.enableChunking ?
            nlp(text).paragraphs().views.map(v => v.text()) :
            [text];

        const anticipatedRequestCount = paragraphs.length * this.prompts.length;

        // Store the request state
        requestState[requestId] = { totalCount: anticipatedRequestCount, completedCount: 0 };

        // To each paragraph of text, apply all prompts serially
        const data = await Promise.all(paragraphs.map(paragraph =>
            this.applyPromptsSerially(paragraph, parameters, requestId)));

        return data.join("\n\n");
    }

    async applyPromptsSerially(text, parameters, requestId) {
        let cumulativeText = text;
        for (const prompt of this.prompts) {
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
