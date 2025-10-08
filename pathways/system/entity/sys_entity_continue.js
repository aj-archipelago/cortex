import { callPathway } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { chatArgsHasImageUrl, removeOldImageAndFileContent } from '../../../lib/util.js';

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
        dataSources: {type: '[String]', value: []},
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

            // remove old image and file content
            const visionContentPresent = chatArgsHasImageUrl(args);
            visionContentPresent && (args.chatHistory = removeOldImageAndFileContent(args.chatHistory));

            // truncate the chat history
            const truncatedChatHistory = pathwayResolver.modelExecutor.plugin.truncateMessagesToTargetLength(args.chatHistory, null, 1000);

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
            
            let result = await callPathway(generatorPathway, newArgs, resolver);

            if (!result && !args.stream) {
                result = await callPathway('sys_generator_error', { ...args, chatHistory: truncatedChatHistory, text: `Tried to use a tool (${generatorPathway}), but no result was returned`, stream: false }, resolver);
            }

            if (resolver.errors.length > 0) {
                result = await callPathway('sys_generator_error', { ...args, chatHistory: truncatedChatHistory, text: resolver.errors.join('\n'), stream: false }, resolver);
                resolver.errors = [];
            }

            return result;

        } catch (e) {
            resolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message, stream: false }, resolver);
        }
    }
}; 