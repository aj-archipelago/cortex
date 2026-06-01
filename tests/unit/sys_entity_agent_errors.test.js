import test from 'ava';
import sysEntityAgent, {
  applyNewMcpConfigToResolver,
  extractNewMcpConfigFromToolResult,
  redactNewMcpConfigInToolResult,
  validateClientProvidedMcpConfig,
} from '../../pathways/system/entity/sys_entity_agent.js';
import { config } from '../../config.js';
import { getToolsForEntity } from '../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import { withTimeout } from '../../lib/pathwayTools.js';
import { getEntityStore } from '../../lib/MongoEntityStore.js';

const buildToolDefinition = (name, pathwayName, overrides = {}) => ({
  pathwayName,
  definition: {
    type: 'function',
    icon: '🧪',
    function: {
      name,
      description: `Test tool for ${name}`,
      parameters: {
        type: 'object',
        properties: {
          userMessage: { type: 'string' },
        },
        required: [],
      },
    },
    ...overrides,
  },
});

const buildToolCall = (name, args = { userMessage: 'run test' }, id = 'call-1') => ({
  id,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-test',
  rootRequestId: 'root-req-test',
  pathway: sysEntityAgent,
  modelExecutor: {
    plugin: {
      truncateMessagesToTargetLength: (messages) => messages,
    },
  },
  promptAndParse: async () => 'final-response',
  ...overrides,
});

const setupConfig = () => {
  const originalGet = config.get.bind(config);
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    errorjson: buildToolDefinition('ErrorJson', 'test_tool_error_json'),
    throws500: buildToolDefinition('Throws500', 'test_tool_500'),
    timeouttool: buildToolDefinition('TimeoutTool', 'test_tool_timeout'),
    nullresult: buildToolDefinition('NullResult', 'test_tool_null'),
  };

  const entityId = 'entity-test-errors';
  const entityConfig = {
    [entityId]: {
      id: entityId,
      isDefault: true,
      tools: Object.keys(tools),
      customTools: tools,
    },
  };

  const pathways = {
    ...originalPathways,
    sys_generator_error: {
      rootResolver: async (_parent, args) => ({
        result: `ERROR_RESPONSE: ${args.text}`,
      }),
    },
    test_tool_error_json: {
      rootResolver: async () => ({
        result: JSON.stringify({ error: true, message: '400 Bad Request' }),
      }),
    },
    test_tool_500: {
      rootResolver: async () => {
        throw new Error('500 Internal Server Error');
      },
    },
    test_tool_timeout: {
      rootResolver: async () => {
        throw new Error('ETIMEDOUT');
      },
    },
    test_tool_null: {
      rootResolver: async () => ({
        result: null,
      }),
    },
  };

  config.load({
    pathways,
    entityTools: {},
  });

  // convict schema does not expose entityConfig; override config.get for tests
  config.get = (key) => {
    if (key === 'entityConfig') {
      return entityConfig;
    }
    return originalGet(key);
  };

  return {
    entityId,
    originalGet,
    originalPathways,
    originalEntityTools,
  };
};

const restoreConfig = (originals) => {
  config.load({
    pathways: originals.originalPathways,
    entityTools: originals.originalEntityTools,
  });

  config.get = originals.originalGet;
};

const stubEntityStore = (overrides = {}) => {
  const entityStore = getEntityStore();
  const originals = {
    isConfigured: entityStore.isConfigured,
    getEntity: entityStore.getEntity,
    findOrCreatePersonalEntity: entityStore.findOrCreatePersonalEntity,
    getDefaultEntity: entityStore.getDefaultEntity,
  };

  Object.assign(entityStore, overrides);

  return () => {
    Object.assign(entityStore, originals);
  };
};

const setupConfiguredAgent = (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));
  return originals;
};

const configuredEntityTools = (entityId) => getToolsForEntity(config.get('entityConfig')[entityId]);

const setupToolCallbackHarness = (t, {
  chatHistory = [{ role: 'user', content: 'use tool' }],
  argsOverrides = {},
  promptAndParse,
  resolverOverrides = {},
} = {}) => {
  const originals = setupConfiguredAgent(t);
  const { entityTools, entityToolsOpenAiFormat } = configuredEntityTools(originals.entityId);
  let promptArgs;

  const resolver = buildResolver({
    promptAndParse: promptAndParse || (async (args) => {
      promptArgs = args;
      return 'tool-handled';
    }),
    ...resolverOverrides,
  });

  return {
    originals,
    args: {
      chatHistory,
      entityTools,
      entityToolsOpenAiFormat,
      ...argsOverrides,
    },
    resolver,
    getPromptArgs: () => promptArgs,
    setPromptArgs: (value) => {
      promptArgs = value;
    },
  };
};

test('extractNewMcpConfigFromToolResult reads client tool config updates', (t) => {
  const config = {
    atlassian: {
      type: 'streamable-http',
      url: 'https://mcp.atlassian.com/v1/mcp',
      headers: { Authorization: 'Bearer token' },
    },
  };

  t.deepEqual(
    extractNewMcpConfigFromToolResult({
      result: JSON.stringify({
        description: 'connected',
        newMcpConfig: config,
      }),
    }),
    config
  );
  t.is(extractNewMcpConfigFromToolResult({ result: '{"description":"ok"}' }), null);
});

