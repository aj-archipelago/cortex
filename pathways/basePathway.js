import { rootResolver, resolver } from '../server/resolver.js';
import { typeDef } from '../server/typeDef.js';

// all default definitions of a single pathway
export default {
    prompt: '{{text}}',
    defaultInputParameters: {
        text: '',
        async: false, // switch to enable async mode
        contextId: '', // used to identify the context of the request,
        stream: false, // switch to enable stream mode
    },
    inputParameters: {},
    typeDef,
    rootResolver,
    resolver,
    inputFormat: 'text', // string - 'text' or 'html' - changes the behavior of the input chunking
    useInputChunking: true, // true or false - enables input to be split into multiple chunks to meet context window size
    useParallelChunkProcessing: false, // true or false - enables parallel processing of chunks
    joinChunksWith: '\n\n', // string - the string to join result chunks with when useInputChunking is 'true'
    useInputSummarization: false, // true or false - instead of chunking, summarize the input and act on the summary    
    truncateFromFront: false, // true or false - if true, truncate from the front of the input instead of the back
    timeout: 120, // seconds, cancels the pathway after this many seconds
    enableDuplicateRequests: false, // true or false - if true, duplicate requests are sent if the request is not completed after duplicateRequestAfter seconds
    duplicateRequestAfter: 10, // seconds, if the request is not completed after this many seconds, a backup request is sent
    // override the default execution of the pathway
    // callback signature: executeOverride({args: object, runAllPrompts: function})
    // args: the input arguments to the pathway
    // runAllPrompts: a function that runs all prompts in the pathway and returns the result
    executePathway: undefined,
    // Set the temperature to 0 to favor more deterministic output when generating entity extraction.
    temperature: 0.9,
    // Require a valid JSON response from the model
    json: false,
    // Manage the token length of the input for the model
    manageTokenLength: true,
    // Use this pathway as a tool for LLM calls
    toolDefinition: {},
    requestLoggingDisabled: false,
};

