// PathwayPrompter.js
import OpenAIChatPlugin from './plugins/openAiChatPlugin.js';
import OpenAICompletionPlugin from './plugins/openAiCompletionPlugin.js';
import AzureTranslatePlugin from './plugins/azureTranslatePlugin.js';
import OpenAIWhisperPlugin from './plugins/openAiWhisperPlugin.js';
import LocalModelPlugin from './plugins/localModelPlugin.js';
import handlebars from 'handlebars';

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
            throw new handlebars.Exception(`Model ${modelName} not found in config`);
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
            case 'LOCAL-CPP-MODEL':
                plugin = new LocalModelPlugin(config, pathway);
                break;
            default:
                throw new handlebars.Exception(`Unsupported model type: ${model.type}`);
        }

        this.plugin = plugin;
    }

    async execute(text, parameters, prompt, pathwayResolver) {
        return await this.plugin.execute(text, parameters, prompt, pathwayResolver);
    }
}

export {
    PathwayPrompter
};
