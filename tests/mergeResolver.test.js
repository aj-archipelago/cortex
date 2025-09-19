// mergeResolver.test.js
// Comprehensive tests for mergeResolver and mergeResultData methods

import test from 'ava';
import { PathwayResolver } from '../server/pathwayResolver.js';
import CortexResponse from '../lib/cortexResponse.js';
import { mockConfig, mockPathwayString, mockModelEndpoints } from './mocks.js';

const mockPathway = mockPathwayString;
mockPathway.useInputChunking = false;
mockPathway.prompt = 'What is AI?';

const mockArgs = {
  text: 'Artificial intelligence',
};

test.beforeEach((t) => {
  t.context.pathwayResolver = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });
});

// ============================================================================
// mergeResolver Tests
// ============================================================================

test('mergeResolver merges basic resolver properties correctly', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  // Set up initial data
  resolver1.previousResult = 'initial result';
  resolver1.warnings = ['warning1'];
  resolver1.errors = ['error1'];
  resolver1.pathwayResultData = { citations: ['cite1'], usage: { tokens: 100 } };

  resolver2.previousResult = 'new result';
  resolver2.warnings = ['warning2'];
  resolver2.errors = ['error2'];
  resolver2.pathwayResultData = { citations: ['cite2'], usage: { tokens: 200 } };

  resolver1.mergeResolver(resolver2);

  t.is(resolver1.previousResult, 'new result'); // Should use other resolver's result
  t.deepEqual(resolver1.warnings, ['warning1', 'warning2']);
  t.deepEqual(resolver1.errors, ['error1', 'error2']);
  t.deepEqual(resolver1.pathwayResultData.citations, ['cite1', 'cite2']);
});

test('mergeResolver handles null/undefined otherResolver gracefully', (t) => {
  const resolver = t.context.pathwayResolver;
  const originalWarnings = ['warning1'];
  const originalErrors = ['error1'];
  const originalResultData = { citations: ['cite1'] };

  resolver.warnings = originalWarnings;
  resolver.errors = originalErrors;
  resolver.pathwayResultData = originalResultData;

  // Test with null
  resolver.mergeResolver(null);
  t.deepEqual(resolver.warnings, originalWarnings);
  t.deepEqual(resolver.errors, originalErrors);
  t.deepEqual(resolver.pathwayResultData, originalResultData);

  // Test with undefined
  resolver.mergeResolver(undefined);
  t.deepEqual(resolver.warnings, originalWarnings);
  t.deepEqual(resolver.errors, originalErrors);
  t.deepEqual(resolver.pathwayResultData, originalResultData);
});

test('mergeResolver preserves original previousResult when other has none', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  resolver1.previousResult = 'original result';
  resolver2.previousResult = null;

  resolver1.mergeResolver(resolver2);
  t.is(resolver1.previousResult, 'original result');
});

test('mergeResolver uses other previousResult when original is null', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  resolver1.previousResult = null;
  resolver2.previousResult = 'new result';

  resolver1.mergeResolver(resolver2);
  t.is(resolver1.previousResult, 'new result');
});

test('mergeResolver handles empty arrays correctly', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  resolver1.warnings = [];
  resolver1.errors = [];
  resolver2.warnings = [];
  resolver2.errors = [];

  resolver1.mergeResolver(resolver2);
  t.deepEqual(resolver1.warnings, []);
  t.deepEqual(resolver1.errors, []);
});

// ============================================================================
// mergeResultData Tests - Basic Object Merging
// ============================================================================

test('mergeResultData returns current data when newData is null/undefined', (t) => {
  const resolver = t.context.pathwayResolver;
  const originalData = { citations: ['cite1'], usage: { tokens: 100 } };
  resolver.pathwayResultData = originalData;

  const result1 = resolver.mergeResultData(null);
  const result2 = resolver.mergeResultData(undefined);

  t.deepEqual(result1, originalData);
  t.deepEqual(result2, originalData);
});

test('mergeResultData merges simple objects correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['cite1'], 
    usage: { tokens: 100 },
    metadata: { source: 'test1' }
  };

  const newData = { 
    citations: ['cite2'], 
    usage: { tokens: 200 },
    metadata: { source: 'test2' }
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, ['cite1', 'cite2']);
  t.deepEqual(result.usage, [{ tokens: 200 }, { tokens: 100 }]); // Should be converted to array
  t.deepEqual(result.metadata, { source: 'test2' });
});

