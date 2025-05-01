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

const callTool = async (toolName, args, toolDefinitions, pathwayResolver) => {
    let toolResult = null;

    const toolDef = toolDefinitions[toolName.toLowerCase()];
    if (!toolDef) {
        throw new Error(`Tool ${toolName} not found in available tools`);
    }

    try {
        const pathwayName = toolDef.pathwayName;
        // Merge hard-coded pathway parameters with runtime args
        const mergedArgs = {
            ...(toolDef.pathwayParams || {}),
            ...args
        };

        if (pathwayName.includes('_generator_')) {
            toolResult = await callPathway('sys_entity_continue', {
                ...mergedArgs,
                generatorPathway: pathwayName,
                stream: false
            },
            pathwayResolver
        );
        } else {
            toolResult = await callPathway(pathwayName, mergedArgs,
            pathwayResolver
        );
        }

        if (toolResult === null) {
            return { error: `Tool ${toolName} returned null result` };
        }

        // Handle search results accumulation
        if (pathwayResolver) {
            // Initialize searchResults array if it doesn't exist
            if (!pathwayResolver.searchResults) {
                pathwayResolver.searchResults = [];
            }

            // Parse the result if it's a string
            let parsedResult;
            try {
                parsedResult = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult;
            } catch (e) {
                // If parsing fails, just return the original result
                return toolResult;
            }

            // Check if this is a search response
            if (parsedResult._type === "SearchResponse" && Array.isArray(parsedResult.value)) {
                // Extract and add each search result
                parsedResult.value.forEach(result => {
                    if (result.searchResultId) {
                        pathwayResolver.searchResults.push({
                            searchResultId: result.searchResultId,
                            title: result.title || '',
                            url: result.url || '',
                            content: result.content || '',
                            path: result.path || '',
                            wireid: result.wireid || '',
                            source: result.source || '',
                            slugline: result.slugline || '',
                            date: result.date || ''
                        });
                    }
                });
            }
        }

        return toolResult;
    } catch (error) {
        logger.error(`Error calling tool ${toolName}: ${error.message}`);
        return { error: error.message };
    }
}

const gpt3Encode = (text) => {
    return encode(text);
}

const gpt3Decode = (text) => {
    return decode(text);
}

const say = async (requestId, message, maxMessageLength = Infinity, voiceResponse = true) => {
    try {
        const chunks = getSemanticChunks(message, maxMessageLength);

        const info = JSON.stringify({
            ephemeral: true,
        });

        for (let chunk of chunks) {
            await publishRequestProgress({
                requestId,
                progress: 0.5,
                data: JSON.stringify(chunk),
                info
            });
        }

        if (voiceResponse) {
            await publishRequestProgress({
                requestId,
                progress: 0.5,
                data: JSON.stringify(" ... "),
                info
            });
        }

        await publishRequestProgress({
            requestId,
            progress: 0.5,
            data: JSON.stringify("\n\n"),
            info
        });

    } catch (error) {
        logger.error(`Say error: ${error.message}`);
    }
};

export { callPathway, gpt3Encode, gpt3Decode, say, callTool };