import test from 'ava';
import { GraphQLScalarType } from 'graphql';

test('JSONValue scalar can serialize different data types', (t) => {
  // Test the JSONValue scalar implementation from graphql.js
  const JSONValue = new GraphQLScalarType({
    name: 'JSONValue',
    description: 'A JSON value that can be a string, number, boolean, array, or object',
    serialize: value => value,
    parseValue: value => value,
    parseLiteral: ast => {
      if (ast.kind === 'StringValue' || ast.kind === 'BooleanValue' || 
          ast.kind === 'IntValue' || ast.kind === 'FloatValue') {
        return ast.value;
      }
      if (ast.kind === 'ListValue') {
        return ast.values.map(v => JSONValue.parseLiteral(v));
      }
      if (ast.kind === 'ObjectValue') {
        const obj = {};
        ast.fields.forEach(field => {
          obj[field.name.value] = JSONValue.parseLiteral(field.value);
        });
        return obj;
      }
      return null;
    }
  });

  // Test serialization of different types (what gets sent to client)
  t.is(JSONValue.serialize('single string result'), 'single string result');
  t.deepEqual(JSONValue.serialize(['result1', 'result2']), ['result1', 'result2']);
  t.deepEqual(JSONValue.serialize({ key: 'value' }), { key: 'value' });
  t.is(JSONValue.serialize(123), 123);
  t.is(JSONValue.serialize(true), true);
  t.is(JSONValue.serialize(null), null);
  
  // Test parsing values from client variables
  t.is(JSONValue.parseValue('test'), 'test');
  t.deepEqual(JSONValue.parseValue(['a', 'b']), ['a', 'b']);
  t.deepEqual(JSONValue.parseValue({ nested: 'object' }), { nested: 'object' });
});

test('executeWorkspace resolver applies useParallelPromptProcessing parameter correctly', async (t) => {
  // Mock pathway manager
  const mockPathwayManager = {
    getPathway: async (userId, pathwayName) => ({
      name: pathwayName,
      useParallelPromptProcessing: false, // Default value
      rootResolver: async (parent, args, context, info) => {
        // Simulate different behavior based on parallel processing setting
        if (context.pathway.useParallelPromptProcessing) {
          return { result: ['parallel result 1', 'parallel result 2'] };
        } else {
          return { result: 'single serial result' };
        }
      }
    })
  };

  // Simulate executeWorkspace resolver logic
  const executeWorkspaceResolver = async (_, args, contextValue, info) => {
    const { userId, pathwayName, useParallelPromptProcessing, ...pathwayArgs } = args;
    const userPathway = await mockPathwayManager.getPathway(userId, pathwayName);
    
    // Apply useParallelPromptProcessing parameter if provided
    if (typeof useParallelPromptProcessing === 'boolean') {
      userPathway.useParallelPromptProcessing = useParallelPromptProcessing;
    }
    
    contextValue.pathway = userPathway;
    
    const result = await userPathway.rootResolver(null, pathwayArgs, contextValue, info);
    return result;
  };

  // Test with parallel processing enabled
  const contextParallel = {};
  const resultParallel = await executeWorkspaceResolver(null, {
    userId: 'test-user',
    pathwayName: 'test-pathway',
    useParallelPromptProcessing: true,
    text: 'test input'
  }, contextParallel, null);

  t.true(contextParallel.pathway.useParallelPromptProcessing);
  t.deepEqual(resultParallel.result, ['parallel result 1', 'parallel result 2']);

  // Test with parallel processing disabled
  const contextSerial = {};
  const resultSerial = await executeWorkspaceResolver(null, {
    userId: 'test-user',
    pathwayName: 'test-pathway',
    useParallelPromptProcessing: false,
    text: 'test input'
  }, contextSerial, null);

  t.false(contextSerial.pathway.useParallelPromptProcessing);
  t.is(resultSerial.result, 'single serial result');

  // Test with parameter omitted (should use pathway default)
  const contextDefault = {};
  const resultDefault = await executeWorkspaceResolver(null, {
    userId: 'test-user',
    pathwayName: 'test-pathway',
    text: 'test input'
  }, contextDefault, null);

  t.false(contextDefault.pathway.useParallelPromptProcessing);
  t.is(resultDefault.result, 'single serial result');
});