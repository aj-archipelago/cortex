const { parseResponse } = require("../graphql/parser");
const { rootResolver, resolver } = require("../graphql/resolver");
const { typeDef } = require('../graphql/typeDef')

// all default definitions of a single pathway
module.exports = {
    prompt: `{{text}}`,
    defaultInputParameters: {
        text: ``,
    },
    inputParameters: {},
    typeDef,
    rootResolver,
    resolver,
    parameters: {
        // Add the option of making every call async
        async: false,
    }
}