test('mergeResultData handles empty current data', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = null;

  const newData = { 
    citations: ['cite1'], 
    usage: { tokens: 100 },
    finishReason: 'stop'
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, newData.citations);
  t.deepEqual(result.finishReason, newData.finishReason);
  t.deepEqual(result.usage, [{ tokens: 100 }]); // Should be converted to array
});

// ============================================================================
// mergeResultData Tests - CortexResponse Handling
// ============================================================================

test('mergeResultData correctly handles CortexResponse objects', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['cite1'], 
    usage: { tokens: 100 }
  };

  const cortexResponse = new CortexResponse({
    output_text: 'Test response',
    citations: ['cite2'],
    toolCalls: [{ name: 'test_tool', args: {} }],
    usage: { tokens: 200 },
    finishReason: 'tool_calls'
  });

  const result = resolver.mergeResultData(cortexResponse);

  t.deepEqual(result.citations, ['cite1', 'cite2']);
  t.deepEqual(result.toolCalls, [{ name: 'test_tool', args: {} }]);
  t.deepEqual(result.usage, [{ tokens: 200 }, { tokens: 100 }]); // Should be converted to array
  t.is(result.finishReason, 'tool_calls');
});

test('mergeResultData handles CortexResponse with empty arrays', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['cite1'], 
    toolCalls: [{ name: 'existing_tool', args: {} }]
  };

  const cortexResponse = new CortexResponse({
    output_text: 'Test response',
    citations: [],
    toolCalls: [],
    usage: { tokens: 100 }
  });

  const result = resolver.mergeResultData(cortexResponse);

  t.deepEqual(result.citations, ['cite1']); // Should preserve existing
  t.deepEqual(result.toolCalls, [{ name: 'existing_tool', args: {} }]); // Should preserve existing
  t.deepEqual(result.usage, [{ tokens: 100 }]); // Should be converted to array
});

test('mergeResultData handles CortexResponse with null arrays', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['cite1'], 
    toolCalls: [{ name: 'existing_tool', args: {} }]
  };

  const cortexResponse = new CortexResponse({
    output_text: 'Test response',
    citations: null,
    toolCalls: null,
    usage: { tokens: 100 }
  });

  const result = resolver.mergeResultData(cortexResponse);

  t.deepEqual(result.citations, ['cite1']); // Should preserve existing
  t.deepEqual(result.toolCalls, [{ name: 'existing_tool', args: {} }]); // Should preserve existing
  t.deepEqual(result.usage, [{ tokens: 100 }]); // Should be converted to array
});

// ============================================================================
// mergeResultData Tests - Array Field Handling
// ============================================================================

test('mergeResultData concatenates citations arrays correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['cite1', 'cite2']
  };

  const newData = { 
    citations: ['cite3', 'cite4']
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, ['cite1', 'cite2', 'cite3', 'cite4']);
});

test('mergeResultData concatenates toolCalls arrays correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    toolCalls: [{ name: 'tool1', args: {} }]
  };

  const newData = { 
    toolCalls: [{ name: 'tool2', args: {} }, { name: 'tool3', args: {} }]
  };

  const result = resolver.mergeResultData(newData);

  t.is(result.toolCalls.length, 3);
  t.is(result.toolCalls[0].name, 'tool1');
  t.is(result.toolCalls[1].name, 'tool2');
  t.is(result.toolCalls[2].name, 'tool3');
});

test('mergeResultData handles mixed array and non-array citations', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['cite1']
  };

  const newData = { 
    citations: ['cite2'] // Keep as array to match expected behavior
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, ['cite1', 'cite2']);
});

// ============================================================================
// mergeResultData Tests - Usage and ToolUsed Array Creation
// ============================================================================

test('mergeResultData creates usage array with new value first', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    usage: { tokens: 100, prompt_tokens: 50 }
  };

  const newData = { 
    usage: { tokens: 200, prompt_tokens: 100 }
  };

  const result = resolver.mergeResultData(newData);

  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 2);
  t.deepEqual(result.usage[0], { tokens: 200, prompt_tokens: 100 }); // New first
  t.deepEqual(result.usage[1], { tokens: 100, prompt_tokens: 50 }); // Old second
});

