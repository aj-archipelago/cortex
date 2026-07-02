// OpenAIChatPlugin.js
import OpenAIChatPlugin from './openAiChatPlugin.js';

class OpenAIChatExtensionPlugin extends OpenAIChatPlugin {
    constructor(pathway, model) {
        super(pathway, model);
        this.tool = '';
    }

    // Parse the response from the OpenAI Extension API
    parseResponse(data) {
        const { choices } = data;
        if (!choices || !choices.length) {
            return data;
        }

        // if we got a choices array back with more than one choice, return the whole array
        if (choices.length > 1) {
            return choices;
        }

        // otherwise, return the first choice messages based on role
        const messageResult = [];
        for(const message of choices[0].messages) {
            if(message.role === "tool"){
                this.tool = message.content;
            }else{
                messageResult.push(message.content);
            }
        }
        return messageResult.join('\n\n') ?? null;
    }

    // Set up parameters specific to the OpenAI Chat API
    getRequestParameters(text, parameters, prompt) {
        const reqParams = super.getRequestParameters(text, parameters, prompt);
        reqParams.dataSources = this.model.dataSources || reqParams.dataSources || []; // add dataSources to the request parameters
        const {roleInformation, indexName, semanticConfiguration } = parameters; // add roleInformation and indexName to the dataSource if given
        for(const dataSource of reqParams.dataSources) {
            if(!dataSource) continue;
            if(!dataSource.parameters) dataSource.parameters = {};
            roleInformation && (dataSource.parameters.roleInformation = roleInformation);
            indexName && (dataSource.parameters.indexName = indexName);
            semanticConfiguration && (dataSource.parameters.semanticConfiguration = semanticConfiguration);
            dataSource.parameters.queryType = semanticConfiguration ? 'semantic' : 'simple';
        }
        return reqParams;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const result = await super.execute(text, parameters, prompt, cortexRequest);
        cortexRequest.pathwayResolver.tool = this.tool; // add tool info back 
        return result;
    }

}

export default OpenAIChatExtensionPlugin;
