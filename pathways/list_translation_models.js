import basePathway from './basePathway.js';

export default {
    ...basePathway,
    name: 'list_translation_models',
    objName: 'TranslationModelList',
    list: true, // indicates this returns an array
    format: 'id name description supportedLanguages', // defines the fields each model will have

    resolver: async (parent, args, contextValue, _info) => {
        const { config } = contextValue;
        const { _instance } = config;
        console.log(_instance)
        const { enabledTranslationModels } = _instance;

        // Map of pathway names to their descriptions
        const modelDescriptions = {
            'translate': {
                name: 'Default Translator',
                description: 'Default translation service using GPT',
                supportedLanguages: 'All languages supported'
            },
            'translate_azure': {
                name: 'Azure Translator',
                description: 'Microsoft Azure Translation service',
                supportedLanguages: 'Over 100 languages supported'
            },
            'translate_apptek': {
                name: 'AppTek Translator',
                description: 'AppTek specialized translation service',
                supportedLanguages: 'Selected languages supported'
            },
            'translate_gpt4': {
                name: 'GPT-4 Translator',
                description: 'High-quality translation using GPT-4',
                supportedLanguages: 'All languages supported'
            },
            'translate_gpt4_turbo': {
                name: 'GPT-4 Turbo Translator',
                description: 'Fast, high-quality translation using GPT-4 Turbo',
                supportedLanguages: 'All languages supported'
            },
            'translate_turbo': {
                name: 'GPT-3.5 Turbo Translator',
                description: 'Fast translation using GPT-3.5 Turbo',
                supportedLanguages: 'All languages supported'
            }
        };

        // Return only enabled models
        const availableModels = (enabledTranslationModels || [])
            .filter(modelId => modelDescriptions[modelId])
            .map(modelId => ({
                id: modelId,
                ...modelDescriptions[modelId]
            }));

        return availableModels;
    },

    // Minimal input parameters since this is just a listing endpoint
    defaultInputParameters: {
        async: false,
    },

    // Other standard pathway configurations
    useInputChunking: false,
    temperature: 0,
    timeout: 30,
    enableDuplicateRequests: false,
};
