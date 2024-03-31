import OpenAIVisionPlugin from './openAiVisionPlugin.js';

class Claude3VertexPlugin extends OpenAIVisionPlugin {

    parseResponse(data) 
    {
        if (!data) {
            return data;
        }

        const { content } = data;

        // if the response is an array, return the text property of the first item
        // if the type property is 'text'
        if (content && Array.isArray(content) && content[0].type === 'text') {
            return content[0].text;
        } else {
            return data;
        }
    }

    // This code converts messages to the format required by the Claude Vertex API
    convertMessagesToClaudeVertex(messages) {
        let modifiedMessages = [];
        let system = '';
        let lastAuthor = '';

        // Claude needs system messages in a separate field
        const systemMessages = messages.filter(message => message.role === 'system');
        if (systemMessages.length > 0) {
            system = systemMessages.map(message => message.content).join('\n');
            modifiedMessages = messages.filter(message => message.role !== 'system');
        } else {
            modifiedMessages = messages;
        }

        // remove any empty messages
        modifiedMessages = modifiedMessages.filter(message => message.content);

        // combine any consecutive messages from the same author
        var combinedMessages = [];

        modifiedMessages.forEach((message) => {
        if (message.role === lastAuthor) {
            combinedMessages[combinedMessages.length - 1].content += '\n' + message.content;
        } else {
            combinedMessages.push(message);
            lastAuthor = message.role;
        }
        });

        modifiedMessages = combinedMessages;

        // Claude vertex requires an even number of messages
        if (modifiedMessages.length % 2 === 0) {
            modifiedMessages = modifiedMessages.slice(1);
        }

        return {
            system,
            modifiedMessages,
        };
    }

    getRequestParameters(text, parameters, prompt, cortexRequest) {
        const requestParameters = super.getRequestParameters(text, parameters, prompt, cortexRequest);
        const { system, modifiedMessages } = this.convertMessagesToClaudeVertex(requestParameters.messages);
        requestParameters.system = system;
        requestParameters.messages = modifiedMessages;  
        requestParameters.max_tokens = this.getModelMaxReturnTokens();
        requestParameters.anthropic_version = 'vertex-2023-10-16';
        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt, cortexRequest);
        const { stream } = parameters;

        cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters };
        cortexRequest.params = {}; // query params
        cortexRequest.stream = stream;
        cortexRequest.url = cortexRequest.stream ? `${cortexRequest.url}:streamRawPredict` : `${cortexRequest.url}:rawPredict`;

        const gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
        const authToken = await gcpAuthTokenHelper.getAccessToken();
        cortexRequest.headers.Authorization = `Bearer ${authToken}`;

        return this.executeRequest(cortexRequest);
    }

    processStreamEvent(event, requestProgress) {
        const eventData = JSON.parse(event.data);
        switch (eventData.type) {
            case 'message_start':
                requestProgress.data = JSON.stringify(eventData.message);
                break;
            case 'content_block_start':
                break;
            case 'ping':
                break;
            case 'content_block_delta':
                if (eventData.delta.type === 'text_delta') {
                    requestProgress.data = JSON.stringify(eventData.delta.text);
                }
                break;
            case 'content_block_stop':
                break;
            case 'message_delta':
                break;
            case 'message_stop':
                requestProgress.data = '[DONE]';
                requestProgress.progress = 1;
                break;
            case 'error':
                requestProgress.data = `\n\n*** ${eventData.error.message || eventData.error} ***`;
                requestProgress.progress = 1;
                break;
        }

        return requestProgress;

    }

}

export default Claude3VertexPlugin;
