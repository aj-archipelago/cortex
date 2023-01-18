const { parseNumberedObjectList } = require("../graphql/parser")

module.exports = {
    temperature: 0,
    prompt: `{{text}}\n\nList the top {{count}} entities and their definitions for the above in the format {{format}}:`,
    format: `(name: definition)`,
    inputParameters: {
        count: 5,
    },
    list: true,
}