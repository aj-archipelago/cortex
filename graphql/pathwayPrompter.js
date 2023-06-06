// PathwayPrompter.js
import OpenAIChatPlugin from './plugins/openAiChatPlugin.js';
import OpenAICompletionPlugin from './plugins/openAiCompletionPlugin.js';
import AzureTranslatePlugin from './plugins/azureTranslatePlugin.js';
import OpenAIWhisperPlugin from './plugins/openAiWhisperPlugin.js';
import LocalModelPlugin from './plugins/localModelPlugin.js';
import PalmChatPlugin from './plugins/palmChatPlugin.js';
import PalmCompletionPlugin from './plugins/palmCompletionPlugin.js';

class PathwayPrompter {
    constructor({ config, pathway }) {

        const modelName = pathway.model || config.get('defaultModelName');
        const model = config.get('models')[modelName];

        if (!model) {
            throw new Error(`Model ${modelName} not found in config`);
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
            case 'PALM-CHAT':
                plugin = new PalmChatPlugin(config, pathway);
                break;
            case 'PALM-COMPLETION':
                plugin = new PalmCompletionPlugin(config, pathway);
                break;
            default:
                throw new Error(`Unsupported model type: ${model.type}`);
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
