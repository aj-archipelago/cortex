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
        generatorPathway: 'sys_generator_results',
        voiceResponse: false,
    },
    timeout: 300,
    ...entityConstants,
    executePathway: async ({args, resolver}) => {
        args = { ...args, ...entityConstants };

        try {
            // Get the generator pathway name from args or use default
            let generatorPathway = args.generatorPathway || 'sys_generator_results';

            const newArgs = {
                ...args,
                chatHistory: args.chatHistory.slice(-20)
            };

            if (generatorPathway === 'sys_generator_document') {
                generatorPathway = 'sys_generator_results';
                newArgs.dataSources = ["mydata"];
            }
            
            logger.debug(`Using generator pathway: ${generatorPathway}`);
            
            const result = await callPathway(generatorPathway, newArgs, resolver);

            return args.stream ? "" : result;

        } catch (e) {
            resolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message, stream: false }, resolver);
        }
    }
}; 