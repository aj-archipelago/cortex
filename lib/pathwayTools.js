// pathwayTools.js
import { encode, decode } from '../lib/encodeCache.js';
import { config } from '../config.js';

// callPathway - call a pathway from another pathway
const callPathway = async (pathwayName, inArgs, pathwayResolver) => {

    // Clone the args object to avoid modifying the original
    const args = JSON.parse(JSON.stringify(inArgs));
    
    const pathway = config.get(`pathways.${pathwayName}`);
    if (!pathway) {
        throw new Error(`Pathway ${pathwayName} not found`);
    }
    const requestState = {};
    const parent = {};
    const data = await pathway.rootResolver(parent, args, { config, pathway, requestState } );
    
    // Merge the results into the pathwayResolver if it was provided
    if (pathwayResolver) {
        pathwayResolver.mergeResults(data);
    }

    return data?.result;
};

const gpt3Encode = (text) => {
    return encode(text);
}

const gpt3Decode = (text) => {
    return decode(text);
}

export { callPathway, gpt3Encode, gpt3Decode };