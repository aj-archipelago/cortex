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

    // Merge any data from the pathway execution into the current pathway resolver
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
    let toolImages = [];

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
        let parsedResult = null;

        // Parse the result if it's a string
        try {
            parsedResult = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult;
        } catch (e) {
            // If parsing fails, just return the original result
            return {
                result: toolResult,
                toolImages: toolImages
            };
        }

        if (pathwayResolver) {
            // Initialize searchResults array if it doesn't exist
            if (!pathwayResolver.searchResults) {
                pathwayResolver.searchResults = [];
            }

            // Check if this is a search response
            if (parsedResult._type === "SearchResponse" && Array.isArray(parsedResult.value)) {
                // Extract and add each search result
                parsedResult.value.forEach(result => {
                    if (result.searchResultId) {
                        // Extract screenshot if present
                        if (result.screenshot) {
                            toolImages.push(result.screenshot);
                            delete result.screenshot;
                        }

                        // Build content by concatenating headers and chunk if available
                        let content = '';
                        if (result.header_1) content += result.header_1 + '\n\n';
                        if (result.header_2) content += result.header_2 + '\n\n';
                        if (result.header_3) content += result.header_3 + '\n\n';
                        if (result.chunk) content += result.chunk;
                        
                        // If no headers/chunk were found, fall back to existing content fields
                        if (!content) {
                            content = result.content || result.text || result.chunk || '';
                        }

                        pathwayResolver.searchResults.push({
                            searchResultId: result.searchResultId,
                            title: result.title || result.key || '',
                            url: result.url || '',
                            content: content,
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

        return {
            result: parsedResult,
            toolImages: toolImages
        };
    } catch (error) {
        logger.error(`Error calling tool ${toolName}: ${error.message}`);
        return { error: error.message };
    }
}

const addCitationsToResolver = (pathwayResolver, contentBuffer) => {
    if (!pathwayResolver || !pathwayResolver.searchResults) {
        return;
    }

    const regex = /:cd_source\[(.*?)\]/g;
    let match;
    const foundIds = [];
    while ((match = regex.exec(contentBuffer)) !== null) {
        // Ensure the capture group exists and is not empty
        if (match[1] && match[1].trim()) { 
            foundIds.push(match[1].trim());
        }
    }

    if (foundIds.length > 0) {
        const {searchResults} = pathwayResolver;
        logger.info(`Found referenced searchResultIds: ${foundIds.join(', ')}`);

        if (searchResults) {
            const pathwayResultData = pathwayResolver.pathwayResultData || {};
            pathwayResultData.citations = [...(pathwayResultData.citations || []), ...searchResults
                .filter(result => foundIds.includes(result.searchResultId))];
            pathwayResolver.pathwayResultData = pathwayResultData;
        }
    }
}

const gpt3Encode = (text) => {
    return encode(text);
}

const gpt3Decode = (text) => {
    return decode(text);
}

const say = async (requestId, message, maxMessageLength = Infinity, voiceResponse = true, isEphemeral = true) => {
    try {
        const chunks = getSemanticChunks(message, maxMessageLength);

        const info = JSON.stringify({
            ephemeral: isEphemeral,
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

export { callPathway, gpt3Encode, gpt3Decode, say, callTool, addCitationsToResolver };