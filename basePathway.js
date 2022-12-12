const { resolver } = require("./fn");
const { hasListReturn } = require("./util");

const typeDefLabel = (pathway) => {
    const { name } = pathway;
    if (hasListReturn(pathway)) {
        return `${name}(text: String!): [String],`
    }
    return `${name}(text: String!): String,`
}

// all default definitions of a single pathway
module.exports = {
    // temperature: 0.7,
    prompt: `{{text}}`,
    // count: 5,
    // format: ``, 
    // parser: (text) => text,
    typeDef: {
        type: ``,
        label: typeDefLabel
    },
    resolver
}