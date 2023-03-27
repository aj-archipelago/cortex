// PathwayPrompter.js
const OpenAIChatPlugin = require('./plugins/openAIChatPlugin');
const OpenAICompletionPlugin = require('./plugins/openAICompletionPlugin');
const AzureTranslatePlugin = require('./plugins/azureTranslatePlugin');
const OpenAIWhisperPlugin = require('./plugins/openAiWhisperPlugin');
const handlebars = require("handlebars");
const { Exception } = require("handlebars");

// register functions that can be called directly in the prompt markdown
handlebars.registerHelper('stripHTML', function (value) {
    return value.replace(/<[^>]*>/g, '');
});

handlebars.registerHelper('now', function () {
    return new Date().toISOString();
});

handlebars.registerHelper('toJSON', function (object) {
    return JSON.stringify(object);
});


class PathwayPrompter {
    constructor({ config, pathway }) {

        const modelName = pathway.model || config.get('defaultModelName');
        const model = config.get('models')[modelName];

        if (!model) {
            throw new Exception(`Model ${modelName} not found in config`);
        }

        let plugin;

        switch (model.type) {
            case 'OPENAI-CHAT':
                plugin = new OpenAIChatPlugin(config, pathway);
                break;
            case 'AZURE-TRANSLATE':
                plugin = new AzureTranslatePlugin(config, pathway);
                break;
            case 'OPENAI-COMPLETION':
                plugin = new OpenAICompletionPlugin(config, pathway);
                break;
            case 'OPENAI_WHISPER':
                plugin = new OpenAIWhisperPlugin(config, pathway);
                break;
            default:
                throw new Exception(`Unsupported model type: ${model.type}`);
        }

        this.plugin = plugin;
    }

    async execute(text, parameters, prompt, pathwayResolver) {
        return await this.plugin.execute(text, parameters, prompt, pathwayResolver);
    }
}

module.exports = {
    PathwayPrompter
};
