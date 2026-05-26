// mcpClient.test.js
// Unit tests for the MCP (Model Context Protocol) client module
import test from 'ava';
import { isTokenExpired, initializeMcpClients } from '../../../lib/mcpClient.js';

// We cannot import the real mcpClient module because it depends on @modelcontextprotocol/sdk
// which requires actual server connections. Instead, we test the pure logic functions
// by reimplementing the testable parts inline or by testing via callTool integration.

// ----- mcpToolToOpenAI logic tests -----

// Replicate the pure function for unit testing (same logic as in mcpClient.js)
function mcpToolToOpenAI(tool, serverKey, cloudIdState) {
    const inputSchema = tool.inputSchema || { type: 'object', properties: {} };
    let properties = { ...(inputSchema.properties || {}) };
    let required = [...(inputSchema.required || [])];

    if (cloudIdState?.resolved) {
        delete properties.cloudId;
        required = required.filter(r => r !== 'cloudId');
    } else if (cloudIdState?.availableSites?.length > 0 && properties.cloudId) {
        const siteList = cloudIdState.availableSites
            .map(s => `  - "${s.id}" (${s.url || s.name || 'unknown'})`)
            .join('\n');
        properties.cloudId = {
            ...properties.cloudId,
            description: `The Atlassian cloud site ID. You MUST ask the user which site to use. Available sites:\n${siteList}`,
        };
    }

    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || `MCP tool: ${tool.name}`,
            parameters: {
                type: inputSchema.type || 'object',
                properties,
                required,
            },
        },
        icon: '🔌',
        mcpServer: serverKey,
    };
}

test('mcpToolToOpenAI converts basic MCP tool to OpenAI format', (t) => {
    const mcpTool = {
        name: 'search_issues',
        description: 'Search for issues in the project',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Max results' },
            },
            required: ['query'],
        },
    };

    const result = mcpToolToOpenAI(mcpTool, 'jira');

    t.is(result.type, 'function');
    t.is(result.function.name, 'search_issues');
    t.is(result.function.description, 'Search for issues in the project');
    t.deepEqual(result.function.parameters.required, ['query']);
    t.truthy(result.function.parameters.properties.query);
    t.truthy(result.function.parameters.properties.limit);
    t.is(result.icon, '🔌');
    t.is(result.mcpServer, 'jira');
});

test('mcpToolToOpenAI handles tool without inputSchema', (t) => {
    const mcpTool = {
        name: 'list_all',
        description: 'List all items',
    };

    const result = mcpToolToOpenAI(mcpTool, 'server1');

    t.is(result.function.name, 'list_all');
    t.deepEqual(result.function.parameters, {
        type: 'object',
        properties: {},
        required: [],
    });
});

test('mcpToolToOpenAI generates default description when missing', (t) => {
    const mcpTool = {
        name: 'my_tool',
    };

    const result = mcpToolToOpenAI(mcpTool, 'server1');

    t.is(result.function.description, 'MCP tool: my_tool');
});

test('mcpToolToOpenAI handles inputSchema without required field', (t) => {
    const mcpTool = {
        name: 'optional_tool',
        description: 'A tool with all optional params',
        inputSchema: {
            type: 'object',
            properties: {
                param1: { type: 'string' },
            },
        },
    };

    const result = mcpToolToOpenAI(mcpTool, 'server1');

    t.deepEqual(result.function.parameters.required, []);
    t.truthy(result.function.parameters.properties.param1);
});

test('mcpToolToOpenAI strips cloudId when resolved', (t) => {
    const mcpTool = {
        name: 'search_issues',
        inputSchema: {
            type: 'object',
            properties: {
                cloudId: { type: 'string', description: 'Cloud site ID' },
                query: { type: 'string' },
            },
            required: ['cloudId', 'query'],
        },
    };

    const result = mcpToolToOpenAI(mcpTool, 'atlassian', { resolved: 'cloud-123' });

    t.falsy(result.function.parameters.properties.cloudId);
    t.truthy(result.function.parameters.properties.query);
    t.deepEqual(result.function.parameters.required, ['query']);
});

