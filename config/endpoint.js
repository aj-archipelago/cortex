const { fn } = require("../fn");
const { hasListReturn } = require("../util");

const typeDefLabel = (endpoint) => {
    const { name } = endpoint;
    if (hasListReturn(endpoint)) {
        return `${name}(text: String!): [String],`
    }
    return `${name}(text: String!): String,`
}

module.exports = {
    //TODO default all definitions of a single endpoint
    // temperature: 0.7,
    prompt: `{{text}}`,
    // count: 5,
    // format: ``, 
    // parser: (text) => text,
    typeDef: {
        type: ``,
        label: typeDefLabel
    },
    resolver: fn
}