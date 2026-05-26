function toOpenAiToolFormat(definition) {
    const {
        icon,
        pathwayParams,
        silent,
        defaultUserMessage,
        allowResultCompaction,
        ...definitionWithoutExtras
    } = definition;
    return definitionWithoutExtras;
}

function registerRuntimeTool(entityTools, entityToolsOpenAiFormat, toolName, toolEntry, openAiTool = null) {
    const toolKey = toolName.toLowerCase();
    if (entityTools[toolKey]) {
        return false;
    }

    entityTools[toolKey] = toolEntry;
    entityToolsOpenAiFormat.push(openAiTool || toOpenAiToolFormat(toolEntry.definition));
    return true;
}

function registerInspectToolResult(entityTools, entityToolsOpenAiFormat) {
    return registerRuntimeTool(entityTools, entityToolsOpenAiFormat, 'InspectToolResult', {
        definition: {
            type: 'function',
            icon: '🔎',
            toolCost: 1,
            silent: true,
            function: {
                name: 'InspectToolResult',
                description: 'Read a bounded view of a prior large tool result by resultRef without expanding it into the conversation history. Use summary first, then head, tail, chunk, or search when you need specific details from a compacted or oversized result.',
                parameters: {
                    type: 'object',
                    properties: {
                        resultRef: {
                            type: 'string',
                            description: 'Result reference from a prior tool result, such as tr_3.',
                        },
                        mode: {
                            type: 'string',
                            enum: ['summary', 'head', 'tail', 'chunk', 'search'],
                            description: 'How to inspect the result. Defaults to summary.',
                        },
                        query: {
                            type: 'string',
                            description: 'Required for search mode. Case-insensitive text to find within the result. JSON results return concise matching leaf values with paths instead of repeated wrappers.',
                        },
                        offset: {
                            type: 'number',
                            description: 'Character offset for chunk mode. Defaults to 0.',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum characters to return for head, tail, chunk, or each search snippet. Defaults to a bounded value and is capped.',
                        },
                    },
                    required: ['resultRef'],
                },
            },
        },
        pathwayName: '_builtin_inspect_tool_result',
    });
}

const SEARCH_TOOLS_DESCRIPTION_BASE = `Search the in-memory catalog of available tools, then make matching tools callable for this request. Your visible tool list is a starting subset — the catalog below holds many more capabilities that are not loaded yet. Whenever the user wants something and you do not see a matching tool, your first action is to call this with relevant keywords or with the exact tool name from the catalog. Matched tools become callable in the same response. Never tell the user a capability is missing without searching first.`;

const CATALOG_DESC_MAX_LENGTH = 80;
const CATALOG_PER_GROUP_MAX = 50;

function summarizeCatalogDescription(description) {
    if (!description) {
        return '';
    }
    const cleaned = String(description).replace(/\s+/g, ' ').trim();
    if (cleaned.length <= CATALOG_DESC_MAX_LENGTH) {
        return cleaned;
    }
    return `${cleaned.slice(0, CATALOG_DESC_MAX_LENGTH - 1).trimEnd()}…`;
}

function formatCatalogSection(header, entries) {
    if (!entries || entries.length === 0) {
        return '';
    }
    const visible = entries.slice(0, CATALOG_PER_GROUP_MAX);
    const lines = visible.map(entry => {
        const name = entry.displayName || entry.originalName || entry.name;
        const desc = summarizeCatalogDescription(entry.description);
        return desc ? `- ${name} — ${desc}` : `- ${name}`;
    });
    if (entries.length > visible.length) {
        lines.push(`- …and ${entries.length - visible.length} more`);
    }
    return `\n[${header}]\n${lines.join('\n')}`;
}

function buildSearchToolsDescription(localToolCatalog, mcpToolCatalog) {
    const sections = [];

    const localEntries = Object.values(localToolCatalog || {});
    if (localEntries.length > 0) {
        sections.push(formatCatalogSection('Local — Cortex', localEntries));
    }

    const mcpByServer = new Map();
    for (const entry of Object.values(mcpToolCatalog || {})) {
        const server = entry?.server || 'mcp';
        if (!mcpByServer.has(server)) {
            mcpByServer.set(server, []);
        }
        mcpByServer.get(server).push(entry);
    }
    for (const [server, entries] of mcpByServer) {
        sections.push(formatCatalogSection(`MCP — ${server}`, entries));
    }

    if (sections.length === 0) {
        return SEARCH_TOOLS_DESCRIPTION_BASE;
    }

    return `${SEARCH_TOOLS_DESCRIPTION_BASE}\n\nAvailable capabilities (search by keyword or exact name):${sections.join('\n')}`;
}

function registerSearchAvailableTools(entityTools, entityToolsOpenAiFormat, options = {}) {
    const {
        mcpClients = new Map(),
        mcpToolCatalog = {},
        localToolCatalog = {},
        mcpExpiredServers = [],
        logger = null,
    } = options;

    const hasMcpTools = mcpClients && mcpClients.size > 0;
    const hasLocalTools = Object.keys(localToolCatalog || {}).length > 0;
    if (!hasMcpTools && !hasLocalTools) {
        return false;
    }

    if (logger && hasMcpTools) {
        const serverNames = [...mcpClients.keys()].join(', ');
        logger.info(`Discovered ${Object.keys(mcpToolCatalog || {}).length} MCP tools from ${mcpClients.size} server(s) [${serverNames}] — deferred (not loaded into context)`);
    }

    return registerRuntimeTool(entityTools, entityToolsOpenAiFormat, 'SearchAvailableTools', {
        definition: {
            type: 'function',
            icon: '🔍',
            toolCost: 1,
            silent: true,
            defaultUserMessage: 'Searching available tools',
            function: {
                name: 'SearchAvailableTools',
                description: buildSearchToolsDescription(localToolCatalog, mcpToolCatalog),
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Keywords describing the capability you need (e.g. "applet", "image", "search issues") or an exact tool name copied from the catalog in this tool\'s description.',
                        },
                    },
                    required: ['query'],
                },
            },
        },
        pathwayName: '_builtin_search_tools',
    });
}

