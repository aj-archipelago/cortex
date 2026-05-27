// rest/modelsRoute.js
// GET /v1/models endpoint

import axios from 'axios';
import logger from '../../lib/logger.js';

const getOllamaModels = async (ollamaUrl) => {
    try {
        const response = await axios.get(`${ollamaUrl}/api/tags`);
        return response.data.models.map(model => ({
            id: `ollama-${model.name}`,
            object: 'model',
            owned_by: 'ollama',
            permission: ''
        }));
    } catch (error) {
        logger.error(`Error fetching Ollama models: ${error.message}`);
        return [];
    }
};

function registerModelsRoute(app, openAIChatModels, openAICompletionModels, config) {
    app.get('/v1/models', async (req, res) => {
        const openAIModels = { ...openAIChatModels, ...openAICompletionModels };
        const defaultModelId = 'gpt-3.5-turbo';
        let models = [];

        // Get standard OpenAI-compatible models, filtering out our internal pathway models
        models = Object.entries(openAIModels)
            .filter(([modelId]) => !['ollama-chat', 'ollama-completion'].includes(modelId))
            .map(([modelId]) => {
                if (modelId.includes('*')) {
                    modelId = defaultModelId;
                }
                return {
                    id: modelId,
                    object: 'model',
                    owned_by: 'openai',
                    permission: '',
                };
            });

        // Get Ollama models if configured
        if (config.get('ollamaUrl')) {
            const ollamaModels = await getOllamaModels(config.get('ollamaUrl'));
            models = [...models, ...ollamaModels];
        }

        // Filter out duplicates and sort
        models = models
            .filter((model, index, self) => {
                return index === self.findIndex((m) => m.id === model.id);
            })
            .sort((a, b) => a.id.localeCompare(b.id));

        res.json({
            data: models,
            object: 'list',
        });
    });
}

export { registerModelsRoute };