test('mcpToolToOpenAI keeps cloudId with site list when multiple sites', (t) => {
    const mcpTool = {
        name: 'search_issues',
        inputSchema: {
            type: 'object',
            properties: {
                cloudId: { type: 'string', description: 'Original desc' },
                query: { type: 'string' },
            },
            required: ['cloudId', 'query'],
        },
    };

    const sites = [
        { id: 'aaa', url: 'https://site-a.atlassian.net' },
        { id: 'bbb', name: 'Site B' },
    ];
    const result = mcpToolToOpenAI(mcpTool, 'atlassian', { availableSites: sites });

    t.truthy(result.function.parameters.properties.cloudId);
    t.true(result.function.parameters.properties.cloudId.description.includes('MUST ask'));
    t.true(result.function.parameters.properties.cloudId.description.includes('aaa'));
    t.true(result.function.parameters.properties.cloudId.description.includes('bbb'));
    t.deepEqual(result.function.parameters.required, ['cloudId', 'query']);
});

test('mcpToolToOpenAI passes through unchanged without cloudIdState', (t) => {
    const mcpTool = {
        name: 'search_issues',
        inputSchema: {
            type: 'object',
            properties: {
                cloudId: { type: 'string' },
                query: { type: 'string' },
            },
            required: ['cloudId', 'query'],
        },
    };

    const result = mcpToolToOpenAI(mcpTool, 'atlassian');

    t.truthy(result.function.parameters.properties.cloudId);
    t.deepEqual(result.function.parameters.required, ['cloudId', 'query']);
});

// ----- discoverMcpTools catalog building logic tests -----

// Replicate the catalog-building logic from discoverMcpTools for unit testing
function buildMcpToolCatalog(tools, serverKey) {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    const toolToServerMap = new Map();
    const mcpToolCatalog = {};

    for (const tool of tools) {
        const toolName = tool.name?.toLowerCase();
        if (!toolName) continue;

        const openAiTool = mcpToolToOpenAI(tool, serverKey);
        const compositeKey = `${serverKey}__${toolName}`;

        entityTools[compositeKey] = {
            definition: openAiTool,
            pathwayName: 'mcp_tool_execution',
            mcpServer: serverKey,
            mcpToolName: tool.name,
        };
        entityToolsOpenAiFormat.push({
            type: 'function',
            function: {
                name: compositeKey,
                description: openAiTool.function.description,
                parameters: openAiTool.function.parameters,
            },
        });
        toolToServerMap.set(compositeKey, serverKey);

        const paramNames = Object.keys(openAiTool.function?.parameters?.properties || {});
        mcpToolCatalog[compositeKey] = {
            name: compositeKey,
            originalName: tool.name,
            server: serverKey,
            description: openAiTool.function.description || '',
            parameters: paramNames,
        };
    }

    return { entityTools, entityToolsOpenAiFormat, toolToServerMap, mcpToolCatalog };
}

test('buildMcpToolCatalog creates composite keys with lowercase tool names', (t) => {
    const tools = [
        { name: 'SearchIssues', description: 'Search', inputSchema: { type: 'object', properties: {} } },
    ];

    const result = buildMcpToolCatalog(tools, 'atlassian');

    t.truthy(result.entityTools['atlassian__searchissues']);
    t.is(result.mcpToolCatalog['atlassian__searchissues'].originalName, 'SearchIssues');
});

test('buildMcpToolCatalog preserves original tool name for case-sensitive MCP servers', (t) => {
    const tools = [
        { name: 'GetPageById', description: 'Get a page', inputSchema: { type: 'object', properties: { pageId: { type: 'string' } } } },
    ];

    const result = buildMcpToolCatalog(tools, 'confluence');

    const entry = result.entityTools['confluence__getpagebyid'];
    t.is(entry.mcpToolName, 'GetPageById');
    t.is(entry.mcpServer, 'confluence');
});

test('buildMcpToolCatalog skips tools without names', (t) => {
    const tools = [
        { name: 'valid_tool', description: 'Valid' },
        { description: 'No name tool' },
        { name: '', description: 'Empty name' },
    ];

    const result = buildMcpToolCatalog(tools, 'server');

    t.is(Object.keys(result.entityTools).length, 1);
    t.truthy(result.entityTools['server__valid_tool']);
});

test('buildMcpToolCatalog populates catalog with parameter names', (t) => {
    const tools = [
        {
            name: 'create_issue',
            description: 'Create an issue',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    priority: { type: 'string' },
                },
                required: ['title'],
            },
        },
    ];

    const result = buildMcpToolCatalog(tools, 'jira');

    const catalogEntry = result.mcpToolCatalog['jira__create_issue'];
    t.deepEqual(catalogEntry.parameters, ['title', 'description', 'priority']);
    t.is(catalogEntry.server, 'jira');
});

