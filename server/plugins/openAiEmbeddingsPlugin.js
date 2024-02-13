// OpenAiEmbeddingsPlugin.js
import ModelPlugin from './modelPlugin.js';

class OpenAiEmbeddingsPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
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

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = requestParameters.data || {};
        cortexRequest.params = requestParameters.params || {};

        return this.executeRequest(cortexRequest);
    }

    parseResponse(data) {
        return JSON.stringify(data?.data?.map( ({embedding}) => embedding) || []);
    }

}

export default OpenAiEmbeddingsPlugin;
