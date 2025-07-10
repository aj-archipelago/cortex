import basePathway from './basePathway.js';
import { callPathway } from '../lib/pathwayTools.js';
import logger from "../lib/logger.js";

export default {
    ...basePathway,
    name: 'list_translation_models',
    objName: 'TranslationModelList',
    list: true, // indicates this returns an array
    format: 'id name description supportedLanguages status', // defines the fields each model will have, added status field

    resolver: async (parent, args, contextValue, _info) => {

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
                    },
                    'translate_google': {
                        name: 'Google Translator',
                        description: 'Google Cloud Translation service',
                        supportedLanguages: 'Over 100 languages supported'
                    },
                    'translate_groq': {
                        name: 'Groq Llama 4 Scout Translator',
                        description: 'High-performance translation using Groq Llama 4 Scout models',
                        supportedLanguages: 'All major languages supported'
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
