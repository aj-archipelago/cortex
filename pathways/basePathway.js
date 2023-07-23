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
    inputFormat: 'text', // text or html - changes the behavior of the input chunking
    useInputChunking: true, // true or false - enables input to be split into multiple chunks to meet context window size
    useParallelChunkProcessing: false, // true or false - enables parallel processing of chunks
    useInputSummarization: false, // true or false - instead of chunking, summarize the input and act on the summary    
    truncateFromFront: false, // true or false - if true, truncate from the front of the input instead of the back
    timeout: 120, // seconds, cancels the pathway after this many seconds
    duplicateRequestAfter: 10, // seconds, if the request is not completed after this many seconds, a backup request is sent
};

