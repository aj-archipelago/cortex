// ModelPlugin.js
const handlebars = require('handlebars');
const { request } = require("../../lib/request");

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

    async executeRequest(url, data, params, headers) {
        const responseData = await request({ url, data, params, headers, cache: this.shouldCache }, this.modelName);
        const modelInput = data.prompt || (data.messages && data.messages[0].content) || data[0].Text || null;
        console.log(`=== ${this.pathwayName}.${this.requestCount++} ===`)
        console.log(`\x1b[36m${modelInput}\x1b[0m`)
        console.log(`\x1b[34m> ${this.parseResponse(responseData)}\x1b[0m`);

        if (responseData.error) {
            throw new Exception(`An error was returned from the server: ${JSON.stringify(responseData.error)}`);
        }

        return this.parseResponse(responseData);
    }

}

module.exports = ModelPlugin;

  