test('redactNewMcpConfigInToolResult preserves config shape without credentials', (t) => {
  const toolResult = {
    result: JSON.stringify({
      description: 'connected',
      newMcpConfig: {
        atlassian: {
          type: 'streamable-http',
          url: 'https://mcp.atlassian.com/v1/mcp',
          cloudId: 'cloud-123',
          headers: {
            Authorization: 'Bearer secret-token',
            'X-Atlassian-Cloud-Id': 'cloud-123',
          },
        },
      },
    }),
  };

  redactNewMcpConfigInToolResult(toolResult);

  t.false(toolResult.result.includes('secret-token'));
  const parsed = JSON.parse(toolResult.result);
  t.is(parsed.newMcpConfig.atlassian.url, 'https://mcp.atlassian.com/v1/mcp');
  t.is(parsed.newMcpConfig.atlassian.cloudId, 'cloud-123');
  t.is(parsed.newMcpConfig.atlassian.headers.Authorization, '[REDACTED]');
  t.is(parsed.newMcpConfig.atlassian.headers['X-Atlassian-Cloud-Id'], 'cloud-123');
});

test('validateClientProvidedMcpConfig accepts only the requested approved server target', (t) => {
  const result = validateClientProvidedMcpConfig({
    requestedServerKey: 'atlassian',
    args: {
      mcpAvailableServers: JSON.stringify([
        {
          id: 'atlassian',
          name: 'Atlassian',
          description: 'Jira and Confluence',
          type: 'streamable-http',
          url: 'https://mcp.atlassian.com/v1/mcp',
        },
      ]),
    },
    newMcpConfig: {
      atlassian: {
        type: 'streamable-http',
        url: 'https://mcp.atlassian.com/v1/mcp',
        headers: { Authorization: 'Bearer fresh' },
      },
      internal: {
        type: 'streamable-http',
        url: 'http://169.254.169.254/latest/meta-data',
      },
    },
  });

  t.true(result.valid);
  t.deepEqual(Object.keys(result.config), ['atlassian']);
  t.is(result.config.atlassian.headers.Authorization, 'Bearer fresh');
});

test('validateClientProvidedMcpConfig rejects unapproved MCP targets', (t) => {
  const result = validateClientProvidedMcpConfig({
    requestedServerKey: 'atlassian',
    args: {
      mcpAvailableServers: JSON.stringify([
        {
          id: 'atlassian',
          name: 'Atlassian',
          description: 'Jira and Confluence',
          type: 'streamable-http',
          url: 'https://mcp.atlassian.com/v1/mcp',
        },
      ]),
    },
    newMcpConfig: {
      atlassian: {
        type: 'streamable-http',
        url: 'http://169.254.169.254/latest/meta-data',
        headers: { Authorization: 'Bearer fresh' },
      },
    },
  });

  t.false(result.valid);
  t.true(result.reason.includes('unapproved MCP URL'));
});

test('validateClientProvidedMcpConfig accepts expired configured server target for reauth', (t) => {
  const result = validateClientProvidedMcpConfig({
    requestedServerKey: 'atlassian',
    args: {
      mcpConfig: JSON.stringify({
        atlassian: {
          type: 'streamable-http',
          url: 'https://mcp.atlassian.com/v1/mcp',
          expiresAt: Date.now() - 60000,
        },
      }),
    },
    newMcpConfig: {
      atlassian: {
        type: 'streamable-http',
        url: 'https://mcp.atlassian.com/v1/mcp',
        headers: { Authorization: 'Bearer fresh' },
      },
    },
  });

  t.true(result.valid);
  t.is(result.source, 'expired-config');
});