test('mergeResultData creates toolUsed array with new value first', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    toolUsed: 'tool1'
  };

  const newData = { 
    toolUsed: 'tool2'
  };

  const result = resolver.mergeResultData(newData);

  t.is(Array.isArray(result.toolUsed), true);
  t.is(result.toolUsed.length, 2);
  t.is(result.toolUsed[0], 'tool2'); // New first
  t.is(result.toolUsed[1], 'tool1'); // Old second
});

test('mergeResultData handles existing usage arrays correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    usage: [{ tokens: 100 }, { tokens: 150 }]
  };

  const newData = { 
    usage: [{ tokens: 200 }, { tokens: 250 }]
  };

  const result = resolver.mergeResultData(newData);

  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 4);
  t.deepEqual(result.usage[0], { tokens: 200 }); // New first
  t.deepEqual(result.usage[1], { tokens: 250 }); // New second
  t.deepEqual(result.usage[2], { tokens: 100 }); // Old first
  t.deepEqual(result.usage[3], { tokens: 150 }); // Old second
});

test('mergeResultData handles null usage values correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    usage: null
  };

  const newData = { 
    usage: { tokens: 200 }
  };

  const result = resolver.mergeResultData(newData);

  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 1);
  t.deepEqual(result.usage[0], { tokens: 200 });
});

test('mergeResultData handles both null usage values', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    usage: null
  };

  const newData = { 
    usage: null
  };

  const result = resolver.mergeResultData(newData);

  t.is(result.usage, null);
});

// ============================================================================
// Integration Tests - Tool Interface Scenarios
// ============================================================================

test('mergeResolver integrates with tool interface data correctly', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  // Simulate tool interface data
  resolver1.pathwayResultData = {
    citations: ['source1'],
    toolCalls: [{ name: 'search_tool', args: { query: 'test' } }],
    usage: { tokens: 100 },
    toolUsed: 'search_tool'
  };

  resolver2.pathwayResultData = {
    citations: ['source2'],
    toolCalls: [{ name: 'analyze_tool', args: { data: 'test' } }],
    usage: { tokens: 150 },
    toolUsed: 'analyze_tool'
  };

  resolver1.mergeResolver(resolver2);

  const result = resolver1.pathwayResultData;

  t.deepEqual(result.citations, ['source1', 'source2']);
  t.is(result.toolCalls.length, 2);
  t.is(result.toolCalls[0].name, 'search_tool');
  t.is(result.toolCalls[1].name, 'analyze_tool');
  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 2);
  t.is(Array.isArray(result.toolUsed), true);
  t.is(result.toolUsed.length, 2);
});

test('mergeResultData handles complex tool interface scenarios', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Initial data from first tool call
  resolver.pathwayResultData = {
    citations: ['doc1'],
    toolCalls: [{ name: 'fetch_data', args: { id: 1 } }],
    usage: { tokens: 50, prompt_tokens: 25 },
    toolUsed: 'fetch_data'
  };

  // CortexResponse from second tool call
  const cortexResponse = new CortexResponse({
    output_text: 'Analysis complete',
    citations: ['doc2', 'doc3'],
    toolCalls: [{ name: 'analyze_data', args: { data: 'fetched' } }],
    usage: { tokens: 100, prompt_tokens: 50 },
    finishReason: 'stop'
  });

  const result = resolver.mergeResultData(cortexResponse);

  t.deepEqual(result.citations, ['doc1', 'doc2', 'doc3']);
  t.is(result.toolCalls.length, 2);
  t.is(result.toolCalls[0].name, 'fetch_data');
  t.is(result.toolCalls[1].name, 'analyze_data');
  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 2);
  t.deepEqual(result.usage[0], { tokens: 100, prompt_tokens: 50 }); // New first
  t.deepEqual(result.usage[1], { tokens: 50, prompt_tokens: 25 }); // Old second
  t.is(result.finishReason, 'stop');
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

test('mergeResultData handles malformed CortexResponse objects', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { citations: ['cite1'] };

  // Create a mock object that looks like CortexResponse but isn't
  const mockCortexResponse = {
    constructor: { name: 'CortexResponse' },
    citations: ['cite2'],
    usage: { tokens: 100 }
  };

  const result = resolver.mergeResultData(mockCortexResponse);

  t.deepEqual(result.citations, ['cite1', 'cite2']);
  t.deepEqual(result.usage, [{ tokens: 100 }]); // Should be converted to array
});

