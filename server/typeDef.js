// Check if a value is a type specification object
const isTypeSpecObject = (value) => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 
         value.type && value.value !== undefined && 
         Object.keys(value).length === 2 && 
         Object.keys(value).includes('type') && Object.keys(value).includes('value');
};

// Extract the actual value from a type specification object or return the value as-is
const extractValueFromTypeSpec = (value) => {
  return isTypeSpecObject(value) ? value.value : value;
};

// Process parameters to convert any type specification objects to their actual values
const processPathwayParameters = (params) => {
  if (!params || typeof params !== 'object') {
    return params;
  }
  
  const processed = {};
  for (const [key, value] of Object.entries(params)) {
    processed[key] = extractValueFromTypeSpec(value);
  }
  return processed;
};

const getGraphQlType = (value) => {
  // The value might be an object with explicit type specification
  if (isTypeSpecObject(value)) {
    return {
      type: value.type,
      defaultValue: typeof value.value === 'string' ? `"${value.value}"` : 
                   Array.isArray(value.value) ? JSON.stringify(value.value) : value.value
    };
  }
  
  // Otherwise, autodetect the type
  switch (typeof value) {
    case 'boolean':
      return {type: 'Boolean', defaultValue: value};
    case 'string':
      return {type: 'String', defaultValue: `"${value}"`};
    case 'number':
      // Check if it's an integer or float
      return Number.isInteger(value) ? {type: 'Int', defaultValue: value} : {type: 'Float', defaultValue: value};
    case 'object':
      if (Array.isArray(value)) {
        if (value.length > 0 && typeof(value[0]) === 'string') {
          return {type: '[String]', defaultValue: JSON.stringify(value)};
        }
        else {
          // Check if it's MultiMessage (content is array) or Message (content is string)
          if (Array.isArray(value[0]?.content)) {
            return {type: '[MultiMessage]', defaultValue: `"${JSON.stringify(value).replace(/"/g, '\\"')}"`};
          }
          else {
            return {type: '[Message]', defaultValue: `"${JSON.stringify(value).replace(/"/g, '\\"')}"`};
          }
        }
      } else {
        return {type: `[${value.objName}]`, defaultValue: JSON.stringify(value)};
      }
    default:
      return {type: 'String', defaultValue: `"${value}"`};
  }
};

const getMessageTypeDefs = () => {
  const messageType = `input Message { role: String, content: String, name: String }`;
  const multiMessageType = `input MultiMessage { role: String, content: [String], name: String }`;
  
  return `${messageType}\n\n${multiMessageType}`;
};

const getPathwayTypeDef = (name, returnType) => {
  return `type ${name} {
    debug: String
    result: ${returnType}
    resultData: String
    previousResult: String
    warnings: [String]
    errors: [String]
    contextId: String
    tool: String
  }`
};

const getPathwayTypeDefAndExtendQuery = (pathway) => {
  const { name, objName, defaultInputParameters, inputParameters, format } = pathway;

  const fields = format ? format.match(/\b(\w+)\b/g) : null;
  const fieldsStr = !fields ? `` : fields.map((f) => `${f}: String`).join('\n    ');

  const typeName = fields ? `${objName}Result` : `String`;

  const type = fields ? `type ${typeName} {
    ${fieldsStr}
    }` : ``;

  const returnType = pathway.list ? `[${typeName}]` : typeName;

  const responseType = getPathwayTypeDef(objName, returnType);

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

  const gqlDefinition = `${type}\n\n${responseType}\n\nextend type Query {${name}${paramsStr ? `(${paramsStr})` : ''}: ${objName}}`;

  return {
    gqlDefinition,
    restDefinition,
  };
};

const typeDef = (pathway) => {
  return getPathwayTypeDefAndExtendQuery(pathway);
};

const userPathwayInputParameters = `text: String, promptNames: [String]`;


export {
  typeDef,
  getMessageTypeDefs,
  getPathwayTypeDef,
  userPathwayInputParameters,
  isTypeSpecObject,
  extractValueFromTypeSpec,
  processPathwayParameters,
};