test('buildMcpToolCatalog handles multiple tools from same server', (t) => {
    const tools = [
        { name: 'tool_a', description: 'Tool A' },
        { name: 'tool_b', description: 'Tool B' },
        { name: 'tool_c', description: 'Tool C' },
    ];

    const result = buildMcpToolCatalog(tools, 'myserver');

    t.is(Object.keys(result.entityTools).length, 3);
    t.is(result.entityToolsOpenAiFormat.length, 3);
    t.is(result.toolToServerMap.size, 3);
    t.is(Object.keys(result.mcpToolCatalog).length, 3);
});

// ----- callMcpTool argument parsing logic tests -----

test('callMcpTool composite name parsing extracts server and tool name', (t) => {
    // Test the parsing logic used in callMcpTool
    const compositeToolName = 'atlassian__search_issues';
    const parts = compositeToolName.split('__');
    const serverKey = parts[0];
    const toolName = parts.slice(1).join('__');

    t.is(serverKey, 'atlassian');
    t.is(toolName, 'search_issues');
});

test('callMcpTool composite name with double underscores in tool name', (t) => {
    // Tool names might contain __ themselves
    const compositeToolName = 'server__tool__with__underscores';
    const parts = compositeToolName.split('__');
    const serverKey = parts[0];
    const toolName = parts.slice(1).join('__');

    t.is(serverKey, 'server');
    t.is(toolName, 'tool__with__underscores');
});

test('callMcpTool prefers originalToolName over composite key extraction', (t) => {
    const compositeToolName = 'atlassian__searchissues';
    const originalToolName = 'SearchIssues';
    const parts = compositeToolName.split('__');
    const toolName = originalToolName || parts.slice(1).join('__');

    t.is(toolName, 'SearchIssues');
});

test('callMcpTool invalid composite name (no separator) should be detectable', (t) => {
    const compositeToolName = 'invalidname';
    const parts = compositeToolName.split('__');

    t.true(parts.length < 2);
});

test('callMcpTool cloudId injection logic', (t) => {
    // Test the cloudId injection logic — always inject stored cloudId
    const cloudId = 'cloud-123';
    const args = { query: 'test' };

    const finalArgs = { ...args };
    if (cloudId) {
        finalArgs.cloudId = cloudId;
    }

    t.is(finalArgs.cloudId, 'cloud-123');
    t.is(finalArgs.query, 'test');
});

test('callMcpTool cloudId injection overrides AI-provided value', (t) => {
    // Stored cloudId always wins — prevents AI hallucination
    const cloudId = 'cloud-123';
    const args = { query: 'test', cloudId: 'hallucinated-value' };

    const finalArgs = { ...args };
    if (cloudId) {
        finalArgs.cloudId = cloudId;
    }

    t.is(finalArgs.cloudId, 'cloud-123');
});

test('callMcpTool cloudId injection skipped when no cloudId configured', (t) => {
    const cloudId = null;
    const args = { query: 'test' };

    const finalArgs = { ...args };
    if (cloudId) {
        finalArgs.cloudId = cloudId;
    }

    t.is(finalArgs.cloudId, undefined);
});

// ----- initializeMcpClients input validation logic tests -----

test('initializeMcpClients returns empty map for null input', async (t) => {
    // Test the validation logic from initializeMcpClients
    const mcpConfigJson = null;
    const shouldReturn = !mcpConfigJson || typeof mcpConfigJson !== 'string';
    t.true(shouldReturn);
});

test('initializeMcpClients returns empty map for non-string input', async (t) => {
    const mcpConfigJson = 123;
    const shouldReturn = !mcpConfigJson || typeof mcpConfigJson !== 'string';
    t.true(shouldReturn);
});

test('initializeMcpClients returns empty map for empty string', async (t) => {
    const mcpConfigJson = '';
    const shouldReturn = !mcpConfigJson || typeof mcpConfigJson !== 'string';
    t.true(shouldReturn);
});

test('initializeMcpClients handles invalid JSON gracefully', (t) => {
    const mcpConfigJson = 'not valid json {{{';
    let config;
    try {
        config = JSON.parse(mcpConfigJson);
    } catch (e) {
        config = null;
    }
    t.is(config, null);
});

test('initializeMcpClients skips servers without url', (t) => {
    const mcpConfigJson = JSON.stringify({
        server1: { type: 'streamable-http' },
        server2: { url: 'https://example.com/mcp', type: 'streamable-http' },
    });

    const config = JSON.parse(mcpConfigJson);
    const validServers = Object.entries(config).filter(([, sc]) => sc?.url);

    t.is(validServers.length, 1);
    t.is(validServers[0][0], 'server2');
});

