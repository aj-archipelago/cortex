import { callPathway } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import entityConstants from './shared/sys_entity_constants.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        privateData: false,
        useMemory: true,    
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        indexName: ``,
        semanticConfiguration: ``,
        roleInformation: ``,    
        calculateEmbeddings: false,
        language: "English",
        chatId: ``,
        dataSources: [""],
        model: 'oai-gpt4o',
        generatorPathway: 'sys_generator_results'
    },
    timeout: 300,
    ...entityConstants,
    executePathway: async ({args, resolver}) => {
        args = { ...args, ...entityConstants };
        // if the model has been overridden, make sure to use it
        if (resolver.modelName) {
            args.model = resolver.modelName;
        }
        try {
            // Get the generator pathway name from args or use default
            const generatorPathway = args.generatorPathway || 'sys_generator_results';
            
            logger.debug(`Using generator pathway: ${generatorPathway}`);

            // Shorten chat history for speed
            const shortChatHistory = args.chatHistory.slice(-6);
            // Call the specified generator pathway with all original args and resolver
            const result = await callPathway(generatorPathway, { ...args, chatHistory: shortChatHistory, stream: false }, resolver);
            
            return result;

        } catch (e) {
            resolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, resolver);
        }
    }
}; 