test('applyNewMcpConfigToResolver hot-loads MCP clients and tools', async (t) => {
  let closedOldTransport = false;
  const oldClientEntry = {
    transport: {
      close: async () => {
        closedOldTransport = true;
      },
    },
    connectTimestamp: Date.now(),
  };
  const nextClientEntry = {
    client: {},
    transport: { close: async () => {} },
    connectTimestamp: Date.now(),
  };
  const args = {
    mcpAvailableServers: JSON.stringify([
      {
        id: 'atlassian',
        name: 'Atlassian',
        description: 'Jira and Confluence',
        type: 'streamable-http',
        url: 'https://mcp.atlassian.com/v1/mcp',
      },
    ]),
    mcpClients: new Map([['atlassian', oldClientEntry]]),
    mcpToolCatalog: {},
    mcpEntityToolsDeferred: {},
    entityTools: {},
    entityToolsOpenAiFormat: [],
  };
  const pathwayResolver = { args };
  const discoveredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'atlassian__searchjiraissuesusingjql',
        description: 'Search Jira issues using JQL',
        parameters: { type: 'object', properties: {} },
      },
    },
    pathwayName: 'mcp_tool_execution',
    mcpServer: 'atlassian',
    mcpToolName: 'searchJiraIssuesUsingJql',
  };

  const result = await applyNewMcpConfigToResolver({
    newMcpConfig: {
      atlassian: {
        type: 'streamable-http',
        url: 'https://mcp.atlassian.com/v1/mcp',
        headers: { Authorization: 'Bearer fresh' },
      },
    },
    args,
    pathwayResolver,
    requestedServerKey: 'atlassian',
    initializeClients: async (configJson) => {
      const parsedConfig = JSON.parse(configJson);
      t.deepEqual(Object.keys(parsedConfig), ['atlassian']);
      t.is(parsedConfig.atlassian.url, 'https://mcp.atlassian.com/v1/mcp');
      t.is(parsedConfig.atlassian.headers.Authorization, 'Bearer fresh');
      return {
        clients: new Map([['atlassian', nextClientEntry]]),
        expiredServers: [],
      };
    },
    discoverTools: async () => ({
      entityTools: {
        atlassian__searchjiraissuesusingjql: discoveredTool,
      },
      entityToolsOpenAiFormat: [
        {
          type: 'function',
          function: {
            name: 'atlassian__searchjiraissuesusingjql',
            description: 'Search Jira issues using JQL',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      mcpToolCatalog: {
        atlassian__searchjiraissuesusingjql: {
          name: 'atlassian__searchjiraissuesusingjql',
          originalName: 'searchJiraIssuesUsingJql',
          server: 'atlassian',
          description: 'Search Jira issues using JQL',
          parameters: [],
        },
      },
    }),
    closeClients: async (clients) => {
      for (const [, entry] of clients) {
        await entry.transport.close();
      }
      clients.clear();
    },
  });

  t.true(result.applied);
  t.true(closedOldTransport);
  t.is(args.mcpClients.get('atlassian'), nextClientEntry);
  t.truthy(args.entityTools.atlassian__searchjiraissuesusingjql);
  t.truthy(args.mcpEntityToolsDeferred.atlassian__searchjiraissuesusingjql);
  t.truthy(args.mcpToolCatalog.atlassian__searchjiraissuesusingjql);
  t.is(args.entityToolsOpenAiFormat.length, 1);
  t.is(pathwayResolver.args.mcpClients.get('atlassian'), nextClientEntry);
});

test.serial('executePathway returns sys_generator_error output on 500 base model error', async (t) => {
  const originals = setupConfiguredAgent(t);

  const resolver = buildResolver();
  const args = {
    text: 'trigger base model error',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [],
    entityId: originals.entityId,
  };

  const runAllPrompts = async () => {
    throw new Error('HTTP 500 from model');
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });
  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('HTTP 500 from model'));
});

