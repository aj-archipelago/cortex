import { callPathway } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';

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
        aiStyle: "OpenAI",
        generatorPathway: 'sys_generator_results',
        voiceResponse: false,
    },
    timeout: 300,
    executePathway: async ({args, resolver}) => {
        const pathwayResolver = resolver;

        // add the entity constants to the args
        args = {
            ...args,
            ...config.get('entityConstants')
        };

        // if the model has been overridden, make sure to use it
        if (pathwayResolver.modelName) {
            args.model = pathwayResolver.modelName;
        }

        try {
            // Get the generator pathway name from args or use default
            let generatorPathway = args.generatorPathway || 'sys_generator_results';

            const newArgs = {
                ...args,
                chatHistory: args.chatHistory.slice(-20)
            };

            if (generatorPathway === 'coding') {
                return;
            }

            if (generatorPathway === 'sys_generator_document') {
                generatorPathway = 'sys_generator_results';
                newArgs.dataSources = ["mydata"];
            }
            
            logger.debug(`Using generator pathway: ${generatorPathway}`);
            
            const result = await callPathway(generatorPathway, newArgs, resolver);

            if (!result && !args.stream) {
                result = await callPathway('sys_generator_error', { ...args, text: `Tried to use a tool (${generatorPathway}), but no result was returned`, stream: false }, resolver);
            }

            return result;

        } catch (e) {
            resolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message, stream: false }, resolver);
        }
    }
}; 