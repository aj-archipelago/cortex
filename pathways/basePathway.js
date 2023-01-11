const { resolver } = require("../graphql/resolver");
const { typeDef } = require('../graphql/typeDef')

// all default definitions of a single pathway
module.exports = {
    // temperature: 0.7,
    prompt: `{{text}}`,
    // count: 5,
    // format: ``, 
    // parser: (text) => text,
    typeDef,
    resolver,
    parameters: {
        // Add the option of making every call async
        async: false,
    }
}
