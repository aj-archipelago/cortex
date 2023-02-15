const GRAPHQL_TYPE_MAP = {
    boolean: 'Boolean',
    string: 'String',
    number: 'Int',
}


const typeDef = (pathway) => {
    const { name, objName, defaultInputParameters, inputParameters, usePreviousResult, debugFields, outputFields, list, format } = pathway;

    const fields = format ? format.match(/\b(\w+)\b/g) : null;
    const fieldsStr = !fields ? `` : fields.map(f => `${f}: String`).join('\n    ');

    const typeName = fields ? `${objName}Result` : `String`;
    const type = fields ? `type ${typeName} {
    ${fieldsStr}
}` : ``;


    const resultStr = pathway.list ? `[${typeName}]` : typeName;

    const responseType = `type ${objName} {
        debug: String
        result: ${resultStr}
        ${usePreviousResult ? 'lastContext: String\n' : ''}
        warnings: [String]
}`;


    const params = { ...defaultInputParameters, ...inputParameters };
    const paramsStr = Object.entries(params).map(
        ([key, value]) => `${key}: ${GRAPHQL_TYPE_MAP[typeof (value)]} = ${typeof (value) == `string` ? `"${value}"` : value}`).join('\n');


    return `${type}

${responseType}

extend type Query {
    ${name}(${paramsStr}): ${objName}
}  
`;
}

module.exports = {
    typeDef,
}