// OpenAiEmbeddingsPlugin.js
import ModelPlugin from './modelPlugin.js';

class OpenAiEmbeddingsPlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, combinedParameters, prompt);
        const requestParameters = {
            data:  {
                input: combinedParameters?.input?.length ? combinedParameters.input :  modelPromptText || text,
            }
        };
        return requestParameters;
    }

    async execute(text, parameters, prompt, pathwayResolver) {
        const { requestId, pathway} = pathwayResolver;
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const url = this.requestUrl();

        const data = requestParameters.data || {};
        const params = requestParameters.params || {};
        const headers = this.model.headers || {};

        return this.executeRequest(url, data, params, headers, prompt, requestId, pathway);
    }

    parseResponse(data) {
        return JSON.stringify(data?.data?.map( ({embedding}) => embedding) || []);
    }

}

export default OpenAiEmbeddingsPlugin;
