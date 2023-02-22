const { request } = require("../request");
const handlebars = require("handlebars");
const { getResponseResult } = require("./parser");
const { Exception } = require("handlebars");
const { encode } = require("gpt-3-encoder");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_PROMPT_TOKEN_RATIO = 0.5;

handlebars.registerHelper('stripHTML', function(value) {
    return value.replace(/<[^>]*>/g, '');
  });
  
class PathwayPrompter {
    constructor({ config, pathway }) {
        const defaultModel = config.get('default_model');
        this.modelName = pathway.model || defaultModel;
        this.model = config.get('models')[this.modelName];
        if (!this.model) {
            throw new Exception(`Model ${this.modelName} not found in config`);
        }
        this.environmentVariables = config.getEnv();
        this.temperature = pathway.temperature;
        this.pathwayPrompt = pathway.prompt;
        this.pathwayName = pathway.name;
        this.promptParameters = {}
        // Make all of the parameters defined on the pathway itself available to the prompt
        for (const [k, v] of Object.entries(pathway)) {
            this.promptParameters[k] = v.default ?? v;
        }
        if (pathway.inputParameters) {
            for (const [k, v] of Object.entries(pathway.inputParameters)) {
                this.promptParameters[k] = v.default ?? v;
            }
        }
        this.requestCount = 1
    }

    getModelMaxChunkTokenLength() {
        return (this.promptParameters.maxTokenLength ?? this.model.maxTokenLength ?? DEFAULT_MAX_TOKENS);
    }

    getPromptTokenRatio() {
        return this.promptParameters.inputParameters.tokenRatio ?? this.promptParameters.tokenRatio ?? DEFAULT_PROMPT_TOKEN_RATIO;
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
        const constructedPrompt = interpolatePrompt({ ...combinedParameters, text });
        const params = {
            prompt: constructedPrompt,
            max_tokens: this.getModelMaxChunkTokenLength() - encode(constructedPrompt).length -1,
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
        const data = await request({ url, params, headers }, this.modelName);
        console.log(`=== ${this.pathwayName}.${this.requestCount++} ===`)
        console.log(`\x1b[36m${params.prompt}\x1b[0m`)
        console.log(`\x1b[34m> ${getResponseResult(data)}\x1b[0m`)

        if (data.error) {
            throw new Exception(`An error was returned from the server: ${JSON.stringify(data.error)}`);
        }

        return getResponseResult(data);
    }
}

module.exports = {
    PathwayPrompter
}
