import { rootResolver, resolver } from '../graphql/resolver.js';
import { typeDef } from '../graphql/typeDef.js';

// all default definitions of a single pathway
const basePathway = {
    prompt: `{{text}}`,
    defaultInputParameters: {
        text: ``,
        async: false, // switch to enable async mode
        contextId: ``, // used to identify the context of the request,
        stream: false, // switch to enable stream mode
    },
    inputParameters: {},
    typeDef,
    rootResolver,
    resolver,
    useInputChunking: true,
    useParallelChunkProcessing: false,
    useInputSummarization: false,    
    truncateFromFront: false,
    timeout: 120, // in seconds
};

export default basePathway;