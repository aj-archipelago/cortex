// Check if a value is a JSON Schema object for parameter typing
const isJsonSchemaObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Basic JSON Schema indicators
  return (
    typeof value.type === 'string' ||
    value.$ref !== undefined ||
    value.oneOf !== undefined ||
    value.anyOf !== undefined ||
    value.allOf !== undefined ||
    value.enum !== undefined ||
    value.properties !== undefined ||
    value.items !== undefined
  );
};

// Extract the default value from a JSON Schema object or return the value as-is
const extractValueFromTypeSpec = (value) => {
  if (isJsonSchemaObject(value)) {
    return value.hasOwnProperty('default') ? value.default : undefined;
  }
  return value;
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
  // The value might be an object with JSON Schema type specification
  if (isJsonSchemaObject(value)) {
    const schema = value;
    // Map JSON Schema to GraphQL
    if (schema.type === 'boolean') {
      return { type: 'Boolean', defaultValue: schema.default === undefined ? undefined : schema.default };
    }
    if (schema.type === 'string') {
      return { type: 'String', defaultValue: schema.default === undefined ? undefined : `"${schema.default}"` };
    }
    if (schema.type === 'integer') {
      return { type: 'Int', defaultValue: schema.default };
    }
    if (schema.type === 'number') {
      const def = schema.default;
      return { type: 'Float', defaultValue: def };
    }
    if (schema.type === 'array') {
      // Support arrays of primitive types; fall back to JSON string for complex types
      const items = schema.items || {};
      const def = schema.default;
      const defaultArray = Array.isArray(def) ? JSON.stringify(def) : '[]';
      if (items.type === 'string') {
        return { type: '[String]', defaultValue: defaultArray };
      }
      if (items.type === 'integer') {
        return { type: '[Int]', defaultValue: defaultArray };
      }
      if (items.type === 'number') {
        return { type: '[Float]', defaultValue: defaultArray };
      }
      if (items.type === 'boolean') {
        return { type: '[Boolean]', defaultValue: defaultArray };
      }
      // Unknown item type: pass as serialized JSON string argument
      return { type: 'String', defaultValue: def === undefined ? '"[]"' : `"${JSON.stringify(def).replace(/"/g, '\\"')}"` };
    }
    if (schema.type === 'object' || schema.properties) {
      // Until explicit input types are defined, accept as stringified JSON
      const def = schema.default;
      return { type: 'String', defaultValue: def === undefined ? '"{}"' : `"${JSON.stringify(def).replace(/"/g, '\\"')}"` };
    }
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
      // Handle null explicitly (typeof null === 'object' in JavaScript)
      if (value === null) {
        return {type: 'String', defaultValue: '""'};
      }
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
        // Check if it has objName property (for custom object types)
        if (value && value.objName) {
          return {type: `[${value.objName}]`, defaultValue: JSON.stringify(value)};
        }
        // Otherwise treat as generic object (stringify it)
        return {type: 'String', defaultValue: `"${JSON.stringify(value).replace(/"/g, '\\"')}"`};
      }
    default:
      return {type: 'String', defaultValue: `"${value}"`};
  }
};

const getMessageTypeDefs = () => {
  const messageType = `input Message { role: String, content: String, name: String }`;
  const multiMessageType = `input MultiMessage { role: String, content: [String], name: String, tool_calls: [String], tool_call_id: String }`;
  
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
  isJsonSchemaObject,
  extractValueFromTypeSpec,
  processPathwayParameters,
};