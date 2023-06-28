// PathwayPrompter.js
import OpenAIChatPlugin from './plugins/openAiChatPlugin.js';
import OpenAICompletionPlugin from './plugins/openAiCompletionPlugin.js';
import AzureTranslatePlugin from './plugins/azureTranslatePlugin.js';
import OpenAIWhisperPlugin from './plugins/openAiWhisperPlugin.js';
import LocalModelPlugin from './plugins/localModelPlugin.js';
import PalmChatPlugin from './plugins/palmChatPlugin.js';
import PalmCompletionPlugin from './plugins/palmCompletionPlugin.js';
import PalmCodeCompletionPlugin from './plugins/palmCodeCompletionPlugin.js';

class PathwayPrompter {
    constructor(pathwayResolver) {

        this.pathwayResolver = pathwayResolver;
        const { model } = pathwayResolver;
        
        let plugin;

        switch (model.type) {
            case 'OPENAI-CHAT':
                plugin = new OpenAIChatPlugin(this.pathwayResolver);
                break;
            case 'AZURE-TRANSLATE':
                plugin = new AzureTranslatePlugin(this.pathwayResolver);
                break;
            case 'OPENAI-COMPLETION':
                plugin = new OpenAICompletionPlugin(this.pathwayResolver);
                break;
            case 'OPENAI-WHISPER':
                plugin = new OpenAIWhisperPlugin(this.pathwayResolver);
                break;
            case 'LOCAL-CPP-MODEL':
                plugin = new LocalModelPlugin(this.pathwayResolver);
                break;
            case 'PALM-CHAT':
                plugin = new PalmChatPlugin(this.pathwayResolver);
                break;
            case 'PALM-COMPLETION':
                plugin = new PalmCompletionPlugin(this.pathwayResolver);
                break;
            case 'PALM-CODE-COMPLETION':
                plugin = new PalmCodeCompletionPlugin(this.pathwayResolver);
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