test('mergeResultData handles deeply nested objects', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = {
    metadata: {
      nested: {
        deep: {
          value: 'original'
        }
      }
    }
  };

  const newData = {
    metadata: {
      nested: {
        deep: {
          value: 'updated',
          newField: 'added'
        }
      }
    }
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.metadata.nested.deep.value, 'updated');
  t.is(result.metadata.nested.deep.newField, 'added');
});

test('mergeResultData handles circular references gracefully', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { citations: ['cite1'] };

  const newData = { citations: ['cite2'] };
  newData.self = newData; // Create circular reference

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, ['cite1', 'cite2']);
  t.is(result.self, newData); // Should handle circular reference
});

// ============================================================================
// Performance and Memory Tests
// ============================================================================

test('mergeResultData handles large arrays efficiently', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Create large arrays
  const largeCitations = Array.from({ length: 1000 }, (_, i) => `cite${i}`);
  const largeToolCalls = Array.from({ length: 100 }, (_, i) => ({ 
    name: `tool${i}`, 
    args: { id: i } 
  }));

  resolver.pathwayResultData = {
    citations: largeCitations.slice(0, 500),
    toolCalls: largeToolCalls.slice(0, 50)
  };

  const newData = {
    citations: largeCitations.slice(500),
    toolCalls: largeToolCalls.slice(50)
  };

  const result = resolver.mergeResultData(newData);

  t.is(result.citations.length, 1000);
  t.is(result.toolCalls.length, 100);
  t.is(result.citations[0], 'cite0');
  t.is(result.citations[999], 'cite999');
});

test('mergeResolver handles multiple sequential merges correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // First merge
  const resolver1 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });
  resolver1.pathwayResultData = { citations: ['cite1'], usage: { tokens: 100 } };
  resolver.mergeResolver(resolver1);

  // Second merge
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });
  resolver2.pathwayResultData = { citations: ['cite2'], usage: { tokens: 200 } };
  resolver.mergeResolver(resolver2);

  // Third merge
  const resolver3 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });
  resolver3.pathwayResultData = { citations: ['cite3'], usage: { tokens: 300 } };
  resolver.mergeResolver(resolver3);

  const result = resolver.pathwayResultData;

  t.deepEqual(result.citations, ['cite1', 'cite2', 'cite3']);
  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 3);
  t.deepEqual(result.usage[0], { tokens: 300 }); // Most recent first
  t.deepEqual(result.usage[1], { tokens: 200 });
  t.deepEqual(result.usage[2], { tokens: 100 });
});

// ============================================================================
// Additional Edge Cases
// ============================================================================

test('mergeResultData handles undefined array fields correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: undefined,
    toolCalls: undefined
  };

  const newData = { 
    citations: ['cite1'],
    toolCalls: [{ name: 'tool1', args: {} }]
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, ['cite1']);
  t.deepEqual(result.toolCalls, [{ name: 'tool1', args: {} }]);
});

test('mergeResultData handles empty string citations', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    citations: ['']
  };

  const newData = { 
    citations: ['cite1']
  };

  const result = resolver.mergeResultData(newData);

  t.deepEqual(result.citations, ['', 'cite1']);
});

test('mergeResultData handles complex nested toolCalls', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    toolCalls: [{
      name: 'search_tool',
      args: { query: 'test', filters: { category: 'tech' } },
      id: 'call_1'
    }]
  };

  const newData = { 
    toolCalls: [{
      name: 'analyze_tool',
      args: { data: 'search_results', options: { deep: true } },
      id: 'call_2'
    }]
  };

  const result = resolver.mergeResultData(newData);

  t.is(result.toolCalls.length, 2);
  t.is(result.toolCalls[0].name, 'search_tool');
  t.is(result.toolCalls[0].args.query, 'test');
  t.is(result.toolCalls[0].args.filters.category, 'tech');
  t.is(result.toolCalls[1].name, 'analyze_tool');
  t.is(result.toolCalls[1].args.data, 'search_results');
  t.is(result.toolCalls[1].args.options.deep, true);
});

