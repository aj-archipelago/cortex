import { rootResolver, resolver } from '../server/resolver.js';
import { typeDef } from '../server/typeDef.js';

// all default definitions of a single pathway
export default {
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
    inputFormat: 'text',
    useInputChunking: true,
    useParallelChunkProcessing: false,
    useInputSummarization: false,    
    truncateFromFront: false,
    timeout: 120, // in seconds
};

