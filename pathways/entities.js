const { parseNumberedObjectList } = require("../graphql/parser")

module.exports = {
    temperature: 0,
    prompt: `{{text}}\n\nList the top {{count}} entities and their definitions for the above in the format {{format}}:`,
    parameters: {
        count: 5,
        format: `(number. name: definition)`,
    },
    parser: async (response) => {
        return parseNumberedObjectList(response, ["name", "definition"])
    },
    returnType: {
        name: "Entity",
        type: "list",
        fields: {
            name: "String",
            definition: "String",
        }
    }
}