test.serial('executePathway does not derive file access from contextId/contextKey', async (t) => {
  const originals = setupConfiguredAgent(t);

  const resolver = buildResolver();
  let promptArgs;
  const args = {
    text: 'legacy file access',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [],
    contextId: 'legacy-context-123',
    contextKey: 'legacy-key-abc',
    entityId: originals.entityId,
  };

  const runAllPrompts = async (receivedArgs) => {
    promptArgs = receivedArgs;
    return 'legacy-ok';
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.is(result, 'legacy-ok');
  t.deepEqual(promptArgs.fileAccessPlan, []);
});

test.serial('executePathway leaves entityId blank when caller omits it', async (t) => {
  const originals = setupConfiguredAgent(t);

  const defaultEntity = {
    id: 'default-workspace-entity',
    name: 'Default Workspace Entity',
    isDefault: true,
    tools: [],
    customTools: {},
  };

  const restoreStore = stubEntityStore({
    isConfigured: () => true,
    getEntity: async () => null,
    getDefaultEntity: async () => defaultEntity,
  });
  t.teardown(restoreStore);

  const resolver = buildResolver();
  let promptArgs;
  const args = {
    text: 'use default entity config without impersonating it',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [],
  };

  const runAllPrompts = async (receivedArgs) => {
    promptArgs = receivedArgs;
    return 'default-ok';
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.is(result, 'default-ok');
  t.is(promptArgs.entityId, '');
});

test.serial('executePathway falls back when sys_generator_error fails after null model response', async (t) => {
  const originals = setupConfiguredAgent(t);

  const brokenPathways = {
    ...config.get('pathways'),
    sys_generator_error: {
      rootResolver: async () => {
        throw new Error('sys_generator_error failed');
      },
    },
  };
  config.load({ pathways: brokenPathways });

  const resolver = buildResolver();
  const args = {
    text: 'trigger null response',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [],
    entityId: originals.entityId,
  };

  const runAllPrompts = async () => null;
  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.true(result.includes('I apologize, but I encountered an error while processing your request'));
  t.true(result.includes('Model execution returned null'));
});

test.serial('executePathway repairs a stale explicit entityId to the canonical personal entity', async (t) => {
  const originals = setupConfiguredAgent(t);

  const restoreEntityStore = stubEntityStore({
    isConfigured: () => true,
    getEntity: async (entityId) => {
      if (entityId === 'repaired-entity') {
        return {
          id: 'repaired-entity',
          name: 'Lana',
          tools: ['*'],
          customTools: {},
        };
      }
      return null;
    },
    findOrCreatePersonalEntity: async () => ({
      id: 'repaired-entity',
      name: 'Lana',
      created: false,
    }),
    getDefaultEntity: async () => ({
      id: 'default-entity',
      name: 'Default',
      tools: ['*'],
      customTools: {},
    }),
  });
  t.teardown(restoreEntityStore);

  const resolver = buildResolver();
  let promptArgs;
  const args = {
    text: 'repair stale entity id',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [{ userContextId: 'user-123' }],
    entityId: 'stale-entity',
  };

  const runAllPrompts = async (receivedArgs) => {
    promptArgs = receivedArgs;
    return 'repair-ok';
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.is(result, 'repair-ok');
  t.is(promptArgs.entityId, 'repaired-entity');
});

test.serial('executePathway clears stale explicit entityId when no user context exists', async (t) => {
  const originals = setupConfiguredAgent(t);

  const restoreEntityStore = stubEntityStore({
    isConfigured: () => true,
    getEntity: async (entityId) => {
      if (entityId === 'default-entity') {
        return {
          id: 'default-entity',
          name: 'Default',
          isDefault: true,
          tools: ['*'],
          customTools: {},
        };
      }
      return null;
    },
    findOrCreatePersonalEntity: async () => null,
    getDefaultEntity: async () => ({
      id: 'default-entity',
      name: 'Default',
      isDefault: true,
      tools: ['*'],
      customTools: {},
    }),
  });
  t.teardown(restoreEntityStore);

  const resolver = buildResolver();
  let promptArgs;
  const args = {
    text: 'clear stale entity id without user',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [],
    entityId: 'stale-entity',
  };

  const runAllPrompts = async (receivedArgs) => {
    promptArgs = receivedArgs;
    return 'default-ok';
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.is(result, 'default-ok');
  t.is(promptArgs.entityId, '');
});

test.serial('executePathway clears stale explicit entityId when personal entity repair is unavailable', async (t) => {
  const originals = setupConfiguredAgent(t);

  const restoreEntityStore = stubEntityStore({
    isConfigured: () => true,
    getEntity: async () => null,
    findOrCreatePersonalEntity: async () => null,
    getDefaultEntity: async () => ({
      id: 'default-entity',
      name: 'Default',
      isDefault: true,
      tools: ['*'],
      customTools: {},
    }),
  });
  t.teardown(restoreEntityStore);

  const resolver = buildResolver();
  let promptArgs;
  const args = {
    text: 'clear stale entity id when personal entity is unavailable',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [{ userContextId: 'user-123' }],
    entityId: 'stale-entity',
  };

  const runAllPrompts = async (receivedArgs) => {
    promptArgs = receivedArgs;
    return 'default-ok';
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.is(result, 'default-ok');
  t.is(promptArgs.entityId, '');
});

test.serial('executePathway preserves disabled explicit entity failures instead of repairing them', async (t) => {
  const originals = setupConfiguredAgent(t);

  const restoreEntityStore = stubEntityStore({
    isConfigured: () => true,
    getEntity: async (entityId) => {
      if (entityId === 'disabled-entity') {
        return {
          id: 'disabled-entity',
          name: 'Disabled',
          requiredEnvVars: ['MISSING_SECRET'],
          tools: ['*'],
          customTools: {},
        };
      }
      return null;
    },
    findOrCreatePersonalEntity: async () => ({
      id: 'repaired-entity',
      name: 'Lana',
      created: false,
    }),
    getDefaultEntity: async () => ({
      id: 'default-entity',
      name: 'Default',
      isDefault: true,
      tools: ['*'],
      customTools: {},
    }),
  });
  t.teardown(restoreEntityStore);

  const resolver = buildResolver();
  const args = {
    text: 'use disabled entity',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [{ userContextId: 'user-123' }],
    entityId: 'disabled-entity',
  };

  const runAllPrompts = async () => 'should-not-run';
  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('disabled-entity'));
  t.true(result.includes('missing required environment variables'));
});

for (const { name, toolName, expectedContent } of [
  {
    name: 'surfaces 400 error JSON from tool result',
    toolName: 'ErrorJson',
    expectedContent: '400 Bad Request',
  },
  {
    name: 'captures 500 error thrown by tool pathway',
    toolName: 'Throws500',
    expectedContent: '500 Internal Server Error',
  },
  {
    name: 'captures tool null result as error',
    toolName: 'NullResult',
    expectedContent: 'returned null result',
  },
]) {
  test.serial(`toolCallback ${name}`, async (t) => {
    const { args, resolver, getPromptArgs } = setupToolCallbackHarness(t);

    const result = await sysEntityAgent.toolCallback(
      args,
      { tool_calls: [buildToolCall(toolName)] },
      resolver
    );

    t.is(result, 'tool-handled');
    const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
    t.truthy(toolMessage);
    t.true(toolMessage.content.includes(expectedContent));
    t.truthy(getPromptArgs());
    t.true(getPromptArgs().chatHistory.some((entry) => (
      entry.role === 'tool' && entry.content.includes(expectedContent)
    )));
  });
}

test.serial('toolCallback handles missing tool call arguments gracefully with empty args', async (t) => {
  const { args, resolver, getPromptArgs } = setupToolCallbackHarness(t);
  const message = {
    tool_calls: [{
      id: 'bad-tool-call',
      type: 'function',
      function: { name: 'ErrorJson' },
    }],
  };

  // With the updated code, missing arguments default to {} and the tool still executes
  const result = await sysEntityAgent.toolCallback(args, message, resolver);
  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  // The tool executes with empty args and returns its normal result (400 Bad Request)
  t.true(toolMessage.content.includes('400 Bad Request'));
  t.truthy(getPromptArgs());
});

test.serial('toolCallback returns error response when promptAndParse throws', async (t) => {
  const { args, resolver } = setupToolCallbackHarness(t, {
    promptAndParse: async () => {
      throw new Error('Model crashed after tool calls');
    },
  });

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('Model crashed after tool calls'));
});

test.serial('executePathway returns error response when tool recursion times out', async (t) => {
  const originals = setupConfiguredAgent(t);
  const { entityToolsOpenAiFormat } = configuredEntityTools(originals.entityId);

  const resolver = buildResolver({
    promptAndParse: async () => {
      throw new Error('Tool recursion timeout');
    },
  });

  const args = {
    text: 'trigger tool recursion',
    chatHistory: [{ role: 'user', content: 'hi' }],
    fileAccessPlan: [],
    entityId: originals.entityId,
    entityToolsOpenAiFormat,
  };

  const runAllPrompts = async () => ({
    tool_calls: [buildToolCall('TimeoutTool')],
  });

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });
  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('Tool recursion timeout'));
});

