import basePathway from './basePathway.js';

export default {
    ...basePathway,
    name: 'list_translation_models',
    objName: 'TranslationModelList',
    list: true, // indicates this returns an array
    format: 'id name description supportedLanguages status', // defines the fields each model will have, added status field

    resolver: async (parent, args, contextValue, _info) => {

        // Map of pathway names to their descriptions
        const modelDescriptions = {
                    'translate_apptek': {
                        name: 'AppTek Translator',
                        description: 'AppTek specialized translation service',
                        supportedLanguages: 'Selected languages supported'
                    },
                    'translate_groq': {
                        name: 'Groq Llama 4 Scout Translator',
                        description: 'High-performance translation using Groq Llama 4 Scout models',
                        supportedLanguages: 'All major languages supported'
                    },
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
                    'translate_gpt4': {
                        name: 'GPT-4 Translator',
                        description: 'High-quality translation using GPT-4',
                        supportedLanguages: 'All languages supported'
                    },
                    'translate_gpt4_omni': {
                        name: 'GPT-4 Omni Translator',
                        description: 'High-quality translation using GPT-4 Omni',
                        supportedLanguages: 'All languages supported'
                    },
                    'translate_google': {
                        name: 'Google Translator',
                        description: 'Google Cloud Translation service',
                        supportedLanguages: 'Over 100 languages supported'
                    }
                };  
                
        const availableModels = Object.keys(modelDescriptions).map(modelId => ({
            id: modelId,
            ...modelDescriptions[modelId],
            status: 'operational'
        }));

        return availableModels;
    },

    // Minimal input parameters since this is just a listing endpoint
    defaultInputParameters: {
        async: false,
    },

    // Other standard pathway configurations
    useInputChunking: false,
};
