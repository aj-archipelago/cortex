const GRAPHQL_TYPE_MAP = {
    boolean: 'Boolean',
    string: 'String',
    number: 'Int',
}


const typeDef = (pathway) => {
    const { name, objName, defaultInputParameters, inputParameters, format } = pathway;

    const fields = format ? format.match(/\b(\w+)\b/g) : null;
    const fieldsStr = !fields ? `` : fields.map(f => `${f}: String`).join('\n    ');

    const typeName = fields ? `${objName}Result` : `String`;
    const messageType = `input Message { role: String, content: String }`;

    const type = fields ? `type ${typeName} {
    ${fieldsStr}
    }` : ``;

    const resultStr = pathway.list ? `[${typeName}]` : typeName;

    const responseType = `type ${objName} {
        debug: String
        result: ${resultStr}
        previousResult: String
        warnings: [String]
        contextId: String
}`;


    const params = { ...defaultInputParameters, ...inputParameters };

    const paramsStr = Object.entries(params).map(
        ([key, value]) => {
            if (typeof value === 'object' && Array.isArray(value)) {
                return `${key}: [Message] = []`;
            } else {
                return `${key}: ${GRAPHQL_TYPE_MAP[typeof (value)]} = ${typeof (value) === 'string' ? `"${value}"` : value}`;
            }
        }
        ).join('\n');
          

    const definition = `${messageType}\n\n${type}\n\n${responseType}\n\nextend type Query {${name}(${paramsStr}): ${objName}}`;
    //console.log(definition);
    return definition;
}

module.exports = {
    typeDef,
}