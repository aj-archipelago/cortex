// PathwayPrompter.js
import OpenAIChatPlugin from './plugins/openAiChatPlugin.js';
import OpenAICompletionPlugin from './plugins/openAiCompletionPlugin.js';
import AzureTranslatePlugin from './plugins/azureTranslatePlugin.js';
import OpenAIWhisperPlugin from './plugins/openAiWhisperPlugin.js';
import OpenAIChatExtensionPlugin from './plugins/openAiChatExtensionPlugin.js';
import LocalModelPlugin from './plugins/localModelPlugin.js';
import PalmChatPlugin from './plugins/palmChatPlugin.js';
import PalmCompletionPlugin from './plugins/palmCompletionPlugin.js';
import PalmCodeCompletionPlugin from './plugins/palmCodeCompletionPlugin.js';
import CohereGeneratePlugin from './plugins/cohereGeneratePlugin.js';
import CohereSummarizePlugin from './plugins/cohereSummarizePlugin.js';
import AzureCognitivePlugin from './plugins/azureCognitivePlugin.js';
import OpenAiEmbeddingsPlugin from './plugins/openAiEmbeddingsPlugin.js';
import OpenAIImagePlugin from './plugins/openAiImagePlugin.js';
import OpenAIDallE3Plugin from './plugins/openAiDalle3Plugin.js';

class PathwayPrompter {
    constructor(config, pathway, modelName, model) {

        let plugin;

        switch (model.type) {
            case 'OPENAI-CHAT':
                plugin = new OpenAIChatPlugin(config, pathway, modelName, model);
                break;
            case 'OPENAI-DALLE2':
                plugin = new OpenAIImagePlugin(config, pathway, modelName, model);
                break;
            case 'OPENAI-DALLE3':
                plugin = new OpenAIDallE3Plugin(config, pathway, modelName, model);
                break;
            case 'OPENAI-CHAT-EXTENSION':
                plugin = new OpenAIChatExtensionPlugin(config, pathway, modelName, model);
                break;
            case 'AZURE-TRANSLATE':
                plugin = new AzureTranslatePlugin(config, pathway, modelName, model);
                break;
            case 'AZURE-COGNITIVE':
                plugin = new AzureCognitivePlugin(config, pathway, modelName, model);
                break;
            case 'OPENAI-EMBEDDINGS':
                plugin = new OpenAiEmbeddingsPlugin(config, pathway, modelName, model);
                break;
            case 'OPENAI-COMPLETION':
                plugin = new OpenAICompletionPlugin(config, pathway, modelName, model);
                break;
            case 'OPENAI-WHISPER':
                plugin = new OpenAIWhisperPlugin(config, pathway, modelName, model);
                break;
            case 'LOCAL-CPP-MODEL':
                plugin = new LocalModelPlugin(config, pathway, modelName, model);
                break;
            case 'PALM-CHAT':
                plugin = new PalmChatPlugin(config, pathway, modelName, model);
                break;
            case 'PALM-COMPLETION':
                plugin = new PalmCompletionPlugin(config, pathway, modelName, model);
                break;
            case 'PALM-CODE-COMPLETION':
                plugin = new PalmCodeCompletionPlugin(config, pathway, modelName, model);
                break;
            case 'COHERE-GENERATE':
                plugin = new CohereGeneratePlugin(config, pathway, modelName, model);
                break;
            case 'COHERE-SUMMARIZE':
                plugin = new CohereSummarizePlugin(config, pathway, modelName, model);
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
