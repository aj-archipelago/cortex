import test from 'ava';
import {
    registerConnectMcpServer,
    registerInspectToolResult,
    registerRequestScopedTools,
    registerReauthenticateMcpServer,
    registerSearchAvailableTools,
} from '../../../pathways/system/entity/tools/shared/request_scoped_tools.js';

test('registerInspectToolResult adds bounded tool-result inspection tool', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];

    registerInspectToolResult(entityTools, entityToolsOpenAiFormat);

    t.truthy(entityTools.inspecttoolresult);
    t.is(entityTools.inspecttoolresult.pathwayName, '_builtin_inspect_tool_result');
    t.is(entityToolsOpenAiFormat[0].function.name, 'InspectToolResult');
    t.true(entityToolsOpenAiFormat[0].function.description.includes('without expanding it into the conversation history'));
    t.truthy(entityToolsOpenAiFormat[0].function.parameters.properties.resultRef);
    t.truthy(entityToolsOpenAiFormat[0].function.parameters.properties.mode);
    t.truthy(entityToolsOpenAiFormat[0].function.parameters.properties.query);
    t.falsy(entityToolsOpenAiFormat[0].function.parameters.properties.userMessage);
    t.falsy(entityToolsOpenAiFormat[0].function.parameters.properties.icon);
    t.is(entityTools.inspecttoolresult.definition.icon, '🔎');
    t.true(entityTools.inspecttoolresult.definition.silent);
});

test('registerRequestScopedTools includes InspectToolResult', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, {});
    t.truthy(entityTools.inspecttoolresult);
    t.true(entityToolsOpenAiFormat.some(tool => tool.function.name === 'InspectToolResult'));
});

test('registerRequestScopedTools omits InspectToolResult when compactionEnabled is false', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, { compactionEnabled: false });
    t.falsy(entityTools.inspecttoolresult);
    t.false(entityToolsOpenAiFormat.some(tool => tool.function.name === 'InspectToolResult'));
});

test('registerSearchAvailableTools adds runtime search tool from connected MCP servers', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    const logger = { info() {} };

    registerSearchAvailableTools(entityTools, entityToolsOpenAiFormat, {
        mcpClients: new Map([['jira', {}]]),
        mcpToolCatalog: {
            jira__search_issues: {
                server: 'jira',
                originalName: 'SearchIssues',
                description: 'Search JIRA issues by JQL',
            },
        },
        mcpExpiredServers: ['slack'],
        logger,
    });

    t.truthy(entityTools.searchavailabletools);
    t.is(entityTools.searchavailabletools.pathwayName, '_builtin_search_tools');
    t.true(entityTools.searchavailabletools.definition.silent);
    t.is(entityTools.searchavailabletools.definition.toolCost, 1);
    const description = entityToolsOpenAiFormat[0].function.description;
    t.true(description.includes('in-memory catalog'));
    t.true(description.includes('[MCP — jira]'));
    t.true(description.includes('SearchIssues'));
    t.true(description.includes('Search JIRA issues by JQL'));
    t.is(entityToolsOpenAiFormat[0].function.name, 'SearchAvailableTools');
});

test('registerSearchAvailableTools adds runtime search tool from local catalog', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];

    registerSearchAvailableTools(entityTools, entityToolsOpenAiFormat, {
        localToolCatalog: {
            workspacessh: {
                name: 'workspacessh',
                originalName: 'WorkspaceSSH',
                description: 'Execute commands in a workspace',
                parameters: ['command'],
            },
            generateapplet: {
                name: 'generateapplet',
                displayName: 'GenerateApplet',
                originalName: 'GenerateApplet',
                description: 'Create a file-backed applet from a prompt or workspace path',
                parameters: ['prompt', 'workspacePath'],
            },
        },
    });

    t.truthy(entityTools.searchavailabletools);
    t.is(entityToolsOpenAiFormat.length, 1);
    t.is(entityToolsOpenAiFormat[0].function.name, 'SearchAvailableTools');
    const description = entityToolsOpenAiFormat[0].function.description;
    t.true(description.includes('[Local — Cortex]'));
    t.true(description.includes('WorkspaceSSH'));
    t.true(description.includes('GenerateApplet'));
});

test('registerSearchAvailableTools truncates long descriptions and caps per-group entries', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    const localToolCatalog = {};
    for (let i = 0; i < 60; i += 1) {
        localToolCatalog[`tool_${i}`] = {
            name: `tool_${i}`,
            originalName: `Tool${i}`,
            description: 'x'.repeat(200),
            parameters: [],
        };
    }

    registerSearchAvailableTools(entityTools, entityToolsOpenAiFormat, { localToolCatalog });

    const description = entityToolsOpenAiFormat[0].function.description;
    t.true(description.includes('…and 10 more'));
    t.true(description.includes('xxxxxxx…'));
    t.false(description.includes('x'.repeat(100)));
});

test('registerSearchAvailableTools omits catalog section when empty', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    registerSearchAvailableTools(entityTools, entityToolsOpenAiFormat, {
        mcpClients: new Map([['jira', {}]]),
        mcpToolCatalog: {},
    });
    const description = entityToolsOpenAiFormat[0].function.description;
    t.false(description.includes('Available capabilities'));
});

test('registerRequestScopedTools adds connect and reauth client-side tools when applicable', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    const logger = { info() {} };

    registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, {
        mcpExpiredServers: ['github'],
        availableServers: [{ id: 'slack', name: 'Slack', description: 'Chat search' }],
        logger,
    });

    t.truthy(entityTools.reauthenticatemcpserver);
    t.truthy(entityTools.connectmcpserver);
    t.true(entityTools.reauthenticatemcpserver.clientSide);
    t.true(entityTools.connectmcpserver.clientSide);
    t.true(entityToolsOpenAiFormat.some(tool => tool.function.name === 'ReauthenticateMcpServer'));
    t.true(entityToolsOpenAiFormat.some(tool => tool.function.name === 'ConnectMcpServer'));
});

test('registerConnectMcpServer and registerReauthenticateMcpServer skip empty inputs', (t) => {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];

    t.false(registerConnectMcpServer(entityTools, entityToolsOpenAiFormat, { availableServers: [] }));
    t.false(registerReauthenticateMcpServer(entityTools, entityToolsOpenAiFormat, { mcpExpiredServers: [] }));
    t.deepEqual(entityTools, {});
    t.deepEqual(entityToolsOpenAiFormat, []);
});