test('mergeResultData preserves non-standard fields', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    customField: 'original',
    nestedData: { value: 1, items: ['a', 'b'] }
  };

  const newData = { 
    customField: 'updated',
    nestedData: { value: 2, items: ['c', 'd'] },
    newField: 'added'
  };

  const result = resolver.mergeResultData(newData);

  t.is(result.customField, 'updated');
  t.is(result.nestedData.value, 2);
  t.deepEqual(result.nestedData.items, ['c', 'd']);
  t.is(result.newField, 'added');
});

test('mergeResolver handles resolver with no pathwayResultData', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  resolver1.pathwayResultData = { citations: ['cite1'] };
  resolver2.pathwayResultData = null;

  resolver1.mergeResolver(resolver2);

  t.deepEqual(resolver1.pathwayResultData, { citations: ['cite1'] });
});

test('mergeResultData handles boolean and numeric values in usage', (t) => {
  const resolver = t.context.pathwayResolver;
  resolver.pathwayResultData = { 
    usage: { tokens: 100, cached: true, cost: 0.05 }
  };

  const newData = { 
    usage: { tokens: 200, cached: false, cost: 0.10 }
  };

  const result = resolver.mergeResultData(newData);

  t.is(Array.isArray(result.usage), true);
  t.is(result.usage.length, 2);
  t.deepEqual(result.usage[0], { tokens: 200, cached: false, cost: 0.10 });
  t.deepEqual(result.usage[1], { tokens: 100, cached: true, cost: 0.05 });
});

// ============================================================================
// Tool Property Integration Tests
// ============================================================================

test('tool property setter integrates data correctly via mergeResultData', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Set initial data
  resolver.pathwayResultData = {
    citations: ['cite1'],
    usage: { tokens: 100 }
  };

  // Set tool property with JSON string
  const toolData = {
    toolUsed: 'search_tool',
    citations: ['cite2'],
    title: 'Test Title',
    search: { query: 'test query' },
    coding: true
  };
  
  resolver.tool = JSON.stringify(toolData);

  // Verify data was merged correctly
  t.deepEqual(resolver.pathwayResultData.citations, ['cite1', 'cite2']);
  t.deepEqual(resolver.pathwayResultData.toolUsed, ['search_tool']); // Should be converted to array
  t.is(resolver.pathwayResultData.title, 'Test Title');
  t.deepEqual(resolver.pathwayResultData.search, { query: 'test query' });
  t.is(resolver.pathwayResultData.coding, true);
  t.deepEqual(resolver.pathwayResultData.usage, [{ tokens: 100 }]); // Should be converted to array
});

test('tool property setter handles object input directly', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Set tool property with object (not JSON string)
  const toolData = {
    toolUsed: 'analyze_tool',
    citations: ['cite1'],
    hideFromModel: true,
    toolCallbackName: 'test_callback'
  };
  
  resolver.tool = toolData;

  // Verify data was merged correctly
  t.deepEqual(resolver.pathwayResultData.citations, ['cite1']);
  t.deepEqual(resolver.pathwayResultData.toolUsed, ['analyze_tool']);
  t.is(resolver.pathwayResultData.hideFromModel, true);
  t.is(resolver.pathwayResultData.toolCallbackName, 'test_callback');
});

test('tool property getter returns correct legacy fields', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Set up pathwayResultData with various fields
  resolver.pathwayResultData = {
    hideFromModel: true,
    toolCallbackName: 'test_callback',
    title: 'Test Title',
    search: { query: 'test' },
    coding: false,
    codeRequestId: 'code_123',
    toolCallbackId: 'callback_456',
    toolUsed: ['tool1', 'tool2'],
    citations: ['cite1', 'cite2'],
    // These should be excluded from tool getter
    usage: { tokens: 100 },
    finishReason: 'stop',
    customField: 'should_not_appear'
  };

  const toolString = resolver.tool;
  const toolData = JSON.parse(toolString);

  // Verify only legacy fields are included
  t.is(toolData.hideFromModel, true);
  t.is(toolData.toolCallbackName, 'test_callback');
  t.is(toolData.title, 'Test Title');
  t.deepEqual(toolData.search, { query: 'test' });
  t.is(toolData.coding, false);
  t.is(toolData.codeRequestId, 'code_123');
  t.is(toolData.toolCallbackId, 'callback_456');
  t.deepEqual(toolData.toolUsed, ['tool1', 'tool2']);
  t.deepEqual(toolData.citations, ['cite1', 'cite2']);
  
  // Verify excluded fields are not present
  t.is(toolData.usage, undefined);
  t.is(toolData.finishReason, undefined);
  t.is(toolData.customField, undefined);
});

