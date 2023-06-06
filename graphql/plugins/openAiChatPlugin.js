// OpenAIChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import HandleBars from '../../lib/handleBars.js';
import { encode } from 'gpt-3-encoder';

class OpenAIChatPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Handlebars compiler for prompt messages array (OpenAI chat specific)
    getModelPromptMessages(modelPrompt, combinedParameters, text) {
        if (!modelPrompt.messages) {
            return null;
        }

        // First run handlebars compile on the pathway messages
        const compiledMessages = modelPrompt.messages.map((message) => {
            if (message.content) {
                const compileText = HandleBars.compile(message.content);
                return {
                    ...message,
                    content: compileText({ ...combinedParameters, text }),
                };
            } else {
                return message;
            }
        });

        // Next add in any parameters that are referenced by name in the array
        const expandedMessages = compiledMessages.flatMap((message) => {
            if (typeof message === 'string') {
                const match = message.match(/{{(.+?)}}/);
                const placeholder = match ? match[1] : null;
                if (placeholder === null) {
                    return message;
                } else {
                    return combinedParameters[placeholder] || [];
                }
            } else {
                return [message];
            }
        });

        // Check if the messages are in Palm format and convert them to OpenAI format if necessary
        const isPalmFormat = expandedMessages.some(message => 'author' in message);
        if (isPalmFormat) {
            const context = modelPrompt.context || '';
            const examples = modelPrompt.examples || [];
            return this.convertPalmToOpenAIMessages(context, examples, expandedMessages);
        }

        return expandedMessages;
    }

    // Set up parameters specific to the OpenAI Chat API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText, modelPromptMessages, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        const { stream } = parameters;
    
        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
    
        let requestMessages = modelPromptMessages || [{ "role": "user", "content": modelPromptText }];
    
        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength) {
            // Remove older messages until the token length is within the model's limit
            requestMessages = this.truncateMessagesToTargetLength(requestMessages, modelTargetTokenLength);
        }
    
        const requestParameters = {
        messages: requestMessages,
        temperature: this.temperature ?? 0.7,
        ...(stream !== undefined ? { stream } : {}),
        };
    
        return requestParameters;
    }

    // Execute the request to the OpenAI Chat API
    async execute(text, parameters, prompt) {
        const url = this.requestUrl(text);
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = this.model.headers || {};
        return this.executeRequest(url, data, params, headers, prompt);
    }

    // Parse the response from the OpenAI Chat API
    parseResponse(data) {
        const { choices } = data;
        if (!choices || !choices.length) {
            return null;
        }

        // if we got a choices array back with more than one choice, return the whole array
        if (choices.length > 1) {
            return choices;
        }

        // otherwise, return the first choice
        const messageResult = choices[0].message && choices[0].message.content && choices[0].message.content.trim();
        return messageResult ?? null;
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        const separator = `\n=== ${this.pathwayName}.${this.requestCount++} ===\n`;
        console.log(separator);
    
        if (data && data.messages && data.messages.length > 1) {
            data.messages.forEach((message, index) => {
                const words = message.content.split(" ");
                const tokenCount = encode(message.content).length;
                const preview = words.length < 41 ? message.content : words.slice(0, 20).join(" ") + " ... " + words.slice(-20).join(" ");
    
                console.log(`\x1b[36mMessage ${index + 1}: Role: ${message.role}, Tokens: ${tokenCount}, Content: "${preview}"\x1b[0m`);
            });
        } else {
            console.log(`\x1b[36m${data.messages[0].content}\x1b[0m`);
        }
    
        console.log(`\x1b[34m> ${this.parseResponse(responseData)}\x1b[0m`);
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `${separator}${JSON.stringify(data)}`);
    }
}

export default OpenAIChatPlugin;