function registerReauthenticateMcpServer(entityTools, entityToolsOpenAiFormat, options = {}) {
    const { mcpExpiredServers = [], logger = null } = options;
    if (!Array.isArray(mcpExpiredServers) || mcpExpiredServers.length === 0) {
        return false;
    }

    const expiredList = mcpExpiredServers.join(', ');
    if (logger) {
        logger.info(`Registering ReauthenticateMcpServer client-side tool for expired servers: ${expiredList}`);
    }

    return registerRuntimeTool(entityTools, entityToolsOpenAiFormat, 'ReauthenticateMcpServer', {
        definition: {
            type: 'function',
            function: {
                name: 'ReauthenticateMcpServer',
                description: `Re-authenticate an expired MCP service connection. The following services have expired authentication tokens and their tools are unavailable until re-authenticated: ${expiredList}. Call this tool to open a re-authentication window for the user. After the user completes re-authentication, the connection will be restored for subsequent messages.`,
                parameters: {
                    type: 'object',
                    properties: {
                        serverKey: {
                            type: 'string',
                            enum: mcpExpiredServers,
                            description: 'The MCP server to re-authenticate.',
                        },
                        userMessage: {
                            type: 'string',
                            description: 'A brief message to the user explaining why re-authentication is needed.',
                        },
                    },
                    required: ['serverKey', 'userMessage'],
                },
            },
            icon: '🔑',
        },
        pathwayName: 'client_side_execution',
        clientSide: true,
    }, {
        type: 'function',
        function: {
            name: 'ReauthenticateMcpServer',
            description: `Re-authenticate an expired MCP service connection. The following services have expired authentication tokens and their tools are unavailable until re-authenticated: ${expiredList}. Call this tool to open a re-authentication window for the user. After the user completes re-authentication, the connection will be restored for subsequent messages.`,
            parameters: {
                type: 'object',
                properties: {
                    serverKey: {
                        type: 'string',
                        enum: mcpExpiredServers,
                        description: 'The MCP server to re-authenticate.',
                    },
                    userMessage: {
                        type: 'string',
                        description: 'A brief message to the user explaining why re-authentication is needed.',
                    },
                },
                required: ['serverKey', 'userMessage'],
            },
        },
        icon: '🔑',
    });
}

function registerConnectMcpServer(entityTools, entityToolsOpenAiFormat, options = {}) {
    const { availableServers = [], logger = null } = options;
    if (!Array.isArray(availableServers) || availableServers.length === 0) {
        return false;
    }

    const serviceIds = availableServers.map(server => server.id);
    const serviceList = availableServers.map(server => `- ${server.id}: ${server.name} — ${server.description}`).join('\n');
    if (logger) {
        logger.info(`Registering ConnectMcpServer client-side tool for ${serviceIds.length} available service(s): ${serviceIds.join(', ')}`);
    }

    return registerRuntimeTool(entityTools, entityToolsOpenAiFormat, 'ConnectMcpServer', {
        definition: {
            type: 'function',
            function: {
                name: 'ConnectMcpServer',
                description: `Connect a new external service that the user has not set up yet. Call this tool when the user wants to use a service that is not currently connected. This will open an authentication window for the user to authorize access. After connecting, the service's tools will be available in subsequent messages.\n\nAvailable services to connect:\n${serviceList}`,
                parameters: {
                    type: 'object',
                    properties: {
                        serverKey: {
                            type: 'string',
                            enum: serviceIds,
                            description: 'The service to connect.',
                        },
                        userMessage: {
                            type: 'string',
                            description: 'A brief message to the user explaining why connecting this service would be helpful.',
                        },
                    },
                    required: ['serverKey', 'userMessage'],
                },
            },
            icon: '🔗',
        },
        pathwayName: 'client_side_execution',
        clientSide: true,
    }, {
        type: 'function',
        function: {
            name: 'ConnectMcpServer',
            description: `Connect a new external service that the user has not set up yet. Call this tool when the user wants to use a service that is not currently connected. This will open an authentication window for the user to authorize access. After connecting, the service's tools will be available in subsequent messages.\n\nAvailable services to connect:\n${serviceList}`,
            parameters: {
                type: 'object',
                properties: {
                    serverKey: {
                        type: 'string',
                        enum: serviceIds,
                        description: 'The service to connect.',
                    },
                    userMessage: {
                        type: 'string',
                        description: 'A brief message to the user explaining why connecting this service would be helpful.',
                    },
                },
                required: ['serverKey', 'userMessage'],
            },
        },
        icon: '🔗',
    });
}

function registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, options = {}) {
    registerSearchAvailableTools(entityTools, entityToolsOpenAiFormat, options);
    registerReauthenticateMcpServer(entityTools, entityToolsOpenAiFormat, options);
    registerConnectMcpServer(entityTools, entityToolsOpenAiFormat, options);
    if (options.compactionEnabled !== false) {
        registerInspectToolResult(entityTools, entityToolsOpenAiFormat, options);
    }
}

export {
    registerConnectMcpServer,
    registerInspectToolResult,
    registerReauthenticateMcpServer,
    registerRequestScopedTools,
    registerSearchAvailableTools,
};
