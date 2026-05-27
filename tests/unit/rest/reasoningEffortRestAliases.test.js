import test from 'ava';
import { buildRestEndpoints } from '../../../server/rest.js';

const createMockConfig = () => ({
  get: (key) => {
    if (key === 'enableRestEndpoints') return true;
    if (key === 'ollamaUrl') return null;
    return undefined;
  }
});

const createMockApp = () => {
  const postHandlers = new Map();
  const getHandlers = new Map();

  return {
    postHandlers,
    getHandlers,
    post: (path, handler) => postHandlers.set(path, handler),
    get: (path, handler) => getHandlers.set(path, handler)
  };
};

const createMockResponse = () => ({
  statusCode: 200,
  body: null,
  writableEnded: false,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    this.writableEnded = true;
    return this;
  },
  send(payload) {
    this.body = payload;
    this.writableEnded = true;
    return this;
  },
  setHeader() {},
  flushHeaders() {},
  write() {},
  end() {
    this.writableEnded = true;
  }
});

const createMockPathway = () => ({
  emulateOpenAIChatModel: 'test-reasoning-model',
  typeDef: () => ({
    restDefinition: [
      { name: 'messages', type: '[MultiMessage]' },
      { name: 'tools', type: 'String' },
      { name: 'tool_choice', type: 'String' },
      { name: 'functions', type: 'String' },
      { name: 'stream', type: 'Boolean' },
      { name: 'reasoningEffort', type: 'String' },
      { name: 'thinkingType', type: 'String' },
      { name: 'thinkingBudgetTokens', type: 'Int' }
    ]
  })
});

test('POST /v1/chat/completions maps reasoning_effort to reasoningEffort', async (t) => {
  const pathwayName = 'sys_rest_streaming_test_reasoning';
  const capturedVariables = [];
  const server = {
    executeOperation: async ({ variables }) => {
      capturedVariables.push(variables);
      return {
        body: {
          singleResult: {
            data: {
              [pathwayName]: {
                contextId: 'ctx_1',
                previousResult: '',
                result: 'ok',
                resultData: null,
                tool: null,
                warnings: null,
                errors: null,
                debug: null
              }
            }
          }
        }
      };
    }
  };

  const app = createMockApp();
  buildRestEndpoints({ [pathwayName]: createMockPathway() }, app, server, createMockConfig());

  const handler = app.postHandlers.get('/v1/chat/completions');
  t.truthy(handler);

  const res = createMockResponse();
  await handler(
    {
      body: {
        model: 'test-reasoning-model',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'high',
        stream: false
      }
    },
    res
  );

  t.is(capturedVariables.length, 1);
  t.is(capturedVariables[0].reasoningEffort, 'high');
  t.is(res.statusCode, 200);
  t.truthy(res.body);
});

test('POST /v1/responses maps reasoning_effort to reasoningEffort', async (t) => {
  const pathwayName = 'sys_rest_streaming_test_reasoning_responses';
  const capturedVariables = [];
  const server = {
    executeOperation: async ({ variables }) => {
      capturedVariables.push(variables);
      return {
        body: {
          singleResult: {
            data: {
              [pathwayName]: {
                contextId: 'ctx_1',
                previousResult: '',
                result: 'ok',
                resultData: null,
                tool: null,
                warnings: null,
                errors: null,
                debug: null
              }
            }
          }
        }
      };
    }
  };

  const app = createMockApp();
  buildRestEndpoints({ [pathwayName]: createMockPathway() }, app, server, createMockConfig());

  const handler = app.postHandlers.get('/v1/responses');
  t.truthy(handler);

  const res = createMockResponse();
  await handler(
    {
      body: {
        model: 'test-reasoning-model',
        input: 'hello',
        reasoning_effort: 'medium',
        stream: false
      }
    },
    res
  );

  t.is(capturedVariables.length, 1);
  t.is(capturedVariables[0].reasoningEffort, 'medium');
  t.is(res.statusCode, 200);
  t.truthy(res.body);
});

