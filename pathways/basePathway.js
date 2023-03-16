const { parseResponse } = require("../graphql/parser");
const { rootResolver, resolver } = require("../graphql/resolver");
const { typeDef } = require('../graphql/typeDef')

// all default definitions of a single pathway
module.exports = {
    prompt: `{{text}}`,
    defaultInputParameters: {
        text: ``,
        // Add the option of making every call async
        async: false,
        contextId : ``, // used to identify the context of the request
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
}
