// pathwayTools.js
import { encode , decode } from 'gpt-3-encoder';

// callPathway - call a pathway from another pathway
const callPathway = async (config, pathwayName, args) => {
    const pathway = config.get(`pathways.${pathwayName}`);
    if (!pathway) {
        throw new Error(`Pathway ${pathwayName} not found`);
    }
    const requestState = {};
    const parent = {};
    const data = await pathway.rootResolver(parent, args, { config, pathway, requestState } );
    return data?.result;
};

const gpt3Encode = (text) => {
    return encode(text);
}

const gpt3Decode = (text) => {
    return decode(text);
}

export { callPathway, gpt3Encode, gpt3Decode };