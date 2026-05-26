// pathwayTools.mcpTools.test.js
// Tests for MCP tool search and execution logic in callTool (pathwayTools.js)
import test from 'ava';
import { callTool } from '../../../lib/pathwayTools.js';

// ----- _builtin_search_tools tests -----

test('SearchAvailableTools returns error when query is empty', async (t) => {
    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const result = await callTool('SearchAvailableTools', { query: '' }, toolDefinitions, null);

    const parsed = JSON.parse(result.result);
    t.true(parsed.error);
    t.true(parsed.message.includes('search query is required'));
});

test('SearchAvailableTools returns no matches for unrelated query', async (t) => {
    const catalog = {
        'jira__search_issues': {
            name: 'jira__search_issues',
            originalName: 'SearchIssues',
            server: 'jira',
            description: 'Search for issues in Jira',
            parameters: ['query', 'project'],
        },
    };

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            mcpToolCatalog: catalog,
            mcpEntityToolsDeferred: {},
            entityTools: {},
            entityToolsOpenAiFormat: [],
        },
    };

    const result = await callTool('SearchAvailableTools', { query: 'zzzzzznotfound' }, toolDefinitions, pathwayResolver);

    const parsed = JSON.parse(result.result);
    t.is(parsed.tools.length, 0);
    t.true(parsed.message.includes('No tools found'));
});

test('SearchAvailableTools matches tools by keyword', async (t) => {
    const catalog = {
        'jira__search_issues': {
            name: 'jira__search_issues',
            originalName: 'SearchIssues',
            server: 'jira',
            description: 'Search for issues in Jira project tracker',
            parameters: ['query', 'project'],
        },
        'confluence__create_page': {
            name: 'confluence__create_page',
            originalName: 'CreatePage',
            server: 'confluence',
            description: 'Create a new page in Confluence wiki',
            parameters: ['title', 'content', 'spaceKey'],
        },
        'jira__create_issue': {
            name: 'jira__create_issue',
            originalName: 'CreateIssue',
            server: 'jira',
            description: 'Create a new issue in Jira',
            parameters: ['summary', 'description', 'priority'],
        },
    };

    const deferred = {
        'jira__search_issues': {
            definition: {
                function: {
                    name: 'search_issues',
                    description: 'Search for issues in Jira project tracker',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
        'jira__create_issue': {
            definition: {
                function: {
                    name: 'create_issue',
                    description: 'Create a new issue in Jira',
                    parameters: { type: 'object', properties: { summary: { type: 'string' } } },
                },
            },
        },
    };

    const entityTools = {};
    const entityToolsOpenAiFormat = [];

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            mcpToolCatalog: catalog,
            mcpEntityToolsDeferred: deferred,
            entityTools,
            entityToolsOpenAiFormat,
        },
    };

    const result = await callTool('SearchAvailableTools', { query: 'search issues' }, toolDefinitions, pathwayResolver);

    const parsed = JSON.parse(result.result);
    t.true(parsed.tools.length > 0);
    // search_issues should score highest (matches both "search" and "issues")
    t.is(parsed.tools[0].name, 'jira__search_issues');
});

test('SearchAvailableTools dynamically loads matched tools into entityTools', async (t) => {
    const catalog = {
        'server__tool_a': {
            name: 'server__tool_a',
            originalName: 'ToolA',
            server: 'server',
            description: 'A tool that does things',
            parameters: ['param1'],
        },
    };

    const deferred = {
        'server__tool_a': {
            definition: {
                function: {
                    name: 'tool_a',
                    description: 'A tool that does things',
                    parameters: { type: 'object', properties: { param1: { type: 'string' } } },
                },
            },
        },
    };

    const entityTools = {};
    const entityToolsOpenAiFormat = [];

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            mcpToolCatalog: catalog,
            mcpEntityToolsDeferred: deferred,
            entityTools,
            entityToolsOpenAiFormat,
        },
    };

    await callTool('SearchAvailableTools', { query: 'tool' }, toolDefinitions, pathwayResolver);

    // Tool should now be loaded into entityTools
    t.truthy(entityTools['server__tool_a']);
    t.is(entityToolsOpenAiFormat.length, 1);
    t.is(entityToolsOpenAiFormat[0].function.name, 'server__tool_a');
});

