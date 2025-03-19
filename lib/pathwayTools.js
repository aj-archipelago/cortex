// pathwayTools.js
import { encode, decode } from '../lib/encodeCache.js';
import { config } from '../config.js';
import { publishRequestProgress } from "../lib/redisSubscription.js";
import { getSemanticChunks } from "../server/chunker.js";
import logger from '../lib/logger.js';
import { requestState } from '../server/requestState.js';

// callPathway - call a pathway from another pathway
const callPathway = async (pathwayName, inArgs, pathwayResolver) => {

    // Clone the args object to avoid modifying the original
    const args = JSON.parse(JSON.stringify(inArgs));
    
    const pathway = config.get(`pathways.${pathwayName}`);
    if (!pathway) {
        throw new Error(`Pathway ${pathwayName} not found`);
    }

    const parent = {};
    let rootRequestId = pathwayResolver?.rootRequestId || pathwayResolver?.requestId;

    let data = await pathway.rootResolver(parent, {...args, rootRequestId}, { config, pathway, requestState } );
    pathwayResolver && pathwayResolver.mergeResults(data);

    let returnValue = data?.result || null;

    if (args.async || args.stream) {
        const { result: requestId } = data;

        // Fire the resolver for the async requestProgress
        logger.info(`Callpathway starting async requestProgress, pathway: ${pathwayName}, requestId: ${requestId}`);
        const { resolver, args } = requestState[requestId];
        requestState[requestId].useRedis = false;
        requestState[requestId].started = true;

        resolver && await resolver(args);
        
        returnValue = null;
    }
    
    return returnValue;
};

const gpt3Encode = (text) => {
    return encode(text);
}

const gpt3Decode = (text) => {
    return decode(text);
}

const say = async (requestId, message, maxMessageLength = Infinity, voiceResponse = true) => {
    try {
        const chunks = getSemanticChunks(message, maxMessageLength);

        for (let chunk of chunks) {
            await publishRequestProgress({
                requestId,
                progress: 0.5,
                data: JSON.stringify(chunk)
            });
        }

        if (voiceResponse) {
            await publishRequestProgress({
                requestId,
                progress: 0.5,
                data: JSON.stringify(" ... ")
            });
        }

        await publishRequestProgress({
            requestId,
            progress: 0.5,
            data: JSON.stringify("\n\n")
        });

    } catch (error) {
        logger.error(`Say error: ${error.message}`);
    }
};

export { callPathway, gpt3Encode, gpt3Decode, say };