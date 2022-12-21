const { parseNumberedObjectList } = require("../parser")

module.exports = {
    temperature: 0,
    prompt: `{{text}}\n\nList the top {{count}} entities and their definitions for the above in format {{format}}:`,
    count: 5,
    format: `(number. name: definition)`,
    parser: async (response) => parseNumberedObjectList(response, ["name", "definition"]),
    typeDef: {
        type: `    
            type Entity {
                name: String,
                definition: String
            }`,
        label: () => `entities(text: String!): [Entity],`
    },
}