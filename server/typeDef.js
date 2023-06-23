const getGraphQlType = (value) => {
  switch (typeof value) {
    case 'boolean':
      return {type: 'Boolean', defaultValue: 'false'};
      break;
    case 'string':
      return {type: 'String', defaultValue: `""`};
      break;
    case 'number':
      return {type: 'Int', defaultValue: '0'};
      break;
    case 'object':
      if (Array.isArray(value)) {
        if (value.length > 0 && typeof(value[0]) === 'string') {
          return {type: '[String]', defaultValue: '[]'};
        }
        else {
          return {type: '[Message]', defaultValue: '[]'};
        }
      } else {
        return {type: `[${value.objName}]`, defaultValue: 'null'};
      }
      break;
    default:
      return {type: 'String', defaultValue: `""`};
  }
};

const typeDef = (pathway) => {
  const { name, objName, defaultInputParameters, inputParameters, format } = pathway;

  const fields = format ? format.match(/\b(\w+)\b/g) : null;
  const fieldsStr = !fields ? `` : fields.map((f) => `${f}: String`).join('\n    ');

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

  const paramsStr = Object.entries(params)
    .map(([key, value]) => {
      const { type, defaultValue } = getGraphQlType(value);
      return `${key}: ${type} = ${defaultValue}`;
    })
    .join('\n');

  const restDefinition = Object.entries(params).map(([key, value]) => {
    return {
      name: key,
      type: `${getGraphQlType(value).type}`,
    };
  });

  const gqlDefinition = `${messageType}\n\n${type}\n\n${responseType}\n\nextend type Query {${name}(${paramsStr}): ${objName}}`;

  return {
    gqlDefinition,
    restDefinition,
  };
};

export {
  typeDef,
};