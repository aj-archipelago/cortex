const GRAPHQL_TYPE_MAP = {
    boolean: 'Boolean',
    string: 'String',
    number: 'Int',
}

// Default parameters for all pathways
const DEFAULT_PARAMETERS = {
    name: "text",
    type: "String",
}

const DEFAULT_RETURN_TYPE = 'String';

const getLabel = (pathway) => {
    const { name, parameters = {} } = pathway;
    let { returnType = DEFAULT_RETURN_TYPE } = pathway;

    if (returnType.name) {
        if (returnType.type === 'list') {
            returnType = `[${returnType.name}]`;
        }
        else {
            returnType = returnType.name;
        }
    }

    const endpointParameters = [DEFAULT_PARAMETERS]

    for (const [name, value] of Object.entries(parameters)) {
        // If the parameter is defined as a single value,
        // expand it to a full definition
        if (typeof (value) !== 'object') {
            endpointParameters.push({
                name,
                type: GRAPHQL_TYPE_MAP[typeof (value)],
                default: value
            })
        }
        else {
            endpointParameters.push({
                name,
                ...value
            })
        }
    }

    let inputParameters = [];

    for (const parameter of endpointParameters) {
        const requiredBang = (parameter.default === undefined || parameter.default === null) ? '!' : '';
        inputParameters.push(`${parameter.name}: ${parameter.type}${requiredBang}`)
    }

    return `${name}(${inputParameters.join(', ')}): ${returnType},`
}

const getReturnTypeDef = (pathway) => {
    const { returnType } = pathway;
    if (returnType) {
        const { name, fields } = returnType;

        if (name !== 'String') {
            return `type ${name} {
${Object.entries(fields).map(([key, value]) => `        ${key}: ${value}`).join(',\n')}
    }`;
        }
    }
    return '';
}

module.exports = {
    typeDef: {
        type: getReturnTypeDef,
        label: getLabel,
    }
}
