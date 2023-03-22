// OpenAIChatPlugin.js
const ModelPlugin = require('./modelPlugin');
const handlebars = require("handlebars");

class OpenAIChatPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Set up parameters specific to the OpenAI Chat API
    requestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const modelPrompt = this.getModelPrompt(prompt, parameters);
        const modelPromptText = modelPrompt.prompt ? handlebars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';
        const modelPromptMessages = this.getModelPromptMessages(modelPrompt, combinedParameters, text);

        const { stream } = parameters;

        return {
            messages: modelPromptMessages || [{ "role": "user", "content": modelPromptText }],
            temperature: this.temperature ?? 0.7,
            stream
        };
    }

    // Execute the request to the OpenAI Chat API
    async execute(text, parameters, prompt) {
        const url = this.requestUrl(text);
        const requestParameters = this.requestParameters(text, parameters, prompt);

        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = this.model.headers || {};
        return this.executeRequest(url, data, params, headers);
    }
}

module.exports = OpenAIChatPlugin;
