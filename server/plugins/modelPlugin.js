// ModelPlugin.js
import HandleBars from '../../lib/handleBars.js';

import { request } from '../../lib/request.js';
import { encode } from 'gpt-3-encoder';
import { getFirstNToken } from '../chunker.js';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETURN_TOKENS = 256;
const DEFAULT_PROMPT_TOKEN_RATIO = 0.5;

class ModelPlugin {
    constructor(config, pathway, modelName, model) {
        this.modelName = modelName;
        this.model = model;
        this.config = config;
        this.environmentVariables = config.getEnv();
        this.temperature = pathway.temperature;
        this.pathwayPrompt = pathway.prompt;
        this.pathwayName = pathway.name;
        this.promptParameters = {};

        // Make all of the parameters defined on the pathway itself available to the prompt
        for (const [k, v] of Object.entries(pathway)) {
            this.promptParameters[k] = v.default ?? v;
        }
        if (pathway.inputParameters) {
            for (const [k, v] of Object.entries(pathway.inputParameters)) {
                this.promptParameters[k] = v.default ?? v;
            }
        }

        this.requestCount = 0;
        this.lastRequestStartTime = new Date();
        this.shouldCache = config.get('enableCache') && (pathway.enableCache || pathway.temperature == 0);
    }

    truncateMessagesToTargetLength(messages, targetTokenLength) {
        // Calculate the token length of each message
        const tokenLengths = messages.map((message) => ({
            message,
            tokenLength: encode(this.messagesToChatML([message], false)).length,
        }));
    
        // Calculate the total token length of all messages
        let totalTokenLength = tokenLengths.reduce(
            (sum, { tokenLength }) => sum + tokenLength,
            0
        );
    
        // If we're already under the target token length, just bail
        if (totalTokenLength <= targetTokenLength) return messages;
    
        // Remove and/or truncate messages until the target token length is reached
        let index = 0;
        while ((totalTokenLength > targetTokenLength) && (index < tokenLengths.length)) {
            const message = tokenLengths[index].message;

            // Skip system messages
            if (message?.role === 'system') {
                index++;
                continue;
            }

            const currentTokenLength = tokenLengths[index].tokenLength;
            
            if (totalTokenLength - currentTokenLength >= targetTokenLength) {
                // Remove the message entirely if doing so won't go below the target token length
                totalTokenLength -= currentTokenLength;
                tokenLengths.splice(index, 1);
            } else {
                // Truncate the message to fit the remaining target token length
                const emptyContentLength = encode(this.messagesToChatML([{ ...message, content: '' }], false)).length;
                const otherMessageTokens = totalTokenLength - currentTokenLength;
                const tokensToKeep = targetTokenLength - (otherMessageTokens + emptyContentLength);

                if (tokensToKeep <= 0) {
                    // If the message needs to be empty to make the target, remove it entirely
                    totalTokenLength -= currentTokenLength;
                    tokenLengths.splice(index, 1);
                } else {
                    // Otherwise, update the message and token length
                    const truncatedContent = getFirstNToken(message.content, tokensToKeep);
                    const truncatedMessage = { ...message, content: truncatedContent };

                    tokenLengths[index] = {
                        message: truncatedMessage,
                        tokenLength: encode(this.messagesToChatML([ truncatedMessage ], false)).length
                    }

                    // calculate the length again to keep us honest
                    totalTokenLength = tokenLengths.reduce(
                        (sum, { tokenLength }) => sum + tokenLength,
                        0
                    );

                    index++;
                }
            }
        }
    
        // Return the modified messages array
        return tokenLengths.map(({ message }) => message);
    }
    
    //convert a messages array to a simple chatML format
    messagesToChatML(messages, addAssistant = true) {
        let output = "";
        if (messages && messages.length) {
            for (let message of messages) {
                output += ((message.author || message.role) && (message.content || message.content === '')) ? `<|im_start|>${(message.author || message.role)}\n${message.content}\n<|im_end|>\n` : `${message}\n`;
            }
            // you always want the assistant to respond next so add a
            // directive for that
            if (addAssistant) {
                output += "<|im_start|>assistant\n";
            }
        }
        return output;
    }

