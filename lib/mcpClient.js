// mcpClient.js
// MCP (Model Context Protocol) client for connecting to remote MCP servers
// and exposing their tools to the cortex agent system.
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import logger from './logger.js';

const MCP_TIMEOUT_MS = 30000;

/**
 * Check whether a server config's OAuth token has expired.
 * @param {object} serverConfig - Single MCP server config object
 * @returns {boolean}
 */
export function isTokenExpired(serverConfig) {
    const expiresAt = serverConfig?.expiresAt;
    return !!(expiresAt && typeof expiresAt === 'number' && expiresAt <= Date.now());
}

/**
 * Initialize MCP clients for each server in the config.
 * @param {string} mcpConfigJson - JSON string of MCP server config: { serverKey: { type, url, headers? } }
 * @returns {Promise<{ clients: Map<string, { client: Client, transport: StreamableHTTPClientTransport }>, expiredServers: string[] }>}
 */
export async function initializeMcpClients(mcpConfigJson) {
    const clients = new Map();
    const expiredServers = [];
    if (!mcpConfigJson || typeof mcpConfigJson !== 'string') {
        return { clients, expiredServers };
    }

    let config;
    try {
        config = JSON.parse(mcpConfigJson);
    } catch (e) {
        logger.warn(`Failed to parse mcpConfig: ${e.message}`);
        return { clients, expiredServers };
    }

    if (!config || typeof config !== 'object') {
        return { clients, expiredServers };
    }

    for (const [serverKey, serverConfig] of Object.entries(config)) {
        if (!serverConfig?.url) {
            logger.warn(`MCP server ${serverKey} missing url, skipping`);
            continue;
        }

        const type = serverConfig.type || 'streamable-http';
        if (type !== 'streamable-http') {
            logger.warn(`MCP server ${serverKey} has unsupported type: ${type}, skipping`);
            continue;
        }

        // Check token expiration before attempting connection
        if (isTokenExpired(serverConfig)) {
            const expiresAt = serverConfig.expiresAt;
            logger.info(`[MCP:${serverKey}] token expired at ${new Date(expiresAt).toISOString()}, skipping connection`);
            expiredServers.push(serverKey);
            continue;
        }

        try {
            const url = new URL(serverConfig.url);
            const headers = serverConfig.headers || {};
            const hasAuth = !!headers.Authorization;
            const hasCloudId = !!headers['X-Atlassian-Cloud-Id'];
            const configCloudId = serverConfig.cloudId;
            const expiresAt = serverConfig.expiresAt;
            logger.info(`[MCP:${serverKey}] connecting to ${serverConfig.url} | hasAuth=${hasAuth} | hasCloudId=${hasCloudId} | configCloudId=${configCloudId || 'none'} | headerKeys=${Object.keys(headers).join(',')} | expiresAt=${expiresAt ? new Date(expiresAt).toISOString() : 'none'} | now=${new Date().toISOString()}`);

            const requestInit = { headers };
            const transport = new StreamableHTTPClientTransport(url, { requestInit });
            const client = new Client(
                { name: 'cortex-mcp-client', version: '1.0.0' }
            );

            const connectTimestamp = Date.now();

            client.onerror = (err) => logger.error(`[MCP:${serverKey}] client error (age=${Date.now() - connectTimestamp}ms): ${err?.message || err}`);
            client.onclose = () => logger.warn(`[MCP:${serverKey}] client onclose fired (age=${Date.now() - connectTimestamp}ms)`, new Error('onclose stack trace').stack);

            await Promise.race([
                client.connect(transport),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('MCP connection timeout')), MCP_TIMEOUT_MS)
                ),
            ]);

            const serverInfo = client.getServerVersion?.() || client.serverInfo || 'unknown';
            const serverCaps = client.getServerCapabilities?.() || client.serverCapabilities || {};
            logger.info(`[MCP:${serverKey}] connected in ${Date.now() - connectTimestamp}ms | serverInfo=${JSON.stringify(serverInfo)} | serverCaps=${JSON.stringify(serverCaps)}`);
            clients.set(serverKey, { client, transport, connectTimestamp, cloudId: serverConfig.cloudId || null });
        } catch (error) {
            logger.warn(`Failed to connect to MCP server ${serverKey}: ${error?.message || error}`);
        }
    }

    return { clients, expiredServers };
}