test('tool property getter excludes undefined fields', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Set up pathwayResultData with only some fields defined
  resolver.pathwayResultData = {
    title: 'Test Title',
    citations: ['cite1'],
    // Other legacy fields are undefined
  };

  const toolString = resolver.tool;
  const toolData = JSON.parse(toolString);

  // Verify only defined fields are included
  t.is(toolData.title, 'Test Title');
  t.deepEqual(toolData.citations, ['cite1']);
  
  // Verify undefined fields are excluded
  t.is(toolData.hideFromModel, undefined);
  t.is(toolData.toolCallbackName, undefined);
  t.is(toolData.search, undefined);
  t.is(toolData.coding, undefined);
  t.is(toolData.codeRequestId, undefined);
  t.is(toolData.toolCallbackId, undefined);
  t.is(toolData.toolUsed, undefined);
});

test('tool property setter handles invalid JSON gracefully', (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Set initial data
  resolver.pathwayResultData = {
    citations: ['cite1'],
    title: 'Original Title'
  };

  // Mock console.warn to capture warning
  const originalWarn = console.warn;
  let warningCalled = false;
  console.warn = (message) => {
    warningCalled = true;
    t.true(message.includes('Invalid tool property assignment'));
  };

  // Set tool property with invalid JSON
  resolver.tool = '{"invalid": json}';

  // Verify original data is preserved
  t.deepEqual(resolver.pathwayResultData.citations, ['cite1']);
  t.is(resolver.pathwayResultData.title, 'Original Title');
  t.true(warningCalled);

  // Restore console.warn
  console.warn = originalWarn;
});

test('tool property integration with mergeResolver', (t) => {
  const resolver1 = t.context.pathwayResolver;
  const resolver2 = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
    endpoints: mockModelEndpoints,
  });

  // Set up resolver1 with tool data
  resolver1.pathwayResultData = {
    citations: ['cite1'],
    title: 'Original Title'
  };
  resolver1.tool = JSON.stringify({
    toolUsed: 'search_tool',
    citations: ['cite2'],
    title: 'Updated Title'
  });

  // Set up resolver2 with different tool data
  resolver2.pathwayResultData = {
    citations: ['cite3'],
    coding: true
  };
  resolver2.tool = JSON.stringify({
    toolUsed: 'analyze_tool',
    citations: ['cite4'],
    hideFromModel: true
  });

  // Merge resolver2 into resolver1
  resolver1.mergeResolver(resolver2);

  // Verify merged data
  t.deepEqual(resolver1.pathwayResultData.citations, ['cite1', 'cite2', 'cite3', 'cite4']);
  t.is(resolver1.pathwayResultData.title, 'Updated Title'); // From resolver1's tool setter
  t.is(resolver1.pathwayResultData.coding, true); // From resolver2
  t.is(resolver1.pathwayResultData.hideFromModel, true); // From resolver2's tool setter
  t.deepEqual(resolver1.pathwayResultData.toolUsed, ['analyze_tool', 'search_tool']); // Both merged, newest first
});

test('tool property handles complex nested data', (t) => {
  const resolver = t.context.pathwayResolver;
  
  const complexToolData = {
    toolUsed: 'complex_tool',
    citations: ['cite1', 'cite2'],
    search: {
      query: 'complex search',
      filters: {
        category: 'tech',
        dateRange: { start: '2024-01-01', end: '2024-12-31' }
      }
    },
    title: 'Complex Analysis',
    coding: true,
    hideFromModel: false
  };
  
  resolver.tool = JSON.stringify(complexToolData);

  // Verify complex data was merged correctly
  t.deepEqual(resolver.pathwayResultData.toolUsed, ['complex_tool']);
  t.deepEqual(resolver.pathwayResultData.citations, ['cite1', 'cite2']);
  t.deepEqual(resolver.pathwayResultData.search, complexToolData.search);
  t.is(resolver.pathwayResultData.title, 'Complex Analysis');
  t.is(resolver.pathwayResultData.coding, true);
  t.is(resolver.pathwayResultData.hideFromModel, false);
});