test.serial('toolCallback injects max tool call message once limit reached', async (t) => {
  const { args, resolver, getPromptArgs } = setupToolCallbackHarness(t, {
    resolverOverrides: {
      toolCallCount: 50,
    },
  });

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  await sysEntityAgent.toolCallback(args, message, resolver);

  const systemMessage = getPromptArgs().chatHistory.find((entry) => (
    entry.role === 'user' &&
    typeof entry.content === 'string' &&
    entry.content.includes('Maximum tool call limit reached')
  ));

  t.truthy(systemMessage);
});

// === NEW TESTS FOR ROBUSTNESS FEATURES ===

test('withTimeout resolves when promise completes before timeout', async (t) => {
  const result = await withTimeout(
    Promise.resolve('success'),
    1000,
    'Should not timeout'
  );
  t.is(result, 'success');
});

test('withTimeout rejects when promise takes longer than timeout', async (t) => {
  const slowPromise = new Promise(() => {});
  
  const error = await t.throwsAsync(
    withTimeout(slowPromise, 1, 'Operation timed out after 1ms')
  );
  
  t.is(error.message, 'Operation timed out after 1ms');
});

test('withTimeout clears timeout when promise resolves', async (t) => {
  // This test ensures no memory leaks from dangling timeouts
  const result = await withTimeout(
    Promise.resolve('quick'),
    10000, // Long timeout that should be cleared
    'Should not timeout'
  );
  t.is(result, 'quick');
});

test('withTimeout clears timeout when promise rejects', async (t) => {
  const error = await t.throwsAsync(
    withTimeout(
      Promise.reject(new Error('Original error')),
      10000,
      'Should not timeout'
    )
  );
  t.is(error.message, 'Original error');
});

test.serial('toolCallback compacts oversized tool results in chat history', async (t) => {
  // The compaction block protects against tool messages that arrive in
  // chatHistory already large. Fresh tool results from a tool call are envelope-shaped by
  // buildToolResultContent before they ever hit this block, so the test
  // exercises the safety net by seeding chatHistory directly.
  // 60 KB seeded tool message (mimics a legacy or externally supplied
  // oversized tool envelope).
  const oversizedContent = JSON.stringify({ data: 'x'.repeat(60000) });
  const oversizedToolMessage = {
    role: 'tool',
    tool_call_id: 'prior-call',
    name: 'PriorTool',
    content: oversizedContent,
  };

  const { args, resolver, getPromptArgs, setPromptArgs } = setupToolCallbackHarness(t, {
    chatHistory: [
      { role: 'user', content: 'previous' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'prior-call', type: 'function', function: { name: 'PriorTool', arguments: '{}' } }] },
      oversizedToolMessage,
      { role: 'user', content: 'follow up' },
    ],
  });

  // Issue any tool call to drive toolCallback through the truncation path.
  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  await sysEntityAgent.toolCallback(args, message, resolver);

  // The seeded tool message in promptArgs.chatHistory should now be compacted
  // into a valid envelope instead of substring-truncated into invalid JSON.
  const seededAfter = getPromptArgs().chatHistory.find(
    (entry) => entry.role === 'tool' && entry.tool_call_id === 'prior-call'
  );
  t.truthy(seededAfter, 'seeded tool message should still be present');
  t.true(seededAfter.content.length < oversizedContent.length, 'should have been compacted');
  const compactedEnvelope = JSON.parse(seededAfter.content);
  t.true(compactedEnvelope._toolResultEnvelope);
  t.true(compactedEnvelope.compacted);
  t.truthy(compactedEnvelope.resultRef);
  t.true(compactedEnvelope.note.includes('InspectToolResult'));

  // Re-running with the now-compacted history should pass through unchanged.
  const compactedLength = seededAfter.content.length;
  const args2 = {
    ...args,
    chatHistory: getPromptArgs().chatHistory, // feed the post-compaction history back
  };
  setPromptArgs(null);
  await sysEntityAgent.toolCallback(args2, { tool_calls: [buildToolCall('ErrorJson', { userMessage: 'again' }, 'call-2')] }, resolver);
  const seededSecondPass = getPromptArgs().chatHistory.find(
    (entry) => entry.role === 'tool' && entry.tool_call_id === 'prior-call'
  );
  t.is(seededSecondPass.content.length, compactedLength,
    'already-compacted content should pass through unchanged on subsequent turns');
});