test('POST /v1/messages maps reasoning_effort to reasoningEffort', async (t) => {
  const pathwayName = 'sys_rest_streaming_test_reasoning_messages';
  const capturedVariables = [];
  const server = {
    executeOperation: async ({ variables }) => {
      capturedVariables.push(variables);
      return {
        body: {
          singleResult: {
            data: {
              [pathwayName]: {
                contextId: 'ctx_1',
                previousResult: '',
                result: 'ok',
                resultData: null,
                tool: null,
                warnings: null,
                errors: null,
                debug: null
              }
            }
          }
        }
      };
    }
  };

  const app = createMockApp();
  buildRestEndpoints({ [pathwayName]: createMockPathway() }, app, server, createMockConfig());

  const handler = app.postHandlers.get('/v1/messages');
  t.truthy(handler);

  const res = createMockResponse();
  await handler(
    {
      body: {
        model: 'test-reasoning-model',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'low',
        stream: false
      }
    },
    res
  );

  t.is(capturedVariables.length, 1);
  t.is(capturedVariables[0].reasoningEffort, 'low');
  t.is(res.statusCode, 200);
  t.truthy(res.body);
});

test('POST /v1/messages maps thinking.budget_tokens to reasoningEffort', async (t) => {
  const pathwayName = 'sys_rest_streaming_test_reasoning_messages_thinking';
  const capturedVariables = [];
  const server = {
    executeOperation: async ({ variables }) => {
      capturedVariables.push(variables);
      return {
        body: {
          singleResult: {
            data: {
              [pathwayName]: {
                contextId: 'ctx_1',
                previousResult: '',
                result: 'ok',
                resultData: null,
                tool: null,
                warnings: null,
                errors: null,
                debug: null
              }
            }
          }
        }
      };
    }
  };

  const app = createMockApp();
  buildRestEndpoints({ [pathwayName]: createMockPathway() }, app, server, createMockConfig());

  const handler = app.postHandlers.get('/v1/messages');
  t.truthy(handler);

  const res = createMockResponse();
  await handler(
    {
      body: {
        model: 'test-reasoning-model',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: {
          type: 'enabled',
          budget_tokens: 9000
        },
        stream: false
      }
    },
    res
  );

  t.is(capturedVariables.length, 1);
  t.is(capturedVariables[0].reasoningEffort, 'high');
  t.is(capturedVariables[0].thinkingType, 'enabled');
  t.is(capturedVariables[0].thinkingBudgetTokens, 9000);
  t.is(res.statusCode, 200);
  t.truthy(res.body);
});

test('POST /v1/messages maps output_config.effort and adaptive thinking', async (t) => {
  const pathwayName = 'sys_rest_streaming_test_reasoning_messages_output_config';
  const capturedVariables = [];
  const server = {
    executeOperation: async ({ variables }) => {
      capturedVariables.push(variables);
      return {
        body: {
          singleResult: {
            data: {
              [pathwayName]: {
                contextId: 'ctx_1',
                previousResult: '',
                result: 'ok',
                resultData: null,
                tool: null,
                warnings: null,
                errors: null,
                debug: null
              }
            }
          }
        }
      };
    }
  };

  const app = createMockApp();
  buildRestEndpoints({ [pathwayName]: createMockPathway() }, app, server, createMockConfig());

  const handler = app.postHandlers.get('/v1/messages');
  t.truthy(handler);

  const res = createMockResponse();
  await handler(
    {
      body: {
        model: 'test-reasoning-model',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: {
          type: 'adaptive'
        },
        output_config: {
          effort: 'max'
        },
        stream: false
      }
    },
    res
  );

  t.is(capturedVariables.length, 1);
  t.is(capturedVariables[0].reasoningEffort, 'max');
  t.is(capturedVariables[0].thinkingType, 'adaptive');
  t.is(res.statusCode, 200);
  t.truthy(res.body);
});