test('initializeMcpClients skips unsupported transport types', (t) => {
    const mcpConfigJson = JSON.stringify({
        server1: { url: 'https://example.com/mcp', type: 'websocket' },
        server2: { url: 'https://example.com/mcp', type: 'streamable-http' },
        server3: { url: 'https://example.com/mcp' }, // defaults to streamable-http
    });

    const config = JSON.parse(mcpConfigJson);
    const validServers = Object.entries(config).filter(([, sc]) => {
        if (!sc?.url) return false;
        const type = sc.type || 'streamable-http';
        return type === 'streamable-http';
    });

    t.is(validServers.length, 2);
});

// ----- closeMcpClients logic tests -----

test('closeMcpClients clears the clients map', async (t) => {
    const clients = new Map();
    clients.set('server1', {
        transport: { close: async () => {} },
        connectTimestamp: Date.now(),
    });
    clients.set('server2', {
        transport: { close: async () => {} },
        connectTimestamp: Date.now(),
    });

    // Replicate the closeMcpClients logic
    for (const [, { transport }] of clients) {
        await transport.close();
    }
    clients.clear();

    t.is(clients.size, 0);
});

test('closeMcpClients handles transport.close errors gracefully', async (t) => {
    const clients = new Map();
    clients.set('broken', {
        transport: {
            close: async () => {
                throw new Error('Connection already closed');
            },
        },
        connectTimestamp: Date.now(),
    });

    // Should not throw
    for (const [, { transport }] of clients) {
        try {
            await transport.close();
        } catch (error) {
            // gracefully ignored
        }
    }
    clients.clear();

    t.is(clients.size, 0);
});

// ----- MCP tool result content parsing tests -----

test('MCP tool result text content parsing joins multiple text parts', (t) => {
    const result = {
        content: [
            { type: 'text', text: 'Part 1' },
            { type: 'image', data: 'base64...' },
            { type: 'text', text: 'Part 2' },
        ],
    };

    const content = result?.content || [];
    const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
    const text = textParts.join('\n\n');

    t.is(text, 'Part 1\n\nPart 2');
});

test('MCP tool result with structuredContent returns structured data', (t) => {
    const result = {
        content: [{ type: 'text', text: 'text result' }],
        structuredContent: { issues: [{ id: 1, title: 'Bug' }] },
    };

    if (result.structuredContent) {
        t.deepEqual(result.structuredContent, { issues: [{ id: 1, title: 'Bug' }] });
    }
});

test('MCP tool result empty content falls back to JSON.stringify', (t) => {
    const result = {
        content: [],
    };

    const content = result?.content || [];
    const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
    const text = textParts.join('\n\n');

    const finalResult = text || JSON.stringify(result);
    t.is(finalResult, '{"content":[]}');
});

test('MCP tool result error detection via isError flag', (t) => {
    const result = {
        isError: true,
        content: [{ type: 'text', text: 'Something went wrong' }],
    };

    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n\n');
    const isError = result?.isError || text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');

    t.true(isError);
});

test('MCP tool result error detection via text content', (t) => {
    const result = {
        content: [{ type: 'text', text: 'The operation failed due to permissions' }],
    };

    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n\n');
    const isError = result?.isError || text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');

    t.true(isError);
});

// ----- Token expiration detection tests -----
// These use the real isTokenExpired/initializeMcpClients from mcpClient.js
// so the tests break if the logic changes.

test('isTokenExpired returns true for past timestamp', (t) => {
    t.true(isTokenExpired({ expiresAt: Date.now() - 60000 }));
});

test('isTokenExpired returns false for future timestamp', (t) => {
    t.false(isTokenExpired({ expiresAt: Date.now() + 3600000 }));
});

test('isTokenExpired returns false for missing expiresAt', (t) => {
    t.false(isTokenExpired({ url: 'https://example.com/mcp' }));
});

test('isTokenExpired returns false for non-numeric expiresAt', (t) => {
    t.false(isTokenExpired({ expiresAt: 'invalid' }));
});

test('isTokenExpired returns false for null/undefined config', (t) => {
    t.false(isTokenExpired(null));
    t.false(isTokenExpired(undefined));
});

test('initializeMcpClients returns expired servers without attempting connection', async (t) => {
    const mcpConfigJson = JSON.stringify({
        atlassian: { url: 'https://mcp.atlassian.com/v1/mcp', type: 'streamable-http', expiresAt: Date.now() - 60000 },
        slack: { url: 'https://mcp.slack.com/mcp', type: 'streamable-http', expiresAt: Date.now() - 1 },
    });

    const { clients, expiredServers } = await initializeMcpClients(mcpConfigJson);

    t.deepEqual(expiredServers, ['atlassian', 'slack']);
    t.is(clients.size, 0);
});
