// ModelExecutor.js
import CortexRequest from '../lib/cortexRequest.js';

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
import OpenAIDallE3Plugin from './plugins/openAiDallE3Plugin.js';
import OpenAIVisionPlugin from './plugins/openAiVisionPlugin.js';
import OpenAIReasoningPlugin from './plugins/openAiReasoningPlugin.js';
import GeminiChatPlugin from './plugins/geminiChatPlugin.js';
import GeminiVisionPlugin from './plugins/geminiVisionPlugin.js';
import Gemini15ChatPlugin from './plugins/gemini15ChatPlugin.js';
import Gemini15VisionPlugin from './plugins/gemini15VisionPlugin.js';
import AzureBingPlugin from './plugins/azureBingPlugin.js';
import Claude3VertexPlugin from './plugins/claude3VertexPlugin.js';
import NeuralSpacePlugin from './plugins/neuralSpacePlugin.js';
import RunwareAiPlugin from './plugins/runwareAiPlugin.js';
import ReplicateApiPlugin from './plugins/replicateApiPlugin.js';
import AzureVideoTranslatePlugin from './plugins/azureVideoTranslatePlugin.js';
import OllamaChatPlugin from './plugins/ollamaChatPlugin.js';
import OllamaCompletionPlugin from './plugins/ollamaCompletionPlugin.js';
import ApptekTranslatePlugin from './plugins/apptekTranslatePlugin.js';
import GoogleTranslatePlugin from './plugins/googleTranslatePlugin.js';
import GroqChatPlugin from './plugins/groqChatPlugin.js';

class ModelExecutor {
    constructor(pathway, model) {

        let plugin;

        switch (model.type) {
            case 'OPENAI-CHAT':
                plugin = new OpenAIChatPlugin(pathway, model);
                break;
            case 'OPENAI-DALLE2':
                plugin = new OpenAIImagePlugin(pathway, model);
                break;
            case 'OPENAI-DALLE3':
                plugin = new OpenAIDallE3Plugin(pathway, model);
                break;
            case 'OPENAI-CHAT-EXTENSION':
                plugin = new OpenAIChatExtensionPlugin(pathway, model);
                break;
            case 'AZURE-TRANSLATE':
                plugin = new AzureTranslatePlugin(pathway, model);
                break;
            case 'AZURE-COGNITIVE':
                plugin = new AzureCognitivePlugin(pathway, model);
                break;
            case 'OPENAI-EMBEDDINGS':
                plugin = new OpenAiEmbeddingsPlugin(pathway, model);
                break;
            case 'OPENAI-COMPLETION':
                plugin = new OpenAICompletionPlugin(pathway, model);
                break;
            case 'OPENAI-WHISPER':
                plugin = new OpenAIWhisperPlugin(pathway, model);
                break;
            case 'NEURALSPACE':
                plugin = new NeuralSpacePlugin(pathway, model);
                break;
            case 'LOCAL-CPP-MODEL':
                plugin = new LocalModelPlugin(pathway, model);
                break;
            case 'PALM-CHAT':
                plugin = new PalmChatPlugin(pathway, model);
                break;
            case 'PALM-COMPLETION':
                plugin = new PalmCompletionPlugin(pathway, model);
                break;
            case 'PALM-CODE-COMPLETION':
                plugin = new PalmCodeCompletionPlugin(pathway, model);
                break;
            case 'COHERE-GENERATE':
                plugin = new CohereGeneratePlugin(pathway, model);
                break;
            case 'COHERE-SUMMARIZE':
                plugin = new CohereSummarizePlugin(pathway, model);
                break;
            case 'OPENAI-VISION':
                plugin = new OpenAIVisionPlugin(pathway, model);
                break;
            case 'OPENAI-REASONING':
                plugin = new OpenAIReasoningPlugin(pathway, model);
                break;
            case 'GEMINI-CHAT':
                plugin = new GeminiChatPlugin(pathway, model);
                break;
            case 'GEMINI-VISION':
                plugin = new GeminiVisionPlugin(pathway, model);
                break;
            case 'GEMINI-1.5-CHAT':
                plugin = new Gemini15ChatPlugin(pathway, model);
                break;
            case 'GEMINI-1.5-VISION':
                plugin = new Gemini15VisionPlugin(pathway, model);
                break;
            case 'AZURE-BING':
                plugin = new AzureBingPlugin(pathway, model);
                break;
            case 'CLAUDE-3-VERTEX':
                plugin = new Claude3VertexPlugin(pathway, model);
                break;
            case 'RUNWARE-AI':
                plugin = new RunwareAiPlugin(pathway, model);
                break;
            case 'REPLICATE-API':
                plugin = new ReplicateApiPlugin(pathway, model);
                break;
            case 'AZURE-VIDEO-TRANSLATE':
                plugin = new AzureVideoTranslatePlugin(pathway, model);
                break;
            case 'OLLAMA-CHAT':
                plugin = new OllamaChatPlugin(pathway, model);
                break;
            case 'OLLAMA-COMPLETION':
                plugin = new OllamaCompletionPlugin(pathway, model);
                break;
            case 'APPTEK-TRANSLATE':
                plugin = new ApptekTranslatePlugin(pathway, model);
                break;
            case 'GOOGLE-TRANSLATE':
                plugin = new GoogleTranslatePlugin(pathway, model);
                break;
            case 'GROQ-TRANSLATE':
                plugin = new GroqChatPlugin(pathway, model);
                break;
            case 'GROQ-CHAT':
                plugin = new GroqChatPlugin(pathway, model);
                break;
            default:
                throw new Error(`Unsupported model type: ${model.type}`);
        }

        this.plugin = plugin;
    }

    async execute(text, parameters, prompt, pathwayResolver) {
        const cortexRequest = new CortexRequest({ pathwayResolver });
        return await this.plugin.execute(text, parameters, prompt, cortexRequest);
    }
}

export {
    ModelExecutor
};
