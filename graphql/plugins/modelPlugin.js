// ModelPlugin.js
const handlebars = require('handlebars');
const { request } = require("../../lib/request");
const { encode } = require("gpt-3-encoder");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_PROMPT_TOKEN_RATIO = 0.5;

class ModelPlugin {
    constructor(config, pathway) {
        // If the pathway specifies a model, use that, otherwise use the default
        this.modelName = pathway.model || config.get('defaultModelName');
        // Get the model from the config
        this.model = config.get('models')[this.modelName];
        // If the model doesn't exist, throw an exception
        if (!this.model) {
            throw new Error(`Model ${this.modelName} not found in config`);
        }

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

        this.requestCount = 1;
        this.shouldCache = config.get('enableCache') && (pathway.enableCache || pathway.temperature == 0);
    }

    // Function to remove non-system messages until token length is less than target
    removeMessagesUntilTarget = (messages, targetTokenLength) => {
        let chatML = this.messagesToChatML(messages);
        let tokenLength = encode(chatML).length;
    
        while (tokenLength > targetTokenLength) {
            for (let i = 0; i < messages.length; i++) {
                if (messages[i].role !== 'system') {
                    messages.splice(i, 1);
                    chatML = this.messagesToChatML(messages);
                    tokenLength = encode(chatML).length;
                    break;
                }
            }
            if (messages.every(message => message.role === 'system')) {
                break; // All remaining messages are 'system', stop removing messages
            }
        }
        return messages;
    }

    //convert a messages array to a simple chatML format
    messagesToChatML = (messages) => {
        let output = "";
        if (messages && messages.length) {
            for (let message of messages) {
                output += (message.role && message.content) ? `<|im_start|>${message.role}\n${message.content}\n<|im_end|>\n` : `${message}\n`;
            }
            // you always want the assistant to respond next so add a
            // directive for that
            output += "<|im_start|>assistant\n";
        }
        return output;
    }

    getModelMaxTokenLength() {
        return (this.promptParameters.maxTokenLength ?? this.model.maxTokenLength ?? DEFAULT_MAX_TOKENS);
    }

    getPromptTokenRatio() {
        // TODO: Is this the right order of precedence? inputParameters should maybe be second?
        return this.promptParameters.inputParameters.tokenRatio ?? this.promptParameters.tokenRatio ?? DEFAULT_PROMPT_TOKEN_RATIO;
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
                const compileText = handlebars.compile(message.content);
                return {
                    role: message.role,
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
        const generateUrl = handlebars.compile(this.model.url);
        return generateUrl({ ...this.model, ...this.environmentVariables, ...this.config });
    }

    //simples form string single or list return
    parseResponse(data) {
        const { choices } = data;
        if (!choices || !choices.length) {
            if (Array.isArray(data) && data.length > 0 && data[0].translations) {
                return data[0].translations[0].text.trim();
            } else {
                return data;
            }
        }

        // if we got a choices array back with more than one choice, return the whole array
        if (choices.length > 1) {
            return choices;
        }

        // otherwise, return the first choice
        const textResult = choices[0].text && choices[0].text.trim();
        const messageResult = choices[0].message && choices[0].message.content && choices[0].message.content.trim();

        return messageResult ?? textResult ?? null;
    }

    logRequestData(data, responseData, prompt) {
        const separator = `\n=== ${this.pathwayName}.${this.requestCount++} ===\n`;
        console.log(separator);
    
        const modelInput = data.prompt || (data.messages && data.messages[0].content) || (data.length > 0 && data[0].Text) || null;
    
        if (data.messages && data.messages.length > 1) {
            data.messages.forEach((message, index) => {
                const words = message.content.split(" ");
                const tokenCount = encode(message.content).length;
                const preview = words.length < 41 ? message.content : words.slice(0, 20).join(" ") + " ... " + words.slice(-20).join(" ");
    
                console.log(`\x1b[36mMessage ${index + 1}: Role: ${message.role}, Tokens: ${tokenCount}, Content: "${preview}"\x1b[0m`);
            });
        } else {
            console.log(`\x1b[36m${modelInput}\x1b[0m`);
        }
    
        console.log(`\x1b[34m> ${this.parseResponse(responseData)}\x1b[0m`);
    
        prompt.debugInfo += `${separator}${JSON.stringify(data)}`;
    }
    
    async executeRequest(url, data, params, headers, prompt) {
        const responseData = await request({ url, data, params, headers, cache: this.shouldCache }, this.modelName);
        
        if (responseData.error) {
            throw new Exception(`An error was returned from the server: ${JSON.stringify(responseData.error)}`);
        }
    
        this.logRequestData(data, responseData, prompt);
        return this.parseResponse(responseData);
    }

}

module.exports = ModelPlugin;

  