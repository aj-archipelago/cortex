// OpenAICompletionPlugin.js
const ModelPlugin = require('./modelPlugin');
const handlebars = require("handlebars");
const { encode } = require("gpt-3-encoder");
const FormData = require('form-data');
const fs = require('fs');
const { splitMediaFile, deleteTempFolder } = require('../../lib/fileChunker');

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

        const processChunk = async (chunk) => {
            try {
                const formData = new FormData();
                // for (const key in data) {
                //     formData.append(key, data[key]);
                // }

                formData.append('file', fs.createReadStream(chunk));//fs.createReadStream(parameters.file)
                formData.append('model', this.model.params.model);
                formData.append('response_format', 'text');

                return this.executeRequest(url, formData, params, { ...this.model.headers, ...formData.getHeaders() });
            } catch (err) {
                console.log(err);
            }
        }

        const { chunks, folder } = await splitMediaFile(parameters.file);
        const result = await Promise.all(chunks.map(processChunk));
        await deleteTempFolder(folder);
        return result.join('');
    }
}

module.exports = OpenAIWhisperPlugin;