    // compile the Prompt    
    getCompiledPrompt(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const modelPrompt = this.getModelPrompt(prompt, parameters);
        const modelPromptText = modelPrompt.prompt ? HandleBars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';
        const modelPromptMessages = this.getModelPromptMessages(modelPrompt, combinedParameters, text);
        const modelPromptMessagesML = this.messagesToChatML(modelPromptMessages);

        if (modelPromptMessagesML) {
            return { modelPromptMessages, tokenLength: encode(modelPromptMessagesML).length, modelPrompt };
        } else {
            return { modelPromptText, tokenLength: encode(modelPromptText).length, modelPrompt };
        }
    }

    getModelMaxTokenLength() {
        return (this.promptParameters.maxTokenLength ?? this.model.maxTokenLength ?? DEFAULT_MAX_TOKENS);
    }

    getModelMaxReturnTokens() {
        return (this.promptParameters.maxReturnTokens ?? this.model.maxReturnTokens ?? DEFAULT_MAX_RETURN_TOKENS);
    }

    getPromptTokenRatio() {
        // TODO: Is this the right order of precedence? inputParameters should maybe be second?
        return this.promptParameters.inputParameters?.tokenRatio ?? this.promptParameters.tokenRatio ?? DEFAULT_PROMPT_TOKEN_RATIO;
    }

    getModelPrompt(prompt, parameters) {
        if (typeof(prompt) === 'function') {
            return prompt(parameters);
        } else {
            return prompt;
        }
    }

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
     
        return expandedMessages;
    }

    requestUrl() {
        const generateUrl = HandleBars.compile(this.model.url);
        return generateUrl({ ...this.model, ...this.environmentVariables, ...this.config });
    }

    // Default response parsing
    parseResponse(data) { return data; };

    // Default simple logging
    logRequestStart(url, data) {
        this.requestCount++;
        this.lastRequestStartTime = new Date();
        const logMessage = `>>> [${this.requestId}: ${this.pathwayName}.${this.requestCount}] request`;
        const header = '>'.repeat(logMessage.length);
        console.log(`\n${header}\n${logMessage}`);
        console.log(`>>> Making API request to ${url}`);
    };

    logAIRequestFinished() {
        const currentTime = new Date();
        const timeElapsed = (currentTime - this.lastRequestStartTime) / 1000;
        const logMessage = `<<< [${this.requestId}: ${this.pathwayName}] response - complete in ${timeElapsed}s - data:`;
        const header = '<'.repeat(logMessage.length);
        console.log(`\n${header}\n${logMessage}\n`);
    };

    logRequestData(data, responseData, prompt) {
        this.logAIRequestFinished(); 
        const modelInput = data.prompt || (data.messages && data.messages[0].content) || (data.length > 0 && data[0].Text) || null;
    
        if (modelInput) {
            console.log(`\x1b[36m${modelInput}\x1b[0m`);
        }
    
        console.log(`\x1b[34m> ${this.parseResponse(responseData)}\x1b[0m`);
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `${separator}${JSON.stringify(data)}`);
    }
    
    async executeRequest(url, data, params, headers, prompt, requestId, pathway) {
        this.aiRequestStartTime = new Date();
        this.requestId = requestId;
        this.logRequestStart(url, data);
        const responseData = await request({ url, data, params, headers, cache: this.shouldCache }, this.modelName, this.requestId, pathway);
        
        if (responseData.error) {
            throw new Error(`An error was returned from the server: ${JSON.stringify(responseData.error)}`);
        }
    
        this.logRequestData(data, responseData, prompt);
        return this.parseResponse(responseData);
    }

}

export default ModelPlugin;

  