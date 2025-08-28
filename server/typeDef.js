const getGraphQlType = (value, paramName) => {
  // Special handling for tools parameter
  if (paramName === 'tools' && Array.isArray(value)) {
    return {type: '[Tool]'};
  }
  
  // Special handling for functions parameter (legacy)
  if (paramName === 'functions' && Array.isArray(value)) {
    return {type: '[Function]'};
  }
  
  switch (typeof value) {
    case 'boolean':
      return {type: 'Boolean'};
    case 'string':
      return {type: 'String'};
    case 'number':
      return {type: 'Int'};
    case 'object':
      if (Array.isArray(value)) {
        if (value.length > 0 && typeof(value[0]) === 'string') {
          return {type: '[String]'};
        }
        else {
          // New case for MultiMessage type
          if (Array.isArray(value[0]?.content)) {
            return {type: '[MultiMessage]'};
          }
          else {
            return {type: '[Message]'};
          }
        }
      } else {
        return {type: `[${value.objName}]`};
      }
    default:
      return {type: 'String'};
  }
};

const getMessageTypeDefs = () => {
  // Add tool call support for OpenAI function calling compatibility
  const toolCallType = `input ToolCall { 
    id: String
    type: String
    function: ToolCallFunction 
  }`;
  
  const toolCallFunctionType = `input ToolCallFunction {
    name: String
    arguments: String
  }`;
  
  // Add tool definition types for OpenAI tools parameter
  const toolType = `input Tool {
    type: String
    function: ToolFunction
  }`;
  
  const toolFunctionType = `input ToolFunction {
    name: String
    description: String
    parameters: String
    strict: Boolean
  }`;
  
  // Add function definition type for OpenAI functions parameter (legacy)
  const functionType = `input Function {
    name: String
    description: String
    parameters: String
  }`;
  
  // Updated Message type with optional tool_calls and tool_call_id fields
  const messageType = `input Message { 
    role: String
    content: String
    name: String
    tool_calls: [ToolCall]
    tool_call_id: String
  }`;
  
  // Updated MultiMessage type with optional tool_calls and tool_call_id fields  
  const multiMessageType = `input MultiMessage { 
    role: String
    content: [String]
    name: String
    tool_calls: [ToolCall]
    tool_call_id: String
  }`;
  
  return `${toolFunctionType}\n\n${toolType}\n\n${functionType}\n\n${toolCallFunctionType}\n\n${toolCallType}\n\n${messageType}\n\n${multiMessageType}`;
};

const getPathwayTypeDef = (name, returnType) => {
  return `type ${name} {
    debug: String
    result: ${returnType}
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
      const { type, defaultValue } = getGraphQlType(value, key);
      return `${key}: ${type} = ${defaultValue}`;
    })
    .join('\n');

  const restDefinition = Object.entries(params).map(([key, value]) => {
    return {
      name: key,
      type: `${getGraphQlType(value, key).type}`,
    };
  });

  const gqlDefinition = `${type}\n\n${responseType}\n\nextend type Query {${name}(${paramsStr}): ${objName}}`;

  return {
    gqlDefinition,
    restDefinition,
  };
};

const typeDef = (pathway) => {
  return getPathwayTypeDefAndExtendQuery(pathway);
};

const userPathwayInputParameters = `text: String`;


export {
  typeDef,
  getMessageTypeDefs,
  getPathwayTypeDef,
  userPathwayInputParameters,
};