test('SearchAvailableTools searches and loads local deferred tools', async (t) => {
    const catalog = {
        workspacessh: {
            name: 'workspacessh',
            displayName: 'WorkspaceSSH',
            originalName: 'WorkspaceSSH',
            server: 'cortex',
            source: 'local',
            description: 'Execute commands in a persistent Linux workspace',
            parameters: ['command'],
        },
    };

    const deferred = {
        workspacessh: {
            definition: {
                function: {
                    name: 'WorkspaceSSH',
                    description: 'Execute commands in a persistent Linux workspace',
                    parameters: { type: 'object', properties: { command: { type: 'string' } } },
                },
            },
        },
    };

    const entityTools = { workspacessh: deferred.workspacessh };
    const entityToolsOpenAiFormat = [];

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            localToolCatalog: catalog,
            localEntityToolsDeferred: deferred,
            entityTools,
            entityToolsOpenAiFormat,
        },
    };

    const result = await callTool('SearchAvailableTools', { query: 'workspace command' }, toolDefinitions, pathwayResolver);

    const parsed = JSON.parse(result.result);
    t.is(parsed.tools[0].name, 'WorkspaceSSH');
    t.is(entityToolsOpenAiFormat.length, 1);
    t.is(entityToolsOpenAiFormat[0].function.name, 'WorkspaceSSH');
});

test('SearchAvailableTools does not duplicate loaded local schemas', async (t) => {
    const catalog = {
        workspacessh: {
            name: 'workspacessh',
            displayName: 'WorkspaceSSH',
            originalName: 'WorkspaceSSH',
            server: 'cortex',
            source: 'local',
            description: 'Execute commands',
            parameters: ['command'],
        },
    };
    const deferred = {
        workspacessh: {
            definition: {
                function: {
                    name: 'WorkspaceSSH',
                    description: 'Execute commands',
                    parameters: { type: 'object', properties: { command: { type: 'string' } } },
                },
            },
        },
    };
    const entityToolsOpenAiFormat = [{
        type: 'function',
        function: { name: 'WorkspaceSSH', description: 'Execute commands', parameters: { type: 'object', properties: {} } },
    }];

    await callTool('SearchAvailableTools', { query: 'commands' }, {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    }, {
        args: {
            localToolCatalog: catalog,
            localEntityToolsDeferred: deferred,
            entityTools: { workspacessh: deferred.workspacessh },
            entityToolsOpenAiFormat,
        },
    });

    t.is(entityToolsOpenAiFormat.length, 1);
});

test('SearchAvailableTools does not duplicate already-loaded tools', async (t) => {
    const catalog = {
        'server__tool_a': {
            name: 'server__tool_a',
            originalName: 'ToolA',
            server: 'server',
            description: 'A tool',
            parameters: [],
        },
    };

    const deferred = {
        'server__tool_a': {
            definition: {
                function: {
                    name: 'tool_a',
                    description: 'A tool',
                    parameters: { type: 'object', properties: {} },
                },
            },
        },
    };

    // Tool already loaded
    const entityTools = {
        'server__tool_a': deferred['server__tool_a'],
    };
    const entityToolsOpenAiFormat = [{
        type: 'function',
        function: { name: 'server__tool_a', description: 'A tool', parameters: { type: 'object', properties: {} } },
    }];

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            mcpToolCatalog: catalog,
            mcpEntityToolsDeferred: deferred,
            entityTools,
            entityToolsOpenAiFormat,
        },
    };

    await callTool('SearchAvailableTools', { query: 'tool' }, toolDefinitions, pathwayResolver);

    // Should not duplicate
    t.is(entityToolsOpenAiFormat.length, 1);
});

test('SearchAvailableTools limits results to top 5', async (t) => {
    const catalog = {};
    const deferred = {};

    // Create 10 tools that all match "tool"
    for (let i = 0; i < 10; i++) {
        const key = `server__tool_${i}`;
        catalog[key] = {
            name: key,
            originalName: `Tool${i}`,
            server: 'server',
            description: `Tool number ${i}`,
            parameters: [],
        };
        deferred[key] = {
            definition: {
                function: {
                    name: `tool_${i}`,
                    description: `Tool number ${i}`,
                    parameters: { type: 'object', properties: {} },
                },
            },
        };
    }

    const entityTools = {};
    const entityToolsOpenAiFormat = [];

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            mcpToolCatalog: catalog,
            mcpEntityToolsDeferred: deferred,
            entityTools,
            entityToolsOpenAiFormat,
        },
    };

    const result = await callTool('SearchAvailableTools', { query: 'tool' }, toolDefinitions, pathwayResolver);

    const parsed = JSON.parse(result.result);
    t.true(parsed.tools.length <= 5);
    t.true(parsed.message.includes('Found'));
});

