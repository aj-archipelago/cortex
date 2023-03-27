// OpenAICompletionPlugin.js
const ModelPlugin = require('./modelPlugin');
const handlebars = require("handlebars");
const { encode } = require("gpt-3-encoder");
const FormData = require('form-data');
const fs = require('fs');
const { splitMediaFile, isValidYoutubeUrl, processYoutubeUrl, deleteTempPath } = require('../../lib/fileChunker');
const pubsub = require('../pubsub');

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
    async execute(text, parameters, prompt, pathwayResolver) {
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

        let result;
        let { file } = parameters;
        let folder;
        const isYoutubeUrl = isValidYoutubeUrl(file);

        try {
            if (isYoutubeUrl) {
                file = await processYoutubeUrl(file);
            }

            const mediaSplit = await splitMediaFile(file);

            const { requestId } = pathwayResolver;
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    progress: 0.5,
                    data: null,
                }
            });

            folder = mediaSplit.folder;
            result = await Promise.all(mediaSplit.chunks.map(processChunk));

        } catch (error) {
            console.error("An error occurred:", error);
        } finally {
            isYoutubeUrl && (await deleteTempPath(file));
            folder && (await deleteTempPath(folder));
        }
        return result.join('');
    }
}

module.exports = OpenAIWhisperPlugin;

