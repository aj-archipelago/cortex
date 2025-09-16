import test from 'ava';
import { typeDef, userPathwayInputParameters } from '../server/typeDef.js';

test('pathway typeDef uses JSONValue for result field', (t) => {
  const mockPathway = {
    name: 'testPathway',
    objName: 'TestPathway',
    defaultInputParameters: { text: '' },
    inputParameters: {}
    // No format property, should default to JSONValue
  };

  const result = typeDef(mockPathway);
  
  // Should use JSONValue for flexible return type (strings or arrays)
  t.true(result.gqlDefinition.includes('result: JSONValue'));
  t.false(result.gqlDefinition.includes('result: String'));
});

test('pathway typeDef with format property creates custom result type', (t) => {
  const mockPathway = {
    name: 'formattedPathway',
    objName: 'FormattedPathway',
    defaultInputParameters: { text: '' },
    inputParameters: {},
    format: 'name: {name}, age: {age}'
  };

  const result = typeDef(mockPathway);
  
  // Should create custom result type for formatted output
  t.true(result.gqlDefinition.includes('type FormattedPathwayResult'));
  t.true(result.gqlDefinition.includes('name: String'));
  t.true(result.gqlDefinition.includes('age: String'));
  t.true(result.gqlDefinition.includes('result: FormattedPathwayResult'));
});

test('pathway typeDef with list property creates array return type', (t) => {
  const mockPathway = {
    name: 'listPathway',
    objName: 'ListPathway',
    defaultInputParameters: { text: '' },
    inputParameters: {},
    format: 'item: {item}',
    list: true
  };

  const result = typeDef(mockPathway);
  
  // Should create array of custom result type
  t.true(result.gqlDefinition.includes('type ListPathwayResult'));
  t.true(result.gqlDefinition.includes('result: [ListPathwayResult]'));
});

test('userPathwayInputParameters includes useParallelPromptProcessing', (t) => {
  // Test that dynamic pathway parameters include parallel processing option
  t.true(userPathwayInputParameters.includes('useParallelPromptProcessing'));
  t.true(userPathwayInputParameters.includes('Boolean'));
  t.true(userPathwayInputParameters.includes('text: String'));
  
  // Verify exact format
  t.is(userPathwayInputParameters, 'text: String, useParallelPromptProcessing: Boolean');
});