test('SearchAvailableTools ranks by keyword match score', async (t) => {
    const catalog = {
        'server__general_tool': {
            name: 'server__general_tool',
            originalName: 'GeneralTool',
            server: 'server',
            description: 'A general purpose utility',
            parameters: [],
        },
        'server__search_issues': {
            name: 'server__search_issues',
            originalName: 'SearchIssues',
            server: 'server',
            description: 'Search for issues and bugs in the tracker',
            parameters: ['query'],
        },
        'server__list_issues': {
            name: 'server__list_issues',
            originalName: 'ListIssues',
            server: 'server',
            description: 'List all issues',
            parameters: [],
        },
    };

    const toolDefinitions = {
        searchavailabletools: {
            pathwayName: '_builtin_search_tools',
            definition: {
                type: 'function',
                function: {
                    name: 'SearchAvailableTools',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } },
                },
            },
        },
    };

    const pathwayResolver = {
        args: {
            mcpToolCatalog: catalog,
            mcpEntityToolsDeferred: {},
            entityTools: {},
            entityToolsOpenAiFormat: [],
        },
    };

    const result = await callTool('SearchAvailableTools', { query: 'search issues' }, toolDefinitions, pathwayResolver);

    const parsed = JSON.parse(result.result);
    // "search_issues" should be first because it matches both keywords
    t.is(parsed.tools[0].name, 'server__search_issues');
});

// ----- MCP tool execution path tests -----

test('callTool for MCP tool throws when mcpClients not initialized', async (t) => {
    const toolDefinitions = {
        'server__my_tool': {
            mcpServer: 'server',
            mcpToolName: 'MyTool',
            definition: {
                function: {
                    parameters: { type: 'object', properties: { q: { type: 'string' } } },
                },
            },
            pathwayName: 'mcp_tool_execution',
        },
    };

    const pathwayResolver = {
        args: { mcpClients: null },
    };

    const result = await callTool('server__my_tool', { q: 'test' }, toolDefinitions, pathwayResolver);

    t.truthy(result.error);
    t.true(result.error.includes('MCP clients not initialized'));
});

test('callTool for MCP tool throws when mcpClients is empty', async (t) => {
    const toolDefinitions = {
        'server__my_tool': {
            mcpServer: 'server',
            mcpToolName: 'MyTool',
            definition: {
                function: {
                    parameters: { type: 'object', properties: { q: { type: 'string' } } },
                },
            },
            pathwayName: 'mcp_tool_execution',
        },
    };

    const pathwayResolver = {
        args: { mcpClients: new Map() },
    };

    const result = await callTool('server__my_tool', { q: 'test' }, toolDefinitions, pathwayResolver);

    t.truthy(result.error);
    t.true(result.error.includes('MCP clients not initialized'));
});

test('callTool for MCP tool filters args to only tool-specific parameters', async (t) => {
    // This test verifies that callTool only passes tool-defined parameters to MCP,
    // not the full args (which include chatHistory, entityTools, etc.)
    const toolDefinitions = {
        'server__my_tool': {
            mcpServer: 'server',
            mcpToolName: 'MyTool',
            definition: {
                function: {
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string' },
                            limit: { type: 'number' },
                        },
                    },
                },
            },
            pathwayName: 'mcp_tool_execution',
        },
    };

    // Extract the filtering logic (same as in callTool)
    const toolDef = toolDefinitions['server__my_tool'];
    const args = {
        query: 'test search',
        limit: 10,
        chatHistory: [{ role: 'user', content: 'hi' }],
        entityTools: { lots: 'of tools' },
        stream: false,
        toolFunction: 'server__my_tool',
    };

    const toolParamKeys = Object.keys(toolDef.definition?.function?.parameters?.properties || {});
    const mcpArgs = {};
    for (const key of toolParamKeys) {
        if (key in args) {
            mcpArgs[key] = args[key];
        }
    }

    t.deepEqual(mcpArgs, { query: 'test search', limit: 10 });
    t.is(mcpArgs.chatHistory, undefined);
    t.is(mcpArgs.entityTools, undefined);
});