/**
 * Convert MCP tool schema to OpenAI function-calling format.
 * @param {object} tool - MCP tool definition
 * @param {string} serverKey - Server identifier
 * @param {object} [cloudIdState] - cloudId resolution result from auto-discovery
 * @param {string} [cloudIdState.resolved] - Known cloudId (strip from schema, inject at call time)
 * @param {Array}  [cloudIdState.availableSites] - Multiple sites the user must choose from
 */
function mcpToolToOpenAI(tool, serverKey, cloudIdState) {
    const inputSchema = tool.inputSchema || { type: 'object', properties: {} };
    let properties = { ...(inputSchema.properties || {}) };
    let required = [...(inputSchema.required || [])];

    if (cloudIdState?.resolved) {
        // cloudId is known — strip from schema (injected server-side at call time)
        delete properties.cloudId;
        required = required.filter(r => r !== 'cloudId');
    } else if (cloudIdState?.availableSites?.length > 0 && properties.cloudId) {
        // Multiple sites — keep cloudId visible but list options so AI asks the user
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

/**
 * Discover tools from all connected MCP clients.
 * @param {Map<string, { client: Client, transport: StreamableHTTPClientTransport }>} clients
 * @returns {{ entityTools: Object, entityToolsOpenAiFormat: Array, toolToServerMap: Map<string, string> }}
 */
export async function discoverMcpTools(clients) {
    const entityTools = {};
    const entityToolsOpenAiFormat = [];
    const toolToServerMap = new Map();
    // Lightweight catalog for tool search — contains name, description, server, and parameter names
    // but NOT full schemas, keeping search results concise
    const mcpToolCatalog = {};

    for (const [serverKey, { client, connectTimestamp }] of clients) {
        try {
            logger.info(`[MCP:${serverKey}] listing tools (age=${Date.now() - connectTimestamp}ms)...`);
            const result = await client.listTools();
            const tools = result?.tools || [];
            logger.info(`[MCP:${serverKey}] discovered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
            for (const tool of tools) {
                logger.debug(JSON.stringify({
                    event: 'mcp_tool_schema',
                    server: serverKey,
                    tool: tool.name,
                    schema: tool.inputSchema || {},
                    description: tool.description || '',
                }));
            }

            // Auto-discover cloudId if missing — Atlassian MCP servers expose
            // getAccessibleAtlassianResources which returns the user's sites.
            const entry = clients.get(serverKey);
            let cloudIdState = entry.cloudId ? { resolved: entry.cloudId } : null;
            if (!entry.cloudId) {
                const resourcesTool = tools.find(t => t.name === 'getAccessibleAtlassianResources');
                if (resourcesTool) {
                    try {
                        logger.info(`[MCP:${serverKey}] cloudId missing — calling getAccessibleAtlassianResources to auto-discover`);
                        const resResult = await client.callTool({ name: 'getAccessibleAtlassianResources', arguments: {} });
                        const resText = (resResult?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
                        const sites = JSON.parse(resText);
                        if (Array.isArray(sites) && sites.length > 0) {
                            const preferredUrl = process.env.ATLASSIAN_PREFERRED_CLOUD;
                            if (sites.length === 1) {
                                // Single site — use it
                                entry.cloudId = sites[0].id;
                                cloudIdState = { resolved: entry.cloudId };
                                logger.info(`[MCP:${serverKey}] auto-discovered cloudId: ${entry.cloudId} (${sites[0].name || sites[0].url || 'unknown'})`);
                            } else if (preferredUrl) {
                                // Multiple sites — look for preferred
                                const match = sites.find(s => s.url?.includes(preferredUrl) || s.name?.includes(preferredUrl));
                                if (match) {
                                    entry.cloudId = match.id;
                                    cloudIdState = { resolved: entry.cloudId };
                                    logger.info(`[MCP:${serverKey}] auto-selected preferred cloudId: ${entry.cloudId} (${match.url || match.name}) from ${sites.length} sites`);
                                } else {
                                    // Preferred not found — let AI ask the user
                                    cloudIdState = { availableSites: sites };
                                    logger.info(`[MCP:${serverKey}] ${sites.length} sites found but preferred "${preferredUrl}" not among them — AI will ask user`);
                                }
                            } else {
                                // Multiple sites, no preference configured — let AI ask the user
                                cloudIdState = { availableSites: sites };
                                logger.info(`[MCP:${serverKey}] ${sites.length} sites found, no ATLASSIAN_PREFERRED_CLOUD set — AI will ask user`);
                            }
                        } else {
                            logger.warn(`[MCP:${serverKey}] getAccessibleAtlassianResources returned no sites: ${resText.slice(0, 200)}`);
                        }
                    } catch (err) {
                        logger.warn(`[MCP:${serverKey}] failed to auto-discover cloudId: ${err?.message || err}`);
                    }
                }
            }

            for (const tool of tools) {
                const toolName = tool.name?.toLowerCase();
                if (!toolName) continue;

                const openAiTool = mcpToolToOpenAI(tool, serverKey, cloudIdState);
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

                // Build lightweight catalog entry for tool search
                const paramNames = Object.keys(openAiTool.function?.parameters?.properties || {});
                mcpToolCatalog[compositeKey] = {
                    name: compositeKey,
                    originalName: tool.name,
                    server: serverKey,
                    description: openAiTool.function.description || '',
                    parameters: paramNames,
                };
            }
        } catch (error) {
            logger.warn(`Failed to list tools from MCP server ${serverKey}: ${error?.message || error}`);
        }
    }

    return { entityTools, entityToolsOpenAiFormat, toolToServerMap, mcpToolCatalog };
}

/**
 * Call a tool on an MCP server.
 * @param {Map<string, { client: Client }>} clients
 * @param {string} compositeToolName - e.g. "atlassian__toolname" (lowercased)
 * @param {Object} args - Tool arguments
 * @param {string} [originalToolName] - Original case-preserved tool name for MCP servers that are case-sensitive
 * @returns {Promise<{ result: string|Object, toolImages?: Array }>}
 */
export async function callMcpTool(clients, compositeToolName, args, originalToolName) {
    const parts = compositeToolName.split('__');
    if (parts.length < 2) {
        throw new Error(`Invalid MCP tool name: ${compositeToolName}`);
    }
    const serverKey = parts[0];
    // Use the original case-preserved name if provided, otherwise fall back to extracting from composite key
    const toolName = originalToolName || parts.slice(1).join('__');

    const entry = clients.get(serverKey);
    if (!entry) {
        throw new Error(`MCP server ${serverKey} not connected`);
    }

    const { client, connectTimestamp, cloudId } = entry;
    const transportState = client.transport ? 'alive' : 'null';

    // Inject stored cloudId — always overrides AI-provided value to prevent hallucination.
    // When cloudId is null (multi-site, user must choose), the AI's value passes through.
    const finalArgs = { ...(args || {}) };
    if (cloudId) {
        finalArgs.cloudId = cloudId;
        logger.info(`[MCP:${serverKey}] injecting cloudId=${cloudId} into tool ${toolName} args`);
    }

    logger.info(`[MCP:${serverKey}] calling tool ${toolName} | args=${JSON.stringify(finalArgs).slice(0, 200)} | transport=${transportState} | age=${Date.now() - (connectTimestamp || 0)}ms`);

    try {
        const callStart = Date.now();
        const result = await client.callTool({
            name: toolName,
            arguments: finalArgs,
        });
        const content = result?.content || [];
        const textParts = content
            .filter((c) => c.type === 'text')
            .map((c) => c.text);
        const text = textParts.join('\n\n');
        const isError = result?.isError || text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');
        logger.info(`[MCP:${serverKey}] tool ${toolName} returned in ${Date.now() - callStart}ms | contentTypes=${content.map(c => c.type).join(',')} | isError=${isError} | resultText=${text.slice(0, 500)}`);

        if (result?.structuredContent) {
            return { result: result.structuredContent };
        }
        return { result: text || JSON.stringify(result) };
    } catch (error) {
        const transportStateAfter = client.transport ? 'alive' : 'null';
        logger.error(`[MCP:${serverKey}] tool call FAILED ${toolName} | error=${error?.message || error} | code=${error?.code} | transport=${transportStateAfter} | age=${Date.now() - (connectTimestamp || 0)}ms`);
        throw error;
    }
}

/**
 * Close all MCP client connections.
 * @param {Map<string, { client: Client, transport: StreamableHTTPClientTransport }>} clients
 */
export async function closeMcpClients(clients) {
    for (const [serverKey, { transport, connectTimestamp }] of clients) {
        try {
            logger.info(`[MCP:${serverKey}] closing (age=${Date.now() - (connectTimestamp || 0)}ms)`);
            await transport.close();
            logger.info(`[MCP:${serverKey}] closed`);
        } catch (error) {
            logger.warn(`Error closing MCP client ${serverKey}: ${error?.message || error}`);
        }
    }
    clients.clear();
}