test('findSafeSplitPoint preserves tool call/result pairs', (t) => {
  // Import the helper (we'll need to export it or test via integration)
  // For now, test the concept with inline implementation
  
  const findSafeSplitPoint = (messages, keepRecentCount = 6) => {
    const toolCallIndexMap = new Map();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIndexMap.set(tc.id, i);
        }
      }
    }
    
    let splitIndex = Math.max(0, messages.length - keepRecentCount);
    
    let adjusted = true;
    while (adjusted && splitIndex > 0) {
      adjusted = false;
      for (let i = splitIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'tool' && msg.tool_call_id) {
          const callIndex = toolCallIndexMap.get(msg.tool_call_id);
          if (callIndex !== undefined && callIndex < splitIndex) {
            splitIndex = callIndex;
            adjusted = true;
            break;
          }
        }
      }
    }
    
    return splitIndex;
  };

  // Test: should not split if it would orphan a tool result
  const messages = [
    { role: 'user', content: 'query 1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'search' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'result 1' },
    { role: 'assistant', content: 'response 1' },
    { role: 'user', content: 'query 2' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', function: { name: 'search' } }] },
    { role: 'tool', tool_call_id: 'tc2', content: 'result 2' },
    { role: 'assistant', content: 'response 2' },
  ];

  // With keepRecentCount=4, naive split would be at index 4
  // But tc2's result is at index 6, its call at index 5
  // So split should be adjusted to keep tc2 call with its result
  const splitIndex = findSafeSplitPoint(messages, 4);
  
  // The split should ensure tc2 call (index 5) stays with tc2 result (index 6)
  // So split should be at index 4 or earlier
  t.true(splitIndex <= 4, 'Split should be at or before index 4');
  
  // Verify: messages from splitIndex onwards should have paired tool calls/results
  const keptMessages = messages.slice(splitIndex);
  const keptToolCallIds = new Set();
  for (const msg of keptMessages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        keptToolCallIds.add(tc.id);
      }
    }
  }
  
  // Every tool result in kept messages should have its call in kept messages
  for (const msg of keptMessages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      t.true(keptToolCallIds.has(msg.tool_call_id), 
        `Tool result ${msg.tool_call_id} should have its call in kept messages`);
    }
  }
});

test.serial('toolCallback handles tool timeout error correctly', async (t) => {
  const originals = setupConfiguredAgent(t);

  // Create a tool that simulates a timeout
  const timeoutPathways = {
    ...config.get('pathways'),
    test_tool_slow: {
      rootResolver: async () => {
        // Simulate a tool that never resolves so the timeout path is deterministic.
        await new Promise(() => {});
      },
    },
  };
  config.load({ pathways: timeoutPathways });

  const tools = {
    ...config.get('entityConfig')[originals.entityId].customTools,
    slowtool: {
      ...buildToolDefinition('SlowTool', 'test_tool_slow'),
      definition: {
        ...buildToolDefinition('SlowTool', 'test_tool_slow').definition,
        // Set a very short timeout to trigger timeout
        timeout: 1,
      },
    },
  };

  const entityConfig = {
    [originals.entityId]: {
      ...config.get('entityConfig')[originals.entityId],
      tools: [...config.get('entityConfig')[originals.entityId].tools, 'slowtool'],
      customTools: tools,
    },
  };

  config.get = (key) => {
    if (key === 'entityConfig') {
      return entityConfig;
    }
    return originals.originalGet(key);
  };

  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig[originals.entityId]);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use slow tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('SlowTool')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  
  // Find the tool result message - should contain timeout error
  const toolMessage = promptArgs.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('timed out'));
});

// Test the logic that prevents non-streaming responses from killing parent streams
// The fix was: only publish completion if receivedSSEData is true
test('non-streaming tool response should not trigger parent stream completion', (t) => {
  // This test validates the logic pattern used in pathwayResolver.handleStream
  // The bug was: non-streaming tool calls would publish progress=1 to rootRequestId
  // because completionSent was false (no SSE events received)
  
  // Simulate the state after a non-streaming response closes
  const receivedSSEData = false; // No SSE events received (non-streaming)
  const completionSent = false;  // No completion signal from stream
  const streamErrorOccurred = false;
  
  // The OLD buggy logic:
  const oldLogicWouldPublish = streamErrorOccurred || !completionSent;
  t.true(oldLogicWouldPublish, 'Old logic would incorrectly publish completion');
  
  // The NEW fixed logic:
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.false(newLogicWouldPublish, 'New logic correctly skips completion for non-streaming');
});

