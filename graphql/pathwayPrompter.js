const { request } = require("../lib/request");
const handlebars = require("handlebars");
const { getResponseResult, messagesToChatML } = require("./parser");
const { Exception } = require("handlebars");
const { encode } = require("gpt-3-encoder");
const pubsub = require("./pubsub");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_PROMPT_TOKEN_RATIO = 0.5;

// register functions that can be called directly in the prompt markdown
handlebars.registerHelper('stripHTML', function (value) {
    return value.replace(/<[^>]*>/g, '');
});

handlebars.registerHelper('now', function () {
    return new Date().toISOString();
});

class PathwayPrompter {
    constructor({ config, pathway }) {
        // If the pathway specifies a model, use that, otherwise use the default
        this.modelName = pathway.model || config.get('defaultModelName');
        // Get the model from the config
        this.model = config.get('models')[this.modelName];
        // If the model doesn't exist, throw an exception
        if (!this.model) {
            throw new Exception(`Model ${this.modelName} not found in config`);
        }
        this.environmentVariables = config.getEnv();
        this.pathway = pathway;
        this.temperature = pathway.temperature;
        this.pathwayPrompt = pathway.prompt;
        this.pathwayName = pathway.name;
        this.promptParameters = {}
        // Make all of the parameters defined on the pathway itself available to the prompt
        for (const [k, v] of Object.entries(pathway)) {
            this.promptParameters[k] = v.default ?? v;
        }
        if (pathway.inputParameters) {
            for (const [k, v] of Object.entries(pathway.inputParameters)) {
                this.promptParameters[k] = v.default ?? v;
            }
        }
        this.requestCount = 1
        this.shouldCache = config.get('enableCache') && (pathway.enableCache || pathway.temperature == 0);
    }

    getModelMaxTokenLength() {
        return (this.promptParameters.maxTokenLength ?? this.model.maxTokenLength ?? DEFAULT_MAX_TOKENS);
    }

    getPromptTokenRatio() {
        return this.promptParameters.inputParameters.tokenRatio ?? this.promptParameters.tokenRatio ?? DEFAULT_PROMPT_TOKEN_RATIO;
    }

    requestUrl() {
        const generateUrl = handlebars.compile(this.model.url);
        return generateUrl({ ...this.model, ...this.environmentVariables, ...this.config });
    }

    requestParameters(text, parameters, prompt) {
        // the prompt object is polymorphic, so we need to sort it out here
        // it can be a function that returns a prompt object or it can be a prompt object
        let modelPrompt;

        if (typeof (prompt) === 'function') {
            modelPrompt = prompt(parameters);
        } else {
            modelPrompt = prompt;
        }

        const combinedParameters = { ...this.promptParameters, ...parameters };
        const stream = combinedParameters.stream ?? false;
        // now, the resulting model prompt can either have prompt or messages
        // properties depending on the API of the model for this pathway


        const modelPromptText = modelPrompt.prompt ? handlebars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';

        let modelPromptMessages, modelPromptMessagesML;

        if (modelPrompt.messages) {
            // we support a markdown-like syntax for messages in which the author
            // can use a Handlebars-like syntax to insert parameters into the array
            // first we need to expand those directives in the messages array
            const expandedMessages = modelPrompt.messages.flatMap((message) => {
                if (typeof message === 'string') {
                    const match = message.match(/{{(.+?)}}/);
                    const placeholder = match ? match[1] : null;
                    if (placeholder === null) {
                        return message
                    } else {
                        return combinedParameters[placeholder] || [];
                    }
                } else {
                    return [message];
                }
            });

            modelPromptMessages =
                expandedMessages.map((message) => {
                    if (message.content) {
                        const compileText = handlebars.compile(message.content);
                        return {
                            role: message.role,
                            content: compileText({ ...combinedParameters, text })
                        }
                    } else {
                        const compileText = handlebars.compile(message);
                        return compileText({ ...combinedParameters, text });
                    }
                });

            modelPromptMessagesML = messagesToChatML(modelPromptMessages);
        };

        if (this.model.type === 'OPENAI_CHAT') {
            // if it's a chat-style API, we always try to use the messages array
            // first if possible, otherwise we shoe-horn the prompt into the messages
            return {
                messages: modelPromptMessages || [{ "role": "user", "content": modelPromptText }],
                temperature: this.temperature ?? 0.7,
                stream
            }

        } else {
            // even if it's a completion style prompt, if the user specified a messages
            // array, that wins.  We just need to use the chatML version.
            if (modelPromptMessagesML) {
                return {
                    prompt: modelPromptMessagesML,
                    max_tokens: this.getModelMaxTokenLength() - encode(modelPromptMessagesML).length - 1,
                    temperature: this.temperature ?? 0.7,
                    top_p: 0.95,
                    frequency_penalty: 0,
                    presence_penalty: 0,
                    stop: ["<|im_end|>"],
                    stream
                }
            } else {
                return {
                    prompt: modelPromptText,
                    max_tokens: this.getModelMaxTokenLength() - encode(modelPromptText).length - 1,
                    temperature: this.temperature ?? 0.7,
                    stream
                }
            }
        }
    }

    async execute(text, parameters, prompt) {
        const requestParameters = this.requestParameters(text, parameters, prompt);

        const url = this.requestUrl(text);
        const params = { ...(this.model.params || {}), ...requestParameters }
        const headers = this.model.headers || {};
        const data = await request({ url, params, headers, cache: this.shouldCache }, this.modelName);

        const modelInput = params.prompt || params.messages[0].content;
        const responseResult = getResponseResult(data);

        console.log(`=== ${this.pathwayName}.${this.requestCount++} ===`)
        console.log(`\x1b[36m${modelInput}\x1b[0m`)
        console.log(`\x1b[34m> ${responseResult}\x1b[0m`)

        if (data.error) {
            throw new Exception(`An error was returned from the server: ${JSON.stringify(data.error)}`);
        }

        return responseResult;
    }
}

module.exports = {
    PathwayPrompter
}
