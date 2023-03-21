// OpenAICompletionPlugin.js
const ModelPlugin = require('./modelPlugin');
const handlebars = require("handlebars");
const { encode } = require("gpt-3-encoder");
const FormData = require('form-data'); 
const fs = require('fs');

class OpenAIWhisperPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Set up parameters specific to the OpenAI Whisper API
    requestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const modelPrompt = this.getModelPrompt(prompt, parameters);
        const modelPromptText = modelPrompt.prompt ? handlebars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';

        const { file, model } = combinedParameters;

        return {
            file,
            model
        };
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt) {
        const url = this.requestUrl(text);
        const requestParameters = this.requestParameters(text, parameters, prompt);
        const params = {};

        const data = { ...(this.model.params || {}), ...requestParameters };
        // data.file = fs.createReadStream(data.file);

        try{
            const form = new FormData();
            // for (const key in data) {
            //     form.append(key, data[key]);
            // }
            form.append('file', fs.createReadStream(parameters.file));
            form.append('model', this.model.params.model);
            form.append('response_format', 'text');

            return this.executeRequest(url, form, params, { ...this.model.headers, ...form.getHeaders() });
        } catch (err) {
            console.log(err);
        }
    }
}

module.exports = OpenAIWhisperPlugin;