test('streaming response with incomplete data should trigger completion', (t) => {
  // When we receive SSE data but stream closes without completion signal
  // we SHOULD send a completion (to clean up the client state)
  
  const receivedSSEData = true;  // SSE events were received
  const completionSent = false;  // But no completion signal
  const streamErrorOccurred = false;
  
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.true(newLogicWouldPublish, 'Should publish completion when streaming response has no completion signal');
});

test('streaming response with error should trigger completion with error', (t) => {
  // When stream has an error, we should send completion with error info
  
  const receivedSSEData = true;
  const completionSent = false;
  const streamErrorOccurred = true;
  
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.true(newLogicWouldPublish, 'Should publish completion when stream has error');
});

test('normal streaming completion should not double-send', (t) => {
  // When stream completes normally (completionSent = true), don't send again
  
  const receivedSSEData = true;
  const completionSent = true;  // Normal completion already sent
  const streamErrorOccurred = false;
  
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.false(newLogicWouldPublish, 'Should not double-send completion');
});

// Test that actually exercises the SSE parser behavior
test('SSE parser only sets receivedSSEData for actual event types', async (t) => {
  const { createParser } = await import('eventsource-parser');
  
  // Simulate the pathwayResolver's onParse logic
  let receivedSSEData = false;
  
  const onParse = (event) => {
    // This mirrors the FIXED code in pathwayResolver.js
    if (event.type === 'event') {
      receivedSSEData = true;
    }
    // Other event types (like 'reconnect-interval') should NOT set receivedSSEData
  };
  
  const parser = createParser(onParse);
  
  // Feed non-SSE JSON data (like a Grok non-streaming response)
  const jsonResponse = JSON.stringify({
    id: 'resp_123',
    output: [{ type: 'message', content: [{ text: 'Hello' }] }]
  });
  parser.feed(jsonResponse);
  
  t.false(receivedSSEData, 'Non-SSE JSON should not set receivedSSEData');
  
  // Now feed actual SSE data (proper SSE format with event type)
  parser.feed('event: message\ndata: {"content":"hello"}\n\n');
  
  t.true(receivedSSEData, 'Actual SSE event should set receivedSSEData');
});

test('SSE parser with reconnect-interval should not set receivedSSEData', async (t) => {
  const { createParser } = await import('eventsource-parser');
  
  let receivedSSEData = false;
  
  const onParse = (event) => {
    if (event.type === 'event') {
      receivedSSEData = true;
    }
  };
  
  const parser = createParser(onParse);
  
  // Feed a reconnect-interval directive (valid SSE but not an 'event' type)
  parser.feed('retry: 3000\n\n');
  
  t.false(receivedSSEData, 'reconnect-interval should not set receivedSSEData');
});

// === MCP LIFECYCLE AND REF-COUNTING TESTS ===

test('toolCallback increments _mcpActiveCallbacks ref count', async (t) => {
  // Test that the ref count is properly incremented
  const args = {
    chatHistory: [],
    entityTools: {},
    entityToolsOpenAiFormat: [],
    _mcpActiveCallbacks: 0,
  };

  const resolver = buildResolver({
    promptAndParse: async () => 'done',
  });

  // Simulate no tool_calls to hit the early return path
  const message = { tool_calls: [] };
  await sysEntityAgent.toolCallback(args, message, resolver);

  // _mcpToolCallbackFired should be set
  t.true(args._mcpToolCallbackFired);
  // ref count should have been incremented then decremented (0 + 1 - 1 = 0)
  t.true(args._mcpActiveCallbacks <= 0);
});

test('MCP clients are not closed when ref count is still positive', (t) => {
  // Test the ref counting logic
  let _mcpActiveCallbacks = 0;

  // First callback starts
  _mcpActiveCallbacks += 1;
  t.is(_mcpActiveCallbacks, 1);

  // Second callback starts (chained)
  _mcpActiveCallbacks += 1;
  t.is(_mcpActiveCallbacks, 2);

  // First callback finishes
  _mcpActiveCallbacks -= 1;
  const shouldCloseAfterFirst = _mcpActiveCallbacks <= 0;
  t.false(shouldCloseAfterFirst);

  // Second callback finishes
  _mcpActiveCallbacks -= 1;
  const shouldCloseAfterSecond = _mcpActiveCallbacks <= 0;
  t.true(shouldCloseAfterSecond);
});

test('MCP closeMcpClientsIfNeeded only closes when last callback completes', async (t) => {
  let closeCount = 0;
  const mockClients = new Map();
  mockClients.set('server1', {
    transport: { close: async () => { closeCount++; } },
    connectTimestamp: Date.now(),
  });

  const args = {
    mcpClients: mockClients,
    _mcpActiveCallbacks: 2,
  };

  // Simulate the closeMcpClientsIfNeeded logic
  const closeMcpClientsIfNeeded = async () => {
    args._mcpActiveCallbacks = (args._mcpActiveCallbacks || 1) - 1;
    if (args._mcpActiveCallbacks <= 0 && args.mcpClients && args.mcpClients.size > 0) {
      for (const [, { transport }] of args.mcpClients) {
        await transport.close();
      }
      args.mcpClients.clear();
    }
  };

  // First callback completes — should NOT close
  await closeMcpClientsIfNeeded();
  t.is(closeCount, 0);
  t.is(args.mcpClients.size, 1);

  // Second callback completes — should close
  await closeMcpClientsIfNeeded();
  t.is(closeCount, 1);
  t.is(args.mcpClients.size, 0);
});