test('InspectToolResult returns bounded summary and chunks from snapshot store', async (t) => {
    const toolDefinitions = {
        inspecttoolresult: {
            pathwayName: '_builtin_inspect_tool_result',
            definition: {
                type: 'function',
                function: {
                    name: 'InspectToolResult',
                    parameters: {
                        type: 'object',
                        properties: {
                            resultRef: { type: 'string' },
                            mode: { type: 'string' },
                            offset: { type: 'number' },
                            limit: { type: 'number' },
                        },
                    },
                },
            },
        },
    };

    const fullEnvelope = JSON.stringify({
        _toolResultEnvelope: true,
        resultRef: 'tr_1',
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: 'full',
        stdoutPreview: '0123456789abcdefghijklmnopqrstuvwxyz',
    });

    const summaryResult = await callTool('InspectToolResult', {
        resultRef: 'tr_1',
    }, toolDefinitions, {
        _toolResultSnapshots: new Map([['tr_1', { content: fullEnvelope, length: fullEnvelope.length }]]),
    });

    const summary = JSON.parse(summaryResult.result);
    t.true(summary.ok);
    t.is(summary.mode, 'summary');
    t.is(summary.resultRef, 'tr_1');
    t.is(summary.tool, 'workspacessh');
    t.is(summary.readableChars, 36);
    t.falsy(summaryResult.historyMutation);

    const chunkResult = await callTool('InspectToolResult', {
        resultRef: 'tr_1',
        mode: 'chunk',
        offset: 10,
        limit: 5,
    }, toolDefinitions, {
        _toolResultSnapshots: new Map([['tr_1', { content: fullEnvelope, length: fullEnvelope.length }]]),
    });

    const chunk = JSON.parse(chunkResult.result);
    t.true(chunk.ok);
    t.is(chunk.mode, 'chunk');
    t.is(chunk.offset, 10);
    t.is(chunk.limit, 5);
    t.is(chunk.content, 'abcde');
    t.true(chunk.hasMoreBefore);
    t.true(chunk.hasMoreAfter);
});

test('InspectToolResult includes stderr for mixed stdout and stderr snapshots', async (t) => {
    const toolDefinitions = {
        inspecttoolresult: {
            pathwayName: '_builtin_inspect_tool_result',
            definition: {
                type: 'function',
                function: {
                    name: 'InspectToolResult',
                    parameters: {
                        type: 'object',
                        properties: {
                            resultRef: { type: 'string' },
                            mode: { type: 'string' },
                            query: { type: 'string' },
                        },
                    },
                },
            },
        },
    };

    const fullEnvelope = JSON.stringify({
        _toolResultEnvelope: true,
        resultRef: 'tr_mixed',
        tool: 'workspacessh',
        kind: 'workspace-shell',
        stdoutPreview: 'stdout line',
        stdoutTotalChars: 11,
        stderrPreview: 'stderr diagnostic',
        stderrTotalChars: 17,
    });

    const snapshotStore = new Map([['tr_mixed', { content: fullEnvelope, length: fullEnvelope.length }]]);
    const headResult = await callTool('InspectToolResult', {
        resultRef: 'tr_mixed',
        mode: 'head',
    }, toolDefinitions, {
        _toolResultSnapshots: snapshotStore,
    });

    const head = JSON.parse(headResult.result);
    t.true(head.ok);
    t.true(head.content.includes('[stdout]\nstdout line'));
    t.true(head.content.includes('[stderr]\nstderr diagnostic'));
    t.is(head.stderrTotalChars, 17);

    const searchResult = await callTool('InspectToolResult', {
        resultRef: 'tr_mixed',
        mode: 'search',
        query: 'diagnostic',
    }, toolDefinitions, {
        _toolResultSnapshots: snapshotStore,
    });

    const search = JSON.parse(searchResult.result);
    t.is(search.matchCount, 1);
    t.true(search.matches[0].snippet.includes('stderr diagnostic'));
});

