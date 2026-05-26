import test from 'ava';
import {
  extractPathwayErrorMessage,
  isLikelyRequestId,
  normalizeResponseOutputText,
} from '../../../server/rest.js';
import { normalizeUsage } from '../../../server/rest/restUtils.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';

test('normalizeResponseOutputText extracts text from output_text and content variants', (t) => {
  const responsePayload = {
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'Hello' },
          { type: 'output_text', text: ' world' }
        ]
      }
    ],
    output_text: '',
    usage: {}
  };

  t.is(normalizeResponseOutputText(responsePayload), 'Hello world');
});

test('normalizeUsage handles Gemini usage metadata fields', (t) => {
  t.deepEqual(normalizeUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 12,
    totalTokenCount: 112,
    cachedContentTokenCount: 20,
  }), {
    input_tokens: 100,
    output_tokens: 12,
    total_tokens: 112,
    cache_read_input_tokens: 20,
  });
});

test('normalizeUsage separates OpenAI cached input details from billable input', (t) => {
  t.deepEqual(normalizeUsage({
    input_tokens: 1000,
    output_tokens: 50,
    total_tokens: 1050,
    input_tokens_details: {
      cached_tokens: 800,
    },
  }), {
    input_tokens: 200,
    output_tokens: 50,
    total_tokens: 1050,
    cache_read_input_tokens: 800,
  });
});

test('normalizeUsage separates OpenAI chat cached prompt details from billable input', (t) => {
  t.deepEqual(normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: {
      cached_tokens: 750,
    },
  }), {
    input_tokens: 250,
    output_tokens: 50,
    total_tokens: 1050,
    cache_read_input_tokens: 750,
  });
});

test('captureStreamUsage accumulates streaming input and output usage', (t) => {
  const resolver = { pathwayResultData: {} };

  PathwayResolver.prototype.captureStreamUsage.call(resolver, JSON.stringify({
    message: {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 25,
      },
    },
  }));
  PathwayResolver.prototype.captureStreamUsage.call(resolver, JSON.stringify({
    usage: {
      output_tokens: 12,
    },
  }));

  t.deepEqual(resolver.pathwayResultData.usage, [{
    input_tokens: 100,
    cache_read_input_tokens: 25,
    output_tokens: 12,
    total_tokens: 112,
  }]);
});

test('normalizeResponseOutputText extracts text from wrapper response objects', (t) => {
  const responsePayload = {
    response: {
      output_text: 'wrapped text'
    }
  };

  t.is(normalizeResponseOutputText(responsePayload), 'wrapped text');
});

test('normalizeResponseOutputText falls back to empty string for non-text payloads', (t) => {
  t.is(normalizeResponseOutputText({ something: 'else' }), '');
  t.is(normalizeResponseOutputText('not-an-object'), '');
  t.is(normalizeResponseOutputText(null), '');
});

test('isLikelyRequestId detects UUID request IDs and ignores non-request text', (t) => {
  t.true(isLikelyRequestId('8f89f9ec-2ca0-4f9f-b6a0-8db7f1e8e6f2'));
  t.true(isLikelyRequestId('8F89F9EC-2CA0-4F9F-B6A0-8DB7F1E8E6F2'));
  t.false(isLikelyRequestId('response text'));
  t.false(isLikelyRequestId('1234-5678-90ab-cdef'));
});

test('extractPathwayErrorMessage extracts first error from pathway errors list', (t) => {
  const pathwayResponse = {
    errors: [
      'Execution failed for sys_rest_streaming_oai_gpt52_codex: Resource not found'
    ]
  };

  t.is(extractPathwayErrorMessage(pathwayResponse), 'Execution failed for sys_rest_streaming_oai_gpt52_codex: Resource not found');
});

test('extractPathwayErrorMessage handles string error payloads', (t) => {
  const pathwayResponse = {
    errors: 'Execution failed for sys_rest_streaming_oai_gpt52_codex: Resource not found'
  };

  t.is(extractPathwayErrorMessage(pathwayResponse), 'Execution failed for sys_rest_streaming_oai_gpt52_codex: Resource not found');
});

test('extractPathwayErrorMessage extracts message from object errors and [ERROR] result prefix', (t) => {
  const objectErrorResponse = {
    errors: [{ message: 'Upstream timeout' }]
  };
  const prefixedErrorResponse = {
    result: '[ERROR] GraphQL execution failed'
  };

  t.is(extractPathwayErrorMessage(objectErrorResponse), 'Upstream timeout');
  t.is(extractPathwayErrorMessage(prefixedErrorResponse), 'GraphQL execution failed');
  t.is(extractPathwayErrorMessage({ result: 'normal result' }), '');
});