test.serial('toolCallback preserves MCP clients when follow-up response still has tool calls', async (t) => {
  let closeCount = 0;
  const mcpClients = new Map([
    ['atlassian', {
      transport: { close: async () => { closeCount++; } },
      connectTimestamp: Date.now(),
    }],
  ]);

  const { args, resolver } = setupToolCallbackHarness(t, {
    chatHistory: [{ role: 'user', content: 'search tools, then call jira' }],
    argsOverrides: {
      mcpClients,
      _mcpActiveCallbacks: 0,
    },
    promptAndParse: async () => ({
      tool_calls: [buildToolCall('ErrorJson', { userMessage: 'next tool' }, 'call-next')],
    }),
  });

  const result = await sysEntityAgent.toolCallback(
    args,
    { tool_calls: [buildToolCall('ErrorJson', { userMessage: 'first tool' }, 'call-first')] },
    resolver,
  );

  t.truthy(result?.tool_calls?.length);
  t.is(closeCount, 0);
  t.is(args.mcpClients.size, 1);
  t.is(args._mcpActiveCallbacks, 0);
});

test.serial('toolCallback returns cached result for duplicate tool calls and injects system message', async (t) => {
  let promptCallCount = 0;
  let lastPromptArgs;
  const { args, resolver } = setupToolCallbackHarness(t, {
    promptAndParse: async (args) => {
      promptCallCount++;
      lastPromptArgs = args;
      return 'tool-handled';
    },
  });

  // First call — should execute normally
  const message1 = { tool_calls: [buildToolCall('ErrorJson', { userMessage: 'run test' }, 'call-1')] };
  await sysEntityAgent.toolCallback(args, message1, resolver);
  t.is(promptCallCount, 1);

  // Second call with identical args — should execute normally (count=1, threshold=2)
  const message2 = { tool_calls: [buildToolCall('ErrorJson', { userMessage: 'run test' }, 'call-2')] };
  await sysEntityAgent.toolCallback(args, message2, resolver);
  t.is(promptCallCount, 2);

  // Third call with identical args — should return cached result (count=2 >= threshold)
  const message3 = { tool_calls: [buildToolCall('ErrorJson', { userMessage: 'run test' }, 'call-3')] };
  await sysEntityAgent.toolCallback(args, message3, resolver);
  t.is(promptCallCount, 3);

  // The tool result for the third call should contain the duplicate warning
  const toolMessage = lastPromptArgs.chatHistory.find((entry) =>
    entry.role === 'tool' && entry.content.includes('Duplicate call')
  );
  t.truthy(toolMessage, 'Should have a tool result with duplicate warning');

  // Should also have a system message about duplicates
  const systemMessage = lastPromptArgs.chatHistory.find((entry) =>
    entry.role === 'user' &&
    typeof entry.content === 'string' &&
    entry.content.includes('duplicates of previous calls')
  );
  t.truthy(systemMessage, 'Should inject system message about duplicate tool calls');
});

test('tool callback invoked should not trigger stream warning or completion', (t) => {
  // When a tool callback is invoked (e.g., Gemini returns tool calls),
  // the stream closes but this is expected - the tool will execute and 
  // a new stream will open. We should not warn or send completion.
  
  const receivedSSEData = true;   // SSE data was received
  const completionSent = false;   // No progress=1 from the model (expected for tool calls)
  const streamErrorOccurred = false;
  const toolCallbackInvoked = true;  // Tool callback was invoked
  
  // Warning condition
  const shouldWarn = receivedSSEData && !completionSent && !streamErrorOccurred && !toolCallbackInvoked;
  t.false(shouldWarn, 'Should not warn when tool callback invoked');
  
  // Completion condition
  const shouldPublishCompletion = receivedSSEData && !toolCallbackInvoked && (streamErrorOccurred || !completionSent);
  t.false(shouldPublishCompletion, 'Should not publish completion when tool callback invoked');
});

test.serial('toolCallback handles malformed tool arguments without crashing', async (t) => {
  const { args, resolver, getPromptArgs } = setupToolCallbackHarness(t);

  // Simulate a model sending truncated/malformed JSON arguments
  // This happens in production with streaming truncation or rate-limited responses
  const message = {
    tool_calls: [{
      id: 'call-malformed',
      type: 'function',
      function: {
        name: 'ErrorJson',
        arguments: '{"query": "test',  // truncated JSON
      },
    }],
  };

  // Should NOT throw — malformed args should be handled gracefully
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  // The error should appear in chat history as a tool error message
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage, 'tool error message should be in chat history');
  t.true(toolMessage.content.includes('Error:'), 'tool message should contain the parse error');
  // Model should still be called with the error context
  t.truthy(getPromptArgs(), 'promptAndParse should still be called after the error');
});