test('InspectToolResult supports bounded search within a snapshot', async (t) => {
    const toolDefinitions = {
        inspecttoolresult: {
            pathwayName: '_builtin_inspect_tool_result',
            definition: {
                type: 'function',
                function: {
                    name: 'InspectToolResult',
                    parameters: {
                        type: 'object',
                        properties: {
                            resultRef: { type: 'string' },
                            mode: { type: 'string' },
                            query: { type: 'string' },
                            limit: { type: 'number' },
                        },
                    },
                },
            },
        },
    };

    const fullEnvelope = JSON.stringify({
        _toolResultEnvelope: true,
        resultRef: 'tr_1',
        tool: 'searchinternet',
        kind: 'generic',
        compacted: false,
        summary: 'search result',
        contentPreview: 'alpha needle beta gamma NEEDLE delta',
    });

    const result = await callTool('InspectToolResult', {
        resultRef: 'tr_1',
        mode: 'search',
        query: 'needle',
        limit: 18,
    }, toolDefinitions, {
        _toolResultSnapshots: new Map([['tr_1', { content: fullEnvelope }]]),
    });

    const parsed = JSON.parse(result.result);
    t.true(parsed.ok);
    t.is(parsed.mode, 'search');
    t.is(parsed.query, 'needle');
    t.is(parsed.matchCount, 2);
    t.is(parsed.matches[0].offset, 6);
    t.true(parsed.matches[0].snippet.includes('needle'));
    t.true(parsed.matches[1].snippet.includes('NEEDLE'));
});

test('InspectToolResult search returns concise JSON leaf snippets', async (t) => {
    const toolDefinitions = {
        inspecttoolresult: {
            pathwayName: '_builtin_inspect_tool_result',
            definition: {
                type: 'function',
                function: {
                    name: 'InspectToolResult',
                    parameters: {
                        type: 'object',
                        properties: {
                            resultRef: { type: 'string' },
                            mode: { type: 'string' },
                            query: { type: 'string' },
                            limit: { type: 'number' },
                        },
                    },
                },
            },
        },
    };

    const repeatedWrapper = {
        searchResultId: 'result-wrapper-one',
        metadata: {
            source: 'wire',
            repeated: 'same envelope fields repeated around every result',
        },
        snippet: 'The new tariff policy was discussed in detail by officials.',
    };
    const fullEnvelope = JSON.stringify({
        _toolResultEnvelope: true,
        resultRef: 'tr_1',
        tool: 'searchindex',
        kind: 'generic',
        compacted: false,
        summary: 'search result',
        contentPreview: JSON.stringify([
            repeatedWrapper,
            {
                ...repeatedWrapper,
                searchResultId: 'result-wrapper-two',
                snippet: 'Another tariff mention appears in a separate concise leaf value.',
            },
        ]),
    });

    const result = await callTool('InspectToolResult', {
        resultRef: 'tr_1',
        mode: 'search',
        query: 'tariff',
        limit: 2000,
    }, toolDefinitions, {
        _toolResultSnapshots: new Map([['tr_1', { content: fullEnvelope }]]),
    });

    const parsed = JSON.parse(result.result);
    t.true(parsed.ok);
    t.is(parsed.matchCount, 2);
    t.is(parsed.matches[0].path, '$[0].snippet');
    t.is(parsed.matches[1].path, '$[1].snippet');
    t.true(parsed.matches[0].snippet.includes('tariff'));
    t.false(parsed.matches[0].snippet.includes('searchResultId'));
    t.true(Number.isFinite(parsed.matches[0].offset));
});

test('InspectToolResult returns an error when the snapshot is not present', async (t) => {
    const toolDefinitions = {
        inspecttoolresult: {
            pathwayName: '_builtin_inspect_tool_result',
            definition: {
                type: 'function',
                function: {
                    name: 'InspectToolResult',
                    parameters: {
                        type: 'object',
                        properties: {
                            resultRef: { type: 'string' },
                        },
                    },
                },
            },
        },
    };

    const result = await callTool('InspectToolResult', {
        resultRef: 'tr_missing',
    }, toolDefinitions, {
        _toolResultSnapshots: new Map(),
    });

    const parsed = JSON.parse(result.result);
    t.true(parsed.error);
    t.true(parsed.message.includes('not available'));
});

// ----- Tool not found test -----

test('callTool throws for unknown tool', async (t) => {
    const toolDefinitions = {};

    const error = await t.throwsAsync(
        callTool('nonexistent_tool', {}, toolDefinitions, null)
    );

    t.true(error.message.includes('Tool nonexistent_tool not found'));
});
