const { request } = require("../request");
const handlebars = require("handlebars");
const { getResponseResult } = require("./parser");
const { Exception } = require("handlebars");

class PathwayPrompter {
    constructor({ config, pathway }) {
        const defaultModel = config.get('default_model');
        this.model = config.get('models')[pathway.model || defaultModel];
        this.environmentVariables = config.getEnv();
        this.temperature = pathway.temperature;
        this.pathwayPrompt = pathway.prompt;
        this.pathwayName = pathway.name;
        this.promptParameters = {}
        if (pathway.parameters) { //process default params defined in pathway
            for (const [k, v] of Object.entries(pathway.parameters)) {
                this.promptParameters[k] = v.default ?? v;
            }
        }
        this.requestCount = 1
    }

    requestUrl() {
        const generateUrl = handlebars.compile(this.model.url);
        return generateUrl({ ...this.model, ...this.environmentVariables });
    }

    requestParameters(text, parameters, prompt) {
        let promptText;
        if (typeof (prompt) === 'function') {
            promptText = prompt(parameters);
        }
        else {
            promptText = prompt;
        }

        const interpolatePrompt = handlebars.compile(promptText);

        const combinedParameters = { ...this.promptParameters, ...parameters };
        const params = {
            prompt: interpolatePrompt({ ...combinedParameters, text }),
            max_tokens: 2048,
            // model: "text-davinci-002",
            temperature: this.temperature ?? 0.7,
            // "top_p": 1,
            // "n": 1,
            // "presence_penalty": 0,
            // "frequency_penalty": 0,
            // "best_of": 1,
        }

        // return { ...defaultParams, ...overrideParams };
        return params;
    }

    async execute(text, parameters, prompt) {
        const requestParameters = this.requestParameters(text, parameters, prompt);

        // Build headers by compiling handlebars
        const headers = {};
        for (const [key, value] of Object.entries(this.model.headers)) {
            headers[key] = handlebars.compile(value)({ ...this.environmentVariables });
        }

        const url = this.requestUrl(text);
        const params = { ...(this.model.params || {}), ...requestParameters }
        const data = await request({ url, params, headers });
        console.log(`=== ${this.pathwayName}.${this.requestCount++} ===`)
        console.log(`\x1b[36m${params.prompt}\x1b[0m`)
        console.log(`\x1b[34m> ${getResponseResult(data)}\x1b[0m`)

        if (data.error) {
            throw new Exception(`An error was returned from the server: ${JSON.stringify(data.error)}`);
        }

        return getResponseResult(data);
    }
}

module.exports = PathwayPrompter;
