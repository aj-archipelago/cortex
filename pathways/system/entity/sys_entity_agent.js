// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const TOOL_BUDGET = 500;
const DEFAULT_TOOL_COST = 10;
const MAX_TOOL_CALLBACK_ITERATIONS = 75; // Hard cap on tool callback iterations (includes post-limit retries)
const TOOL_TIMEOUT_MS = 120000; // 2 minute timeout per tool call
const MAX_TOOL_RESULT_LENGTH = 50000; // Truncate oversized tool results to prevent context overflow
const TOOL_RESULT_ENVELOPE_HEADROOM_CHARS = 2048;
const TOOL_RESULT_DETAILED_INLINE_MAX = MAX_TOOL_RESULT_LENGTH - TOOL_RESULT_ENVELOPE_HEADROOM_CHARS;
const TOOL_RESULT_TRUNCATION_SUFFIX = '\n\n[Content truncated due to length]';
const MAX_DUPLICATE_TOOL_CALLS = 2; // Max times identical tool call can execute before returning cached result
const TOOL_RESULT_PREVIEW_CHARS = 1200;
const TOOL_RESULT_INLINE_MAX = 4000;
const TOOL_RESULT_KEEP_FULL_RECENT_ON_PRESSURE = 8;
const TOOL_RESULT_KEEP_FAILURES = 2;
const TOOL_RESULT_MIN_COMPACT_CHARS = 600; // Below this, compaction grows the message — leave it alone
const TOOL_RESULT_COMPACTION_ENABLED = process.env.CORTEX_TOOL_RESULT_COMPACTION !== 'false';
const TOOL_RESULT_COMPACTION_CONTEXT_RATIO = parseBoundedFloat(process.env.CORTEX_TOOL_RESULT_COMPACTION_CONTEXT_RATIO, 0.7, 0.1, 0.95);
const TOOL_RESULT_COMPACTION_GROWTH_RATIO = parseBoundedFloat(process.env.CORTEX_TOOL_RESULT_COMPACTION_GROWTH_RATIO, 0.08, 0.01, 0.5);
const TOOL_RESULT_COMPACTION_MIN_GROWTH_TOKENS = 2000;
const TOOL_RESULT_COMPACT_PREVIEW_CHARS = 320;
const TOOL_RESULT_COMPACT_COMMAND_CHARS = 260;
const TOOL_RESULT_PROMPT_OVERHEAD_TOKENS = parsePositiveInt(process.env.CORTEX_TOOL_RESULT_PROMPT_OVERHEAD_TOKENS, 6000);
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;

import { callPathway, callTool, say, sendToolStart, sendToolFinish, withTimeout } from '../../../lib/pathwayTools.js';
import { publishRequestProgress } from '../../../lib/redisSubscription.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { syncAndStripFilesFromChatHistory } from '../../../lib/fileUtils.js';
import { Prompt } from '../../../server/prompt.js';
import {
    buildLocalToolCatalog,
    getAlwaysVisibleLocalToolDefinitions,
    getToolsForEntity,
    loadEntityConfig,
    resolveExplicitEntityConfig,
} from './tools/shared/sys_entity_tools.js';
import { registerRequestScopedTools } from './tools/shared/request_scoped_tools.js';
import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import CortexResponse from '../../../lib/cortexResponse.js';
import { initializeMcpClients, discoverMcpTools, closeMcpClients, isTokenExpired } from '../../../lib/mcpClient.js';
import { drainPendingMessages, hasPendingMessages, clearPendingMessages } from '../../../server/pendingUserMessages.js';
import { normalizeUsage } from '../../../server/rest/restUtils.js';
import latencyTrace from '../../../lib/latencyTrace.js';

function parseBoundedFloat(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Helper function to generate a smart error response using the agent
async function generateErrorResponse(error, args, pathwayResolver) {
    const errorMessage = error?.message || error?.toString() || String(error);
    
    // Clear any accumulated errors since we're handling them intelligently
    pathwayResolver.errors = [];
    
    // Use sys_generator_error to create a smart response
    try {
        const errorResponse = await callPathway('sys_generator_error', {
            ...args,
            text: errorMessage,
            chatHistory: args.chatHistory || [],
            stream: false
        }, pathwayResolver);
        
        return errorResponse;
    } catch (errorResponseError) {
        // Fallback if sys_generator_error itself fails
        logger.error(`Error generating error response: ${errorResponseError.message}`);
        return `I apologize, but I encountered an error while processing your request: ${errorMessage}. Please try again or contact support if the issue persists.`;
    }
}

// Helper function to insert a system message, removing any existing ones first
function insertSystemMessage(messages, text, requestId = null) {
    // Create a unique marker to avoid collisions with legitimate content
    const marker = requestId ? `[system message: ${requestId}]` : '[system message]';
    
    // Remove any existing challenge messages with this specific requestId to avoid spamming the model
    const filteredMessages = messages.filter(msg => {
        if (msg.role !== 'user') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return !content.startsWith(marker);
    });
    
    // Insert the new system message
    filteredMessages.push({
        role: "user",
        content: `${marker} ${text}`
    });
    
    return filteredMessages;
}

function isResolverCanceled(resolver) {
    return typeof resolver?.isCanceled === 'function' ? resolver.isCanceled() : false;
}

function safeJsonParse(value) {
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function hasOpenAiToolSchema(entityToolsOpenAiFormat, toolName) {
    if (!Array.isArray(entityToolsOpenAiFormat) || !toolName) return false;
    return entityToolsOpenAiFormat.some(tool =>
        typeof tool?.function?.name === 'string' &&
        tool.function.name.toLowerCase() === toolName.toLowerCase()
    );
}

function extractNewMcpConfigFromToolResult(toolResult) {
    const result = toolResult?.result;
    const parsed = typeof result === 'string'
        ? safeJsonParse(result)
        : result && typeof result === 'object'
            ? result
            : null;
    const newMcpConfig = parsed?.newMcpConfig;
    if (!newMcpConfig || typeof newMcpConfig !== 'object' || Array.isArray(newMcpConfig)) {
        return null;
    }
    return Object.keys(newMcpConfig).length > 0 ? newMcpConfig : null;
}

const SENSITIVE_MCP_CONFIG_KEYS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'access_token',
    'refresh_token',
    'id_token',
    'token',
    'apikey',
    'api_key',
    'secret',
    'password',
    'clientsecret',
    'client_secret',
]);

function redactSensitiveMcpConfigValue(value, key = '') {
    if (SENSITIVE_MCP_CONFIG_KEYS.has(String(key).toLowerCase())) {
        return '[REDACTED]';
    }
    if (Array.isArray(value)) {
        return value.map(item => redactSensitiveMcpConfigValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                redactSensitiveMcpConfigValue(entryValue, entryKey),
            ])
        );
    }
    return value;
}

function redactNewMcpConfigInToolResult(toolResult) {
    const result = toolResult?.result;
    const parsed = typeof result === 'string'
        ? safeJsonParse(result)
        : result && typeof result === 'object'
            ? result
            : null;

    if (!parsed?.newMcpConfig || typeof parsed.newMcpConfig !== 'object' || Array.isArray(parsed.newMcpConfig)) {
        return toolResult;
    }

    const redacted = {
        ...parsed,
        newMcpConfig: redactSensitiveMcpConfigValue(parsed.newMcpConfig),
    };

    if (typeof result === 'string') {
        toolResult.result = JSON.stringify(redacted);
    } else {
        toolResult.result = redacted;
    }

    return toolResult;
}

function parseMcpConfigValue(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'string') {
        return safeJsonParse(value) || fallback;
    }
    if (typeof value === 'object') {
        return value;
    }
    return fallback;
}

function normalizeMcpUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        return new URL(url).href;
    } catch {
        return null;
    }
}

function getAvailableMcpServerConfig(mcpAvailableServers, serverKey) {
    const availableServers = parseMcpConfigValue(mcpAvailableServers, []);
    if (Array.isArray(availableServers)) {
        return availableServers.find(server => (
            server?.id === serverKey ||
            server?.serverKey === serverKey ||
            server?.key === serverKey ||
            server?.name === serverKey
        )) || null;
    }
    if (availableServers && typeof availableServers === 'object') {
        return availableServers[serverKey] || null;
    }
    return null;
}

function getApprovedMcpServerConfig({ args = {}, serverKey }) {
    const existingConfig = parseMcpConfigValue(args.mcpConfig, {});
    const existingServerConfig = existingConfig?.[serverKey];
    if (existingServerConfig && isTokenExpired(existingServerConfig)) {
        return { serverKey, serverConfig: existingServerConfig, source: 'expired-config' };
    }

    const availableServerConfig = getAvailableMcpServerConfig(args.mcpAvailableServers, serverKey);
    if (availableServerConfig) {
        return { serverKey, serverConfig: availableServerConfig, source: 'available-servers' };
    }

    return null;
}

function pickMcpServerUrl(serverConfig) {
    return serverConfig?.url || serverConfig?.mcpUrl || serverConfig?.endpoint || serverConfig?.serverUrl || null;
}

function validateClientProvidedMcpConfig({ newMcpConfig, args = {}, requestedServerKey }) {
    if (!newMcpConfig || typeof newMcpConfig !== 'object' || Array.isArray(newMcpConfig)) {
        return { valid: false, reason: 'missing MCP config' };
    }

    const configEntries = Object.entries(newMcpConfig);
    if (configEntries.length === 0) {
        return { valid: false, reason: 'empty MCP config' };
    }

    const serverKey = requestedServerKey || (configEntries.length === 1 ? configEntries[0][0] : null);
    if (!serverKey) {
        return { valid: false, reason: 'missing requested server key' };
    }

    const serverConfig = newMcpConfig[serverKey];
    if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
        return { valid: false, reason: `MCP config did not include requested server ${serverKey}` };
    }

    const approved = getApprovedMcpServerConfig({ args, serverKey });
    if (!approved) {
        return { valid: false, reason: `server ${serverKey} was not approved for this request` };
    }

    const approvedUrl = normalizeMcpUrl(pickMcpServerUrl(approved.serverConfig));
    const returnedUrl = normalizeMcpUrl(serverConfig.url);
    if (!approvedUrl || !returnedUrl || approvedUrl !== returnedUrl) {
        return { valid: false, reason: `server ${serverKey} returned an unapproved MCP URL` };
    }

    const approvedType = approved.serverConfig.type || 'streamable-http';
    const returnedType = serverConfig.type || 'streamable-http';
    if (approvedType !== returnedType) {
        return { valid: false, reason: `server ${serverKey} returned an unapproved MCP transport type` };
    }

    return {
        valid: true,
        config: { [serverKey]: serverConfig },
        serverKey,
        source: approved.source,
    };
}

async function applyNewMcpConfigToResolver({
    newMcpConfig,
    args,
    pathwayResolver,
    requestedServerKey,
    initializeClients = initializeMcpClients,
    discoverTools = discoverMcpTools,
    closeClients = closeMcpClients,
}) {
    if (!newMcpConfig || typeof newMcpConfig !== 'object' || Array.isArray(newMcpConfig)) {
        return { applied: false, loadedToolCount: 0 };
    }

    const validation = validateClientProvidedMcpConfig({ newMcpConfig, args, requestedServerKey });
    if (!validation.valid) {
        logger.warn(`Rejected client-provided MCP config update: ${validation.reason}`);
        return { applied: false, loadedToolCount: 0, rejected: true, reason: validation.reason };
    }

    const { clients: nextClients, expiredServers = [] } = await initializeClients(JSON.stringify(validation.config));
    if (!nextClients || nextClients.size === 0) {
        logger.warn(`No MCP clients initialized from client-side config update${expiredServers.length ? `; expired servers: ${expiredServers.join(', ')}` : ''}`);
        return { applied: false, loadedToolCount: 0, expiredServers };
    }

    const mcpClients = args.mcpClients instanceof Map ? args.mcpClients : new Map();
    for (const [serverKey, clientEntry] of nextClients) {
        if (mcpClients.has(serverKey)) {
            await closeClients(new Map([[serverKey, mcpClients.get(serverKey)]]));
            mcpClients.delete(serverKey);
        }
        mcpClients.set(serverKey, clientEntry);
    }

    const {
        entityTools: discoveredTools = {},
        entityToolsOpenAiFormat: discoveredOpenAiTools = [],
        mcpToolCatalog: discoveredCatalog = {},
    } = await discoverTools(nextClients);

    args.mcpClients = mcpClients;
    args.mcpToolCatalog = {
        ...(args.mcpToolCatalog || {}),
        ...discoveredCatalog,
    };
    args.mcpEntityToolsDeferred = {
        ...(args.mcpEntityToolsDeferred || {}),
        ...discoveredTools,
    };
    args.entityTools = args.entityTools || {};
    args.entityToolsOpenAiFormat = args.entityToolsOpenAiFormat || [];

    for (const [toolKey, toolEntry] of Object.entries(discoveredTools)) {
        if (!args.entityTools[toolKey]) {
            args.entityTools[toolKey] = toolEntry;
        }
    }

    let loadedToolCount = 0;
    for (const tool of discoveredOpenAiTools) {
        const toolName = tool?.function?.name;
        if (toolName && !hasOpenAiToolSchema(args.entityToolsOpenAiFormat, toolName)) {
            args.entityToolsOpenAiFormat.push(tool);
            loadedToolCount++;
        }
    }

    if (pathwayResolver) {
        pathwayResolver.args = {
            ...(pathwayResolver.args || {}),
            mcpClients,
            mcpToolCatalog: args.mcpToolCatalog,
            mcpEntityToolsDeferred: args.mcpEntityToolsDeferred,
            entityTools: args.entityTools,
            entityToolsOpenAiFormat: args.entityToolsOpenAiFormat,
        };
    }

    logger.info(`Hot-loaded MCP config for ${[...nextClients.keys()].join(', ')}; loaded ${loadedToolCount} tool schema(s)`);
    return {
        applied: true,
        loadedToolCount,
        serverKeys: [...nextClients.keys()],
    };
}

function stringifyToolValue(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function previewText(text, maxChars = TOOL_RESULT_PREVIEW_CHARS) {
    if (!text) return { text: '', truncated: false };
    if (text.length <= maxChars) return { text, truncated: false };
    return {
        text: text.slice(0, maxChars) + '\n...[preview truncated]',
        truncated: true,
    };
}

function previewInlineValue(value, maxChars) {
    const text = stringifyToolValue(value).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function extractWorkspacePaths(command) {
    if (typeof command !== 'string' || !command) return [];
    const matches = command.match(/\/workspace\/[^\s'"`;)]+/g) || [];
    return [...new Set(matches.map(path => path.replace(/[,:]+$/, '')))].slice(0, 3);
}

function ensureToolResultArtifactStore(pathwayResolver) {
    if (!pathwayResolver._toolResultArtifacts) {
        pathwayResolver._toolResultArtifacts = new Map();
    }
    return pathwayResolver._toolResultArtifacts;
}

function ensureToolResultSnapshotStore(pathwayResolver) {
    if (!pathwayResolver._toolResultSnapshots) {
        pathwayResolver._toolResultSnapshots = new Map();
    }
    return pathwayResolver._toolResultSnapshots;
}

function nextToolResultRef(pathwayResolver) {
    pathwayResolver._toolResultRefCounter = (pathwayResolver._toolResultRefCounter || 0) + 1;
    return `tr_${pathwayResolver._toolResultRefCounter}`;
}

function rememberToolResultSnapshot(pathwayResolver, resultRef, content) {
    if (!pathwayResolver || !resultRef || typeof content !== 'string' || !content) {
        return;
    }

    const store = ensureToolResultSnapshotStore(pathwayResolver);
    store.set(resultRef, {
        content,
        createdAt: Date.now(),
        length: content.length,
    });
}

function buildToolResultEnvelopeBase(pathwayResolver, toolFunction, options = {}) {
    return {
        _toolResultEnvelope: true,
        tool: toolFunction,
        resultRef: options.resultRef || nextToolResultRef(pathwayResolver),
        compacted: false,
    };
}

function artifactInlinePreviewIfPresent(payload, pathwayResolver, previewKey, artifactKey, totalKey) {
    const value = payload?.[previewKey];
    if (typeof value !== 'string' || !value) {
        return false;
    }
    if (payload[artifactKey]) {
        return false;
    }

    const artifact = storeToolResultArtifact(pathwayResolver, payload.tool, previewKey, value);
    if (!artifact?.artifactRef) {
        return false;
    }

    const preview = previewText(value, TOOL_RESULT_PREVIEW_CHARS);
    payload[previewKey] = preview.text;
    payload[artifactKey] = artifact.artifactRef;
    payload[totalKey] = payload[totalKey] || value.length;
    payload.compacted = true;
    return true;
}

function enforceSerializedEnvelopeLimit(payload, pathwayResolver) {
    if (JSON.stringify(payload).length <= MAX_TOOL_RESULT_LENGTH) {
        return payload;
    }

    let changed = false;
    changed = artifactInlinePreviewIfPresent(payload, pathwayResolver, 'stdoutPreview', 'stdoutArtifactRef', 'stdoutTotalChars') || changed;
    changed = artifactInlinePreviewIfPresent(payload, pathwayResolver, 'stderrPreview', 'stderrArtifactRef', 'stderrTotalChars') || changed;
    changed = artifactInlinePreviewIfPresent(payload, pathwayResolver, 'contentPreview', 'contentArtifactRef', 'contentTotalChars') || changed;

    if (changed && JSON.stringify(payload).length <= MAX_TOOL_RESULT_LENGTH) {
        return payload;
    }

    for (const key of ['stdoutPreview', 'stderrPreview', 'contentPreview']) {
        if (typeof payload[key] === 'string' && payload[key].length > TOOL_RESULT_COMPACT_PREVIEW_CHARS) {
            payload[key] = previewInlineValue(payload[key], TOOL_RESULT_COMPACT_PREVIEW_CHARS);
            changed = true;
        }
    }

    if (JSON.stringify(payload).length > MAX_TOOL_RESULT_LENGTH) {
        return {
            _toolResultEnvelope: true,
            tool: payload.tool,
            resultRef: payload.resultRef,
            kind: payload.kind,
            summary: payload.summary || 'Tool result stored out of band',
            status: payload.status,
            success: payload.success,
            exitCode: payload.exitCode,
            stdoutTotalChars: payload.stdoutTotalChars,
            stderrTotalChars: payload.stderrTotalChars,
            contentTotalChars: payload.contentTotalChars,
            artifactRefs: [...collectArtifactRefs(payload)],
            compacted: true,
            note: 'Result detail is available via InspectToolResult.',
        };
    }

    return payload;
}

function finalizeToolResultEnvelope(payload, pathwayResolver, snapshotPayload = null) {
    const safePayload = enforceSerializedEnvelopeLimit(payload, pathwayResolver);
    const content = JSON.stringify(safePayload);
    rememberToolResultSnapshot(
        pathwayResolver,
        safePayload.resultRef,
        JSON.stringify(snapshotPayload || payload),
    );
    return content;
}

function storeToolResultArtifact(pathwayResolver, toolFunction, label, content) {
    const text = stringifyToolValue(content);
    if (!text) return null;

    const store = ensureToolResultArtifactStore(pathwayResolver);
    pathwayResolver._toolResultArtifactCounter = (pathwayResolver._toolResultArtifactCounter || 0) + 1;
    const artifactRef = `tra_${pathwayResolver._toolResultArtifactCounter}`;
    store.set(artifactRef, {
        toolFunction,
        label,
        content: text,
        createdAt: Date.now(),
        length: text.length,
    });
    return {
        artifactRef,
        length: text.length,
    };
}

function buildArtifactPreview(pathwayResolver, toolFunction, label, content, options = {}) {
    const text = stringifyToolValue(content);
    if (!text) {
        return {
            preview: '',
            truncated: false,
            artifactRef: null,
            totalChars: 0,
        };
    }

    const maxInlineChars = options.maxInlineChars || TOOL_RESULT_INLINE_MAX;
    const preview = previewText(text, options.previewChars || TOOL_RESULT_PREVIEW_CHARS);
    if (text.length <= maxInlineChars) {
        return {
            preview: text,
            truncated: false,
            artifactRef: null,
            totalChars: text.length,
        };
    }

    const artifact = storeToolResultArtifact(pathwayResolver, toolFunction, label, text);
    return {
        preview: preview.text,
        truncated: preview.truncated,
        artifactRef: artifact?.artifactRef || null,
        totalChars: text.length,
    };
}

function summarizeWorkspaceEnvelope(payload) {
    const stdoutChars = payload.stdoutTotalChars || 0;
    const stderrChars = payload.stderrTotalChars || 0;
    const status = payload.status || (payload.success ? 'succeeded' : 'failed');
    return `Workspace command ${status}; stdout ${stdoutChars} chars, stderr ${stderrChars} chars`;
}

function shapeWorkspaceToolResult(rawResult, pathwayResolver, toolFunction, options = {}) {
    if (!rawResult || typeof rawResult !== 'object') {
        return null;
    }

    const payload = buildToolResultEnvelopeBase(pathwayResolver, toolFunction, options);
    const snapshotPayload = { ...payload };

    const passthrough = ['success', 'status', 'processId', 'exitCode', 'durationMs',
        'killed', 'truncated', 'error', 'hint', 'message', 'newFiles', 'displayMarkdown'];
    for (const key of passthrough) {
        payload[key] = rawResult[key];
        snapshotPayload[key] = rawResult[key];
    }
    payload.kind = 'workspace-shell';
    snapshotPayload.kind = 'workspace-shell';
    if (options.toolArgs?.command) {
        payload.command = previewInlineValue(options.toolArgs.command, TOOL_RESULT_COMPACT_COMMAND_CHARS);
        payload.paths = extractWorkspacePaths(options.toolArgs.command);
        snapshotPayload.command = payload.command;
        snapshotPayload.paths = payload.paths;
    }

    const stdout = buildArtifactPreview(pathwayResolver, toolFunction, 'stdout', rawResult.stdout, {
        maxInlineChars: TOOL_RESULT_DETAILED_INLINE_MAX,
    });
    if (stdout.preview) payload.stdoutPreview = stdout.preview;
    if (stdout.artifactRef) payload.stdoutArtifactRef = stdout.artifactRef;
    payload.stdoutTotalChars = stdout.totalChars;
    if (rawResult.stdout) snapshotPayload.stdoutPreview = rawResult.stdout;
    snapshotPayload.stdoutTotalChars = stdout.totalChars;

    const stderr = buildArtifactPreview(pathwayResolver, toolFunction, 'stderr', rawResult.stderr, {
        maxInlineChars: TOOL_RESULT_DETAILED_INLINE_MAX,
    });
    if (stderr.preview) payload.stderrPreview = stderr.preview;
    if (stderr.artifactRef) payload.stderrArtifactRef = stderr.artifactRef;
    payload.stderrTotalChars = stderr.totalChars;
    if (rawResult.stderr) snapshotPayload.stderrPreview = rawResult.stderr;
    snapshotPayload.stderrTotalChars = stderr.totalChars;

    payload.summary = summarizeWorkspaceEnvelope(payload);
    snapshotPayload.summary = summarizeWorkspaceEnvelope(snapshotPayload);

    if (stdout.truncated || stderr.truncated) {
        payload.compacted = true;
    }

    return finalizeToolResultEnvelope(payload, pathwayResolver, snapshotPayload);
}

function shapeGenericToolResult(rawContent, pathwayResolver, toolFunction, options = {}) {
    if (!rawContent) {
        return rawContent;
    }

    if (rawContent.length <= TOOL_RESULT_INLINE_MAX) {
        return rawContent;
    }

    const contentPreview = buildArtifactPreview(pathwayResolver, toolFunction, 'content', rawContent, {
        previewChars: TOOL_RESULT_PREVIEW_CHARS,
        maxInlineChars: TOOL_RESULT_DETAILED_INLINE_MAX,
    });

    const payload = {
        ...buildToolResultEnvelopeBase(pathwayResolver, toolFunction, options),
        kind: 'generic',
        summary: `Tool output stored out of band (${contentPreview.totalChars} chars)`,
        contentPreview: contentPreview.preview,
        contentArtifactRef: contentPreview.artifactRef,
        contentTotalChars: contentPreview.totalChars,
    };

    const snapshotPayload = {
        ...payload,
        contentPreview: rawContent,
        contentArtifactRef: null,
        compacted: false,
    };

    if (contentPreview.truncated) {
        payload.compacted = true;
    }

    return finalizeToolResultEnvelope(payload, pathwayResolver, snapshotPayload);
}

function buildToolResultContent(toolResult, pathwayResolver, toolFunction, options = {}) {
    const rawContent = typeof toolResult === 'string'
        ? toolResult
        : typeof toolResult?.result === 'string'
            ? toolResult.result
            : toolResult?.result !== undefined
                ? stringifyToolValue(toolResult.result)
                : stringifyToolValue(toolResult);

    if (!TOOL_RESULT_COMPACTION_ENABLED) return rawContent;
    if (options.allowResultCompaction === false) return rawContent;

    const parsed = safeJsonParse(rawContent);
    const looksLikeWorkspacePayload = parsed && typeof parsed === 'object' && (
        toolFunction === 'workspacessh' ||
        Object.prototype.hasOwnProperty.call(parsed, 'stdout') ||
        Object.prototype.hasOwnProperty.call(parsed, 'stderr')
    );

    if (looksLikeWorkspacePayload) {
        return shapeWorkspaceToolResult(parsed, pathwayResolver, toolFunction, options) || rawContent;
    }

    return shapeGenericToolResult(rawContent, pathwayResolver, toolFunction, options);
}

function collectArtifactRefs(value, refs = new Set()) {
    if (!value) return refs;
    if (Array.isArray(value)) {
        value.forEach(item => collectArtifactRefs(item, refs));
        return refs;
    }
    if (typeof value !== 'object') return refs;

    Object.entries(value).forEach(([key, item]) => {
        if (key.endsWith('ArtifactRef') && typeof item === 'string') {
            refs.add(item);
            return;
        }
        collectArtifactRefs(item, refs);
    });

    return refs;
}

function maybeStoreEnvelopeArtifact(parsed, pathwayResolver, previewKey, artifactKey, totalKey, label) {
    if (!parsed || parsed[artifactKey] || typeof parsed[previewKey] !== 'string' || !parsed[previewKey]) {
        return null;
    }

    const artifact = storeToolResultArtifact(pathwayResolver, parsed.tool || 'tool', label, parsed[previewKey]);
    if (!artifact) {
        return null;
    }

    parsed[artifactKey] = artifact.artifactRef;
    if (!parsed[totalKey]) {
        parsed[totalKey] = artifact.length;
    }
    return artifact.artifactRef;
}

function ensureEnvelopeArtifactRefs(parsed, pathwayResolver) {
    if (!parsed || !pathwayResolver) return parsed;

    maybeStoreEnvelopeArtifact(parsed, pathwayResolver, 'stdoutPreview', 'stdoutArtifactRef', 'stdoutTotalChars', 'stdout');
    maybeStoreEnvelopeArtifact(parsed, pathwayResolver, 'stderrPreview', 'stderrArtifactRef', 'stderrTotalChars', 'stderr');
    maybeStoreEnvelopeArtifact(parsed, pathwayResolver, 'contentPreview', 'contentArtifactRef', 'contentTotalChars', 'content');

    return parsed;
}

function buildCompactedToolPreview(parsed) {
    if (!parsed || typeof parsed !== 'object') return '';
    const source = parsed.stdoutPreview || parsed.contentPreview || parsed.stderrPreview || '';
    return previewInlineValue(source, TOOL_RESULT_COMPACT_PREVIEW_CHARS);
}

function compactToolMessageContent(content, pathwayResolver) {
    if (content.length < TOOL_RESULT_MIN_COMPACT_CHARS * 1.1) return content;
    const parsed = safeJsonParse(content);
    if (!parsed || !parsed._toolResultEnvelope) {
        return content;
    }
    if (parsed.compacted === true) {
        return content;
    }

    ensureEnvelopeArtifactRefs(parsed, pathwayResolver);
    const compacted = {
        _toolResultEnvelope: true,
        tool: parsed.tool,
        resultRef: parsed.resultRef,
        kind: parsed.kind,
        success: parsed.success,
        status: parsed.status,
        exitCode: parsed.exitCode,
        summary: parsed.summary,
        artifactRefs: [...collectArtifactRefs(parsed)],
        compacted: true,
    };
    if (parsed.command) compacted.command = parsed.command;
    if (Array.isArray(parsed.paths) && parsed.paths.length > 0) compacted.paths = parsed.paths.slice(0, 3);
    const compactPreview = buildCompactedToolPreview(parsed);
    if (compactPreview) compacted.preview = compactPreview;
    for (const key of ['stdoutTotalChars', 'stderrTotalChars', 'contentTotalChars']) {
        if (typeof parsed[key] === 'number') compacted[key] = parsed[key];
    }
    return JSON.stringify(compacted);
}

function compactOversizedToolHistoryContent(message, pathwayResolver) {
    const content = message?.content;
    if (typeof content !== 'string' || content.length <= MAX_TOOL_RESULT_LENGTH) {
        return content;
    }
    if (content.endsWith(TOOL_RESULT_TRUNCATION_SUFFIX)) {
        return content; // legacy already-truncated message
    }

    const compactedContent = compactToolMessageContent(content, pathwayResolver);
    if (typeof compactedContent === 'string' && compactedContent.length <= MAX_TOOL_RESULT_LENGTH) {
        return compactedContent;
    }

    const parsed = safeJsonParse(content);
    const tool = parsed?._toolResultEnvelope
        ? parsed.tool
        : (message?.name || 'unknown tool').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
    const resultRef = parsed?.resultRef || nextToolResultRef(pathwayResolver);
    const preview = previewText(content, TOOL_RESULT_PREVIEW_CHARS);
    const artifact = storeToolResultArtifact(pathwayResolver, tool, 'content', content);

    if (!parsed?._toolResultEnvelope) {
        rememberToolResultSnapshot(pathwayResolver, resultRef, JSON.stringify({
            _toolResultEnvelope: true,
            tool,
            resultRef,
            kind: 'generic',
            summary: `Oversized tool result stored out of band (${content.length} chars)`,
            contentPreview: content,
            contentArtifactRef: null,
            contentTotalChars: content.length,
            compacted: false,
        }));
    }

    const fallback = {
        _toolResultEnvelope: true,
        tool,
        resultRef,
        kind: parsed?.kind || 'generic',
        summary: parsed?.summary || `Oversized tool result stored out of band (${content.length} chars)`,
        contentPreview: preview.text,
        contentArtifactRef: artifact?.artifactRef || parsed?.contentArtifactRef || null,
        contentTotalChars: parsed?.contentTotalChars || content.length,
        artifactRefs: parsed ? [...collectArtifactRefs(parsed)] : undefined,
        compacted: true,
        note: 'Result detail is available via InspectToolResult.',
    };

    const fallbackContent = JSON.stringify(fallback);
    if (fallbackContent.length <= MAX_TOOL_RESULT_LENGTH) {
        return fallbackContent;
    }

    return JSON.stringify({
        _toolResultEnvelope: true,
        tool,
        resultRef,
        kind: fallback.kind,
        summary: fallback.summary,
        contentTotalChars: fallback.contentTotalChars,
        compacted: true,
        note: 'Result detail is available via InspectToolResult.',
    });
}

function isFailedToolMessage(message) {
    if (message?.role !== 'tool' || typeof message?.content !== 'string') {
        return false;
    }

    const parsed = safeJsonParse(message.content);
    if (!parsed || !parsed._toolResultEnvelope) {
        return false;
    }

    if (parsed.success === false) {
        return true;
    }

    return parsed.status === 'failed' || parsed.status === 'error';
}

function estimateTokensFromText(text) {
    if (!text) return 0;
    let asciiChars = 0;
    let nonAsciiChars = 0;
    let denseScriptChars = 0;
    let emojiChars = 0;

    for (const char of String(text)) {
        const codePoint = char.codePointAt(0);
        if (codePoint <= 0x7f) {
            asciiChars += 1;
        } else {
            nonAsciiChars += 1;
            if (
                (codePoint >= 0x0600 && codePoint <= 0x06ff) || // Arabic
                (codePoint >= 0x0750 && codePoint <= 0x077f) ||
                (codePoint >= 0x08a0 && codePoint <= 0x08ff) ||
                (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK
                (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
                (codePoint >= 0xac00 && codePoint <= 0xd7af)
            ) {
                denseScriptChars += 1;
            } else if (codePoint >= 0x1f300 && codePoint <= 0x1faff) {
                emojiChars += 1;
            }
        }
    }

    return Math.ceil(
        (asciiChars / 4) +
        denseScriptChars +
        emojiChars * 2 +
        ((nonAsciiChars - denseScriptChars - emojiChars) / 2),
    );
}

function estimateMessagesTokens(messages) {
    return Array.isArray(messages)
        ? messages.reduce((sum, msg) => {
            if (!msg) return sum;
            if (typeof msg.content === 'string') return sum + estimateTokensFromText(msg.content) + 10;
            return sum + estimateTokensFromText(stringifyToolValue(msg)) + 10;
        }, 0)
        : 0;
}

function estimateMessageFootprint(messages, limit = null) {
    if (!Array.isArray(messages)) return 0;
    const end = limit == null ? messages.length : Math.min(limit, messages.length);
    let footprint = 0;
    for (let index = 0; index < end; index += 1) {
        const msg = messages[index];
        if (!msg) continue;
        footprint += typeof msg.role === 'string' ? msg.role.length : 0;
        footprint += typeof msg.name === 'string' ? msg.name.length : 0;
        footprint += typeof msg.tool_call_id === 'string' ? msg.tool_call_id.length : 0;
        if (typeof msg.content === 'string') {
            footprint += msg.content.length;
        } else if (msg.content != null) {
            footprint += stringifyToolValue(msg.content).length;
        }
        if (msg.tool_calls) {
            footprint += stringifyToolValue(msg.tool_calls).length;
        }
    }
    return footprint;
}

function getToolSchemaSignature(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return 'none';
    const names = tools
        .map(tool => tool?.function?.name || tool?.name || '')
        .join(',');
    return `${tools.length}:${names}:${estimateTextSignature(stringifyToolValue(tools))}`;
}

function estimateTextSignature(value) {
    if (value == null || value === '') return '0:0:0';
    const text = typeof value === 'string' ? value : stringifyToolValue(value);
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
    }
    return `${text.length}:${estimateTokensFromText(text)}:${hash.toString(36)}`;
}

function normalizePromptOption(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return stringifyToolValue(value);
}

function getPromptInputSignature(pathwayResolver = null, options = {}) {
    const useMemory = options.useMemory === false ? false : options.useMemory === true ? true : null;
    const memoryFields = useMemory === false ? {} : {
        memorySelf: estimateTextSignature(pathwayResolver?.memorySelf),
        memoryDirectives: estimateTextSignature(pathwayResolver?.memoryDirectives),
        memoryTopics: estimateTextSignature(pathwayResolver?.memoryTopics),
        memoryUser: estimateTextSignature(pathwayResolver?.memoryUser),
        memoryContext: estimateTextSignature(pathwayResolver?.memoryContext),
    };

    const signature = {
        systemPrompt: estimateTextSignature(options.systemPrompt),
        entityInstructions: estimateTextSignature(options.entityInstructions),
        useMemory: useMemory === null ? 'unknown' : String(useMemory),
        ...memoryFields,
        reasoningEffort: normalizePromptOption(options.reasoningEffort),
        toolChoice: normalizePromptOption(options.tool_choice ?? options.toolChoice),
        voiceResponse: normalizePromptOption(options.voiceResponse),
        language: normalizePromptOption(options.language),
        aiName: normalizePromptOption(options.aiName),
    };

    const hasPromptInput = Object.entries(signature).some(([key, value]) => {
        if (key === 'useMemory') return value !== 'unknown';
        return value && value !== '0:0:0';
    });
    return hasPromptInput ? JSON.stringify(signature) : 'none';
}

function estimatePromptInputTokens(pathwayResolver = null, options = {}) {
    let tokens = 0;
    for (const value of [options.systemPrompt, options.entityInstructions]) {
        if (value) tokens += estimateTokensFromText(typeof value === 'string' ? value : stringifyToolValue(value));
    }

    if (options.useMemory !== false) {
        for (const value of [
            pathwayResolver?.memorySelf,
            pathwayResolver?.memoryDirectives,
            pathwayResolver?.memoryTopics,
            pathwayResolver?.memoryUser,
            pathwayResolver?.memoryContext,
        ]) {
            if (value) tokens += estimateTokensFromText(value);
        }
    }

    return tokens;
}

function buildPromptUsageOptions(args = {}, tools, overrides = {}) {
    return {
        tools,
        systemPrompt: args.systemPrompt,
        entityInstructions: args.entityInstructions,
        useMemory: args.useMemory,
        reasoningEffort: args.reasoningEffort,
        tool_choice: args.tool_choice,
        voiceResponse: args.voiceResponse,
        language: args.language,
        aiName: args.aiName,
        ...overrides,
    };
}

function estimatePromptOccupancyFromAnchor(messages, pathwayResolver = null, options = {}) {
    const anchor = pathwayResolver?._toolResultPromptTokenAnchor;
    if (!anchor || !Number.isFinite(anchor.inputTokens) || anchor.inputTokens <= 0) return null;
    if (!Array.isArray(messages) || messages.length < anchor.messageCount) return null;
    if (anchor.modelName && pathwayResolver?.modelName && anchor.modelName !== pathwayResolver.modelName) return null;
    if (anchor.toolSchemaSignature !== getToolSchemaSignature(options.tools)) return null;
    if ((anchor.promptInputSignature || 'none') !== getPromptInputSignature(pathwayResolver, options)) return null;
    if (estimateMessageFootprint(messages, anchor.messageCount) !== anchor.messageFootprint) return null;

    return anchor.inputTokens + estimateMessagesTokens(messages.slice(anchor.messageCount));
}

function estimatePromptOccupancyTokens(messages, pathwayResolver = null, options = {}) {
    const anchoredEstimate = estimatePromptOccupancyFromAnchor(messages, pathwayResolver, options);
    if (Number.isFinite(anchoredEstimate) && anchoredEstimate > 0) {
        return anchoredEstimate;
    }

    const messageTokens = estimateMessagesTokens(messages);
    const toolsTokens = Array.isArray(options.tools) && options.tools.length > 0
        ? estimateTokensFromText(stringifyToolValue(options.tools))
        : 0;
    const promptInputTokens = estimatePromptInputTokens(pathwayResolver, options);

    return TOOL_RESULT_PROMPT_OVERHEAD_TOKENS + messageTokens + toolsTokens + promptInputTokens;
}

function getLatestPathwayUsage(pathwayResolver) {
    const usage = pathwayResolver?.pathwayResultData?.usage;
    return Array.isArray(usage) ? usage[0] : usage;
}

function usageMarker(usage) {
    if (!usage) return '';
    try {
        return JSON.stringify(usage);
    } catch {
        return String(usage);
    }
}

function extractPromptUsageTokens(response, pathwayResolver = null, previousUsageMarker = '') {
    const directUsage = response instanceof CortexResponse
        ? response.usage
        : response?.usage;
    const normalizedDirect = normalizeUsage(directUsage);
    if (Number.isFinite(normalizedDirect?.input_tokens) && normalizedDirect.input_tokens > 0) {
        return normalizedDirect.input_tokens;
    }

    const latestUsage = getLatestPathwayUsage(pathwayResolver);
    if (latestUsage && usageMarker(latestUsage) !== previousUsageMarker) {
        const normalizedLatest = normalizeUsage(latestUsage);
        if (Number.isFinite(normalizedLatest?.input_tokens) && normalizedLatest.input_tokens > 0) {
            return normalizedLatest.input_tokens;
        }
    }

    return null;
}

function rememberPromptTokenUsage(pathwayResolver, messages, options = {}, response = null, previousUsageMarker = '') {
    if (!pathwayResolver || !Array.isArray(messages)) return;
    const inputTokens = extractPromptUsageTokens(response, pathwayResolver, previousUsageMarker);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;

    pathwayResolver._toolResultPromptTokenAnchor = {
        inputTokens,
        messageCount: messages.length,
        messageFootprint: estimateMessageFootprint(messages),
        toolSchemaSignature: getToolSchemaSignature(options.tools),
        promptInputSignature: getPromptInputSignature(pathwayResolver, options),
        modelName: pathwayResolver.modelName || null,
        capturedAt: Date.now(),
    };
}

function getModelPromptWindowTokens(pathwayResolver, options = {}) {
    if (Number.isFinite(options.maxPromptTokens) && options.maxPromptTokens > 0) {
        return options.maxPromptTokens;
    }
    try {
        const modelLimit = pathwayResolver?.modelExecutor?.plugin?.getModelMaxPromptTokens?.();
        if (Number.isFinite(modelLimit) && modelLimit > 0) return modelLimit;
    } catch {
        // Fall through to a conservative default.
    }
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function shouldCompactToolResults(messages, pathwayResolver = null, options = {}) {
    if (!TOOL_RESULT_COMPACTION_ENABLED) return { shouldCompact: false };
    if (!Array.isArray(messages) || messages.length === 0) return { shouldCompact: false };

    const maxPromptTokens = getModelPromptWindowTokens(pathwayResolver, options);
    const estimatedTokens = estimatePromptOccupancyTokens(messages, pathwayResolver, options);
    const softLimitTokens = Math.floor(maxPromptTokens * TOOL_RESULT_COMPACTION_CONTEXT_RATIO);
    if (estimatedTokens < softLimitTokens) {
        return { shouldCompact: false, estimatedTokens, softLimitTokens, maxPromptTokens };
    }

    const state = pathwayResolver?._toolResultCompactionState;
    if (state?.lastCompactedTokenEstimate) {
        const minGrowth = Math.max(
            TOOL_RESULT_COMPACTION_MIN_GROWTH_TOKENS,
            Math.floor(maxPromptTokens * TOOL_RESULT_COMPACTION_GROWTH_RATIO),
        );
        const messageGrowth = messages.length - (state.lastCompactedMessageCount || 0);
        if (
            estimatedTokens < state.lastCompactedTokenEstimate + minGrowth &&
            messageGrowth < TOOL_RESULT_KEEP_FULL_RECENT_ON_PRESSURE
        ) {
            return { shouldCompact: false, estimatedTokens, softLimitTokens, maxPromptTokens };
        }
    }

    return { shouldCompact: true, estimatedTokens, softLimitTokens, maxPromptTokens };
}

function rememberCompactionDecision(pathwayResolver, messages, decision, changed) {
    if (!pathwayResolver || !decision?.estimatedTokens) return;
    pathwayResolver._toolResultCompactionState = {
        lastCompactedAt: Date.now(),
        lastCompactedTokenEstimate: decision.estimatedTokens,
        lastCompactedMessageCount: Array.isArray(messages) ? messages.length : 0,
        softLimitTokens: decision.softLimitTokens,
        maxPromptTokens: decision.maxPromptTokens,
        changed,
    };
}

function compactHistoricalToolResults(messages, pathwayResolver = null, options = {}) {
    if (!TOOL_RESULT_COMPACTION_ENABLED) return messages;
    const decision = shouldCompactToolResults(messages, pathwayResolver, options);
    if (!decision.shouldCompact) return messages;

    const toolIndices = messages
        .map((msg, index) => msg.role === 'tool' ? index : -1)
        .filter(index => index >= 0);
    const recentFailureIndices = toolIndices
        .filter(index => isFailedToolMessage(messages[index]))
        .slice(-TOOL_RESULT_KEEP_FAILURES);
    const keepFull = new Set([
        ...toolIndices.slice(-TOOL_RESULT_KEEP_FULL_RECENT_ON_PRESSURE),
        ...recentFailureIndices,
    ]);

    let changed = false;
    const compactedMessages = messages.map((msg, index) => {
        if (msg.role !== 'tool' || typeof msg.content !== 'string' || keepFull.has(index)) {
            return msg;
        }

        const compactedContent = compactToolMessageContent(msg.content, pathwayResolver);
        if (compactedContent === msg.content) return msg;
        changed = true;
        return { ...msg, content: compactedContent };
    });

    rememberCompactionDecision(pathwayResolver, compactedMessages, decision, changed);
    if (changed) {
        logger.info(
            `Tool result compaction applied at estimated ${decision.estimatedTokens}/${decision.maxPromptTokens} prompt tokens ` +
            `(soft limit ${decision.softLimitTokens})`,
        );
    }
    return compactedMessages;
}

export {
    applyNewMcpConfigToResolver,
    buildToolResultContent,
    compactHistoricalToolResults,
    extractNewMcpConfigFromToolResult,
    redactNewMcpConfigInToolResult,
    validateClientProvidedMcpConfig,
};

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    manageTokenLength: false, // Agentic models handle context management themselves
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        fileAccessPlan: {
            type: 'array',
            items: { objType: 'FileAccessTargetInput' },
            default: [],
        },
        contextId: ``,
        contextKey: ``,
        chatId: ``,
        language: "English",
        aiName: "",
        aiMemorySelfModify: true,
        title: ``,
        messages: [],
        voiceResponse: false,
        entityId: ``,
        reasoningEffort: '',
        userInfo: '',
        model: 'oai-gpt41',
        clientSideTools: {
            type: 'array',
            items: { type: 'object' },
            default: []
        },
        mcpConfig: '',
        mcpAvailableServers: ''
    },
    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        if (!args || !message || !resolver) {
            return;
        }

        // Track active tool callbacks with a ref count. In streaming mode,
        // toolCallback is invoked fire-and-forget by the plugin, and tool callbacks
        // can chain (callback1 → promptAndParse → fires callback2). We must NOT
        // close MCP clients until the LAST callback finishes.
        args._mcpToolCallbackFired = true;
        args._mcpActiveCallbacks = (args._mcpActiveCallbacks || 0) + 1;

        const resultHasToolCalls = (result) => (
            (result instanceof CortexResponse && result.hasToolCalls()) ||
            (typeof result === 'object' && result?.tool_calls?.length > 0)
        );

        // Helper to close MCP clients when the LAST tool callback completes.
        // In non-streaming mode this callback can return a follow-up model response
        // that already contains the next tool call. Keep clients open in that case;
        // the outer executePathway loop will invoke this callback again for that tool.
        const closeMcpClientsIfNeeded = async ({ preserveClients = false } = {}) => {
            args._mcpActiveCallbacks = (args._mcpActiveCallbacks || 1) - 1;
            if (!preserveClients && args._mcpActiveCallbacks <= 0 && args.mcpClients && args.mcpClients.size > 0) {
                await closeMcpClients(args.mcpClients);
            }
        };

        // Handle both CortexResponse objects and plain message objects
        let tool_calls;
        if (message instanceof CortexResponse) {
            tool_calls = [...(message.toolCalls || [])];
            if (message.functionCall) {
                tool_calls.push(message.functionCall);
            }
        } else {
            tool_calls = [...(message.tool_calls || [])];
        }
        
        const pathwayResolver = resolver;
        const { entityTools, entityToolsOpenAiFormat } = args;

        // Hard cap on callback iterations to prevent runaway fire-and-forget chains.
        // This can happen when a model ignores the "no more tools" message and keeps
        // requesting tool calls — each iteration fires another fire-and-forget callback
        // that streams to the same requestId, producing garbled interleaved output.
        pathwayResolver._callbackIterations = (pathwayResolver._callbackIterations || 0) + 1;
        if (pathwayResolver._callbackIterations > MAX_TOOL_CALLBACK_ITERATIONS) {
            logger.error(`Tool callback iteration limit reached (${MAX_TOOL_CALLBACK_ITERATIONS}) — force-closing stream`);
            const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
            publishRequestProgress({
                requestId,
                progress: 1,
                data: JSON.stringify(""),
                info: JSON.stringify(pathwayResolver.pathwayResultData || {}),
                error: ''
            });
            await closeMcpClientsIfNeeded();
            return null;
        }

        // Check for cancellation before processing tool calls.
        // NOTE: toolCallback is invoked fire-and-forget by plugins (no await/catch),
        // so we must NOT throw — an unhandled rejection would crash Node.
        if (isResolverCanceled(pathwayResolver)) {
            logger.info(`toolCallback: request canceled before tool execution, cleaning up`);
            await closeMcpClientsIfNeeded();
            return;
        }

        // Initialize duplicate tool call detection cache (persists across toolCallback invocations for this request)
        pathwayResolver._toolCallCache = pathwayResolver._toolCallCache || new Map();
        ensureToolResultArtifactStore(pathwayResolver);
        ensureToolResultSnapshotStore(pathwayResolver);

        pathwayResolver.toolBudgetUsed = (pathwayResolver.toolBudgetUsed || 0);
        // Backward compatibility: some older flows/tests still seed toolCallCount.
        // Convert that legacy hard limit signal to the current budget model.
        if ((pathwayResolver.toolCallCount || 0) >= 50) {
            pathwayResolver.toolBudgetUsed = Math.max(pathwayResolver.toolBudgetUsed, TOOL_BUDGET);
        }

        const preToolCallMessages = JSON.parse(JSON.stringify(args.chatHistory || []));
        let finalMessages = JSON.parse(JSON.stringify(preToolCallMessages));

        if (!tool_calls || tool_calls.length === 0) {
            await closeMcpClientsIfNeeded();
            return;
        }

        if (tool_calls && tool_calls.length > 0) {
            if (pathwayResolver.toolBudgetUsed < TOOL_BUDGET) {
                // Execute tool calls in parallel but with isolated message histories
                // Filter out any undefined or invalid tool calls
                const invalidToolCalls = tool_calls.filter(tc => !tc || !tc.function || !tc.function.name);
                if (invalidToolCalls.length > 0) {
                    logger.warn(`Found ${invalidToolCalls.length} invalid tool calls: ${JSON.stringify(invalidToolCalls, null, 2)}`);
                    // bail out if we're getting invalid tool calls
                    pathwayResolver.toolBudgetUsed = TOOL_BUDGET;
                }
                
                const validToolCalls = tool_calls.filter(tc => tc && tc.function && tc.function.name);
                
                const toolResults = await Promise.all(validToolCalls.map(async (toolCall) => {
                    let toolArgs = {};
                    const toolNameLower = toolCall?.function?.name?.toLowerCase() || '';
                    const toolIsSilent = entityTools[toolNameLower]?.definition?.silent === true;
                    try {
                        toolArgs = toolCall?.function?.arguments
                            ? JSON.parse(toolCall.function.arguments)
                            : {};
                        const toolFunction = toolCall.function.name.toLowerCase();

                        // Create an isolated copy of messages for this tool
                        const toolMessages = JSON.parse(JSON.stringify(preToolCallMessages));

                        // Get the tool definition to check for icon and timeout
                        const toolEntry = entityTools[toolFunction];
                        const toolDefinition = toolEntry?.definition;

                        // Get timeout: tool definition (ms) → pathway-level (ms, propagated at registration) → default
                        const toolTimeout = toolDefinition?.timeout || toolEntry?.timeout || TOOL_TIMEOUT_MS;

                        // Get the user message for the tool — if it starts with an emoji, use that as the icon
                        let toolUserMessage = toolArgs.userMessage
                            || toolDefinition?.defaultUserMessage
                            || `Executing tool: ${toolCall.function.name}`;
                        const emojiMatch = toolUserMessage.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u);
                        const toolIcon = emojiMatch ? emojiMatch[1] : (toolArgs.icon || toolDefinition?.icon || '🛠️');
                        if (emojiMatch) {
                            toolUserMessage = toolUserMessage.slice(emojiMatch[0].length);
                        }

                        // Duplicate tool call detection: check if this exact call has been made before
                        const cacheKey = `${toolCall.function.name}:${toolCall.function.arguments}`;
                        const cacheEntry = pathwayResolver._toolCallCache.get(cacheKey);
                        if (cacheEntry && cacheEntry.count >= MAX_DUPLICATE_TOOL_CALLS) {
                            logger.warn(`Duplicate tool call detected (${cacheEntry.count + 1}x): ${toolCall.function.name}`);

                            // Return cached result with a warning note instead of re-executing
                            const cachedParsed = safeJsonParse(cacheEntry.resultContent);
                            const cachedContent = cachedParsed && cachedParsed._toolResultEnvelope
                                ? JSON.stringify({
                                    ...cachedParsed,
                                    duplicateCall: true,
                                    duplicateNote: 'This tool was already called with identical arguments and returned the same result. Try a different approach or different arguments.',
                                })
                                : cacheEntry.resultContent +
                                    '\n\n[Duplicate call — this tool was already called with identical arguments and returned the same result. Try a different approach or different arguments.]';

                            const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                            const toolCallId = toolCall.id;
                            if (!toolIsSilent) {
                                try { await sendToolStart(requestId, toolCallId, toolIcon, toolUserMessage); } catch (e) { /* ignore */ }
                                try { await sendToolFinish(requestId, toolCallId, true, null); } catch (e) { /* ignore */ }
                            }

                            // Preserve thoughtSignature for Gemini 3+ models
                            const toolCallEntry = {
                                id: toolCall.id, type: "function",
                                function: { name: toolCall.function.name, arguments: JSON.stringify(toolArgs) }
                            };
                            if (toolCall.thoughtSignature) { toolCallEntry.thoughtSignature = toolCall.thoughtSignature; }
                            toolMessages.push({ role: "assistant", content: "", tool_calls: [toolCallEntry] });
                            toolMessages.push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: cachedContent });

                            cacheEntry.count++;
                            cacheEntry.wasDuplicate = true;

                            return {
                                success: true, result: { result: cachedContent },
                                toolCall, toolArgs, toolFunction, messages: toolMessages,
                                wasDuplicate: true,
                            };
                        }

                        // Send tool start message
                        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                        const toolCallId = toolCall.id;
                        if (!toolIsSilent) {
                            try {
                                await sendToolStart(requestId, toolCallId, toolIcon, toolUserMessage);
                            } catch (startError) {
                                logger.error(`Error sending tool start message: ${startError.message}`);
                                // Continue execution even if start message fails
                            }
                        }

                        // Wrap tool call with timeout to prevent hanging
                        const toolResult = await withTimeout(
                            callTool(toolFunction, {
                                ...args,
                                ...toolArgs,
                                ...(toolFunction === 'workspacessh' ? {
                                    _toolRequestId: requestId,
                                    _parentToolCallId: toolCallId,
                                } : {}),
                                toolFunction,
                                chatHistory: toolMessages,
                                stream: false,
                                useMemory: false  // Disable memory synthesis for tool calls
                            }, entityTools, pathwayResolver),
                            toolTimeout,
                            `Tool ${toolCall.function.name} timed out after ${toolTimeout / 1000}s`
                        );

                        const newMcpConfig = extractNewMcpConfigFromToolResult(toolResult);
                        if (newMcpConfig) {
                            await applyNewMcpConfigToResolver({
                                newMcpConfig,
                                args,
                                pathwayResolver,
                                requestedServerKey: toolArgs?.serverKey,
                            });
                            redactNewMcpConfigInToolResult(toolResult);
                        }

                        // Tool calls and results need to be paired together in the message history
                        // Add the tool call to the isolated message history
                        // Preserve thoughtSignature for Gemini 3+ models
                        const toolCallEntry = {
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: JSON.stringify(toolArgs)
                            }
                        };
                        if (toolCall.thoughtSignature) {
                            toolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        toolMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [toolCallEntry]
                        });

                        // Add the tool result to the isolated message history
                        // Extract the result - if it's already a string, use it directly; only stringify objects
                        const toolResultContent = buildToolResultContent(toolResult, pathwayResolver, toolFunction, {
                            allowResultCompaction: toolDefinition?.allowResultCompaction ?? toolEntry?.allowResultCompaction,
                            toolArgs,
                        });

                        toolMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResultContent
                        });

                        // Store result in duplicate detection cache
                        pathwayResolver._toolCallCache.set(cacheKey, {
                            count: (cacheEntry?.count || 0) + 1,
                            resultContent: toolResultContent,
                        });

                        // Add the screenshots/images using OpenAI image format
                        if (toolResult?.toolImages && toolResult.toolImages.length > 0) {
                            // Build a text list of URLs so the model can reference them in markdown
                            // Without this, the model can see images visually but has no text URL to use,
                            // causing it to hallucinate URLs like "attachment://call_xxx-1.png"
                            const urlList = toolResult.toolImages
                                .map((img, i) => {
                                    if (typeof img === 'string') return null; // base64 screenshots have no stable URL
                                    const url = img.url || img.image_url?.url;
                                    const name = img.originalFilename || `image-${i + 1}`;
                                    return url ? `${name}: ${url}` : null;
                                })
                                .filter(Boolean);

                            // Only include text if there are URLs to reference;
                            // base64-only batches (screenshots) don't need a text block
                            const textContent = urlList.length > 0
                                ? [{
                                    type: "text",
                                    text: `Image URLs for markdown: ${urlList.join(', ')}`
                                }]
                                : [];

                            toolMessages.push({
                                role: "user",
                                content: [
                                    ...textContent,
                                    ...toolResult.toolImages.map(toolImage => {
                                        // Handle both base64 strings (screenshots) and image_url objects (file collection images)
                                        if (typeof toolImage === 'string') {
                                            // Base64 string format (screenshots)
                                            // Sniff actual image format — browser sends JPEG, others may send PNG
                                            const mimeType = toolImage.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                                            return {
                                                type: "image_url",
                                                image_url: {
                                                    url: `data:${mimeType};base64,${toolImage}`
                                                }
                                            };
                                        } else if (typeof toolImage === 'object' && toolImage.image_url) {
                                            // Image URL object format (file collection images)
                                            return {
                                                type: "image_url",
                                                url: toolImage.url,
                                                gcs: toolImage.gcs,
                                                image_url: toolImage.image_url,
                                                originalFilename: toolImage.originalFilename
                                            };
                                        } else {
                                            // Fallback for any other format
                                            return {
                                                type: "image_url",
                                                image_url: {
                                                    url: toolImage.url || toolImage
                                                }
                                            };
                                        }
                                    })
                                ]
                            });
                        }

                        // Check for errors in tool result
                        // callTool returns { result: parsedResult, toolImages: [] }
                        // We need to check if result has an error field
                        let hasError = false;
                        let errorMessage = null;
                        
                        if (toolResult?.error !== undefined) {
                            // Direct error from callTool (e.g., tool returned null)
                            hasError = true;
                            errorMessage = typeof toolResult.error === 'string' ? toolResult.error : String(toolResult.error);
                        } else if (toolResult?.result) {
                            // Check if result is a string that might contain error JSON
                            if (typeof toolResult.result === 'string') {
                                try {
                                    const parsed = JSON.parse(toolResult.result);
                                    if (parsed.error !== undefined) {
                                        hasError = true;
                                        // Tools return { error: true, message: "..." } so we want the message field
                                        if (parsed.message) {
                                            errorMessage = parsed.message;
                                        } else if (typeof parsed.error === 'string') {
                                            errorMessage = parsed.error;
                                        } else {
                                            // error is true/boolean, so use a generic message
                                            errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                                        }
                                    }
                                } catch (e) {
                                    // Not JSON, ignore
                                }
                            } else if (typeof toolResult.result === 'object' && toolResult.result !== null) {
                                // Check if result object has error field
                                if (toolResult.result.error !== undefined) {
                                    hasError = true;
                                    // Tools return { error: true, message: "..." } so we want the message field
                                    // If message exists, use it; otherwise fall back to error field (if it's a string)
                                    if (toolResult.result.message) {
                                        errorMessage = toolResult.result.message;
                                    } else if (typeof toolResult.result.error === 'string') {
                                        errorMessage = toolResult.result.error;
                                    } else {
                                        // error is true/boolean, so use a generic message
                                        errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                                    }
                                }
                            }
                        }
                        
                        // Send tool finish message
                        if (!toolIsSilent) {
                            try {
                                await sendToolFinish(requestId, toolCallId, !hasError, errorMessage);
                            } catch (finishError) {
                                logger.error(`Error sending tool finish message: ${finishError.message}`);
                                // Continue execution even if finish message fails
                            }
                        }

                        return { 
                            success: !hasError, 
                            result: toolResult,
                            error: errorMessage,
                            toolCall,
                            toolArgs,
                            toolFunction,
                            messages: toolMessages
                        };
                    } catch (error) {
                        // Detect if this is a timeout error for clearer logging
                        const isTimeout = error.message?.includes('timed out');
                        logger.error(`${isTimeout ? 'Timeout' : 'Error'} executing tool ${toolCall?.function?.name || 'unknown'}: ${error.message}`);
                        
                        // Send tool finish message (error)
                        // Get requestId and toolCallId if not already defined (in case error occurred before they were set)
                        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                        const toolCallId = toolCall.id;
                        if (!toolIsSilent) {
                            try {
                                await sendToolFinish(requestId, toolCallId, false, error.message);
                            } catch (finishError) {
                                logger.error(`Error sending tool finish message: ${finishError.message}`);
                                // Continue execution even if finish message fails
                            }
                        }
                        
                        // Create error message history
                        const errorMessages = JSON.parse(JSON.stringify(preToolCallMessages));
                        // Preserve thoughtSignature for Gemini 3+ models
                        const errorToolCallEntry = {
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: JSON.stringify(toolCall.function.arguments)
                            }
                        };
                        if (toolCall.thoughtSignature) {
                            errorToolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        errorMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [errorToolCallEntry]
                        });
                        errorMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: `Error: ${error.message}`
                        });

                        return { 
                            success: false, 
                            error: error.message,
                            toolCall,
                            toolArgs,
                            toolFunction: toolCall?.function?.name?.toLowerCase() || 'unknown',
                            messages: errorMessages
                        };
                    }
                }));

                // Merge all message histories in order
                for (const result of toolResults) {
                    try {
                        if (!result?.messages) {
                            logger.error('Invalid tool result structure, skipping message history update');
                            continue;
                        }

                        // Add only the new messages from this tool's history
                        const newMessages = result.messages.slice(preToolCallMessages.length);
                        finalMessages.push(...newMessages);
                    } catch (error) {
                        logger.error(`Error merging message history for tool result: ${error.message}`);
                    }
                }

                // Check if any tool calls failed
                const failedTools = toolResults.filter(result => result && !result.success);
                if (failedTools.length > 0) {
                    logger.warn(`Some tool calls failed: ${failedTools.map(t => t.error).join(', ')}`);
                }

                // Budget accounting: cheap tools (toolCost: 1) like WorkspaceSSH
                // consume less budget than expensive ones (default: 10)
                const budgetCost = toolResults.reduce((sum, r) => {
                    if (!r) return sum;
                    const def = entityTools[r.toolFunction]?.definition;
                    return sum + Math.max(1, def?.toolCost ?? DEFAULT_TOOL_COST);
                }, 0);
                pathwayResolver.toolBudgetUsed = (pathwayResolver.toolBudgetUsed || 0) + budgetCost;

                // If any tool calls were duplicates, inject a system message to steer the model
                const hadDuplicates = toolResults.some(r => r?.wasDuplicate);
                if (hadDuplicates) {
                    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    finalMessages = insertSystemMessage(finalMessages,
                        "One or more tool calls were duplicates of previous calls with identical arguments and returned the same cached result. Do not repeat the same tool call — try a different approach, use different arguments, or provide your answer based on the information already gathered.",
                        requestId
                    );
                }

                // Check if any of the executed tools are hand-off tools (async agents)
                // Hand-off tools don't return results immediately, so we skip the completion check
                const hasHandoffTool = toolResults.some(result => {
                    if (!result || !result.toolFunction) return false;
                    const toolDefinition = entityTools[result.toolFunction]?.definition;
                    return toolDefinition?.handoff === true;
                });

            } else {
                const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                finalMessages = insertSystemMessage(finalMessages,
                    "Maximum tool call limit reached - no more tool calls will be executed. Provide your response based on the information gathered so far.",
                    requestId
                );
            }

            // Truncate oversized tool results to prevent context overflow.
            // Skip messages we've already truncated on a previous turn — once
            // truncated they're MAX + suffix.length chars, which still trips
            // a naive `> MAX` check and produces noisy repeat warnings.
            args.chatHistory = compactHistoricalToolResults(finalMessages, pathwayResolver, {
                ...buildPromptUsageOptions(args, entityToolsOpenAiFormat, {
                    tool_choice: pathwayResolver.toolBudgetUsed >= TOOL_BUDGET ? 'none' : 'auto',
                }),
            }).map(msg => {
                if (msg.role !== 'tool' || !msg.content || msg.content.length <= MAX_TOOL_RESULT_LENGTH) {
                    return msg;
                }
                if (msg.content.endsWith(TOOL_RESULT_TRUNCATION_SUFFIX)) {
                    return msg; // already truncated on a prior turn
                }
                logger.warn(`Compacting oversized tool result (${msg.content.length} chars) for ${msg.name || 'unknown tool'}`);
                return {
                    ...msg,
                    content: compactOversizedToolHistoryContent(msg, pathwayResolver),
                };
            });

            // clear any accumulated pathwayResolver errors from the tools
            pathwayResolver.errors = [];

            // Drain any pending user messages injected via injectAgentMessage mutation
            const injectionRequestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
            const pendingMsgs = drainPendingMessages(injectionRequestId);
            if (pendingMsgs.length > 0) {
                const combinedMessage = pendingMsgs.map(m => m.message).join('\n\n');
                args.chatHistory = insertSystemMessage(args.chatHistory,
                    `The user has sent a new message while you were working. Please acknowledge it and incorporate their feedback into your current task.\n\nUser's message: "${combinedMessage}"`,
                    injectionRequestId
                );
                logger.info(`Injected ${pendingMsgs.length} user message(s) into agent loop for request ${injectionRequestId}`);
                publishRequestProgress({
                    requestId: injectionRequestId,
                    progress: 0.5,
                    data: JSON.stringify(""),
                    info: JSON.stringify({ userMessageInjected: true, count: pendingMsgs.length }),
                    error: ''
                });
            }

            // Add a line break to avoid running output together
            await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

            // After budget exhausted, remove tools entirely so the model cannot
            // request more. Without this, models like Gemini ignore the system
            // message and keep requesting tool calls, spawning concurrent
            // fire-and-forget streaming responses that interleave into garbled output.
            // Check for cancellation before calling the model again.
            // NOTE: toolCallback is invoked fire-and-forget by plugins (no await/catch),
            // so we must NOT throw here — an unhandled rejection would crash Node.
            if (isResolverCanceled(pathwayResolver)) {
                logger.info(`toolCallback: request canceled, cleaning up`);
                await closeMcpClientsIfNeeded();
                return;
            }

            const atToolLimit = pathwayResolver.toolBudgetUsed >= TOOL_BUDGET;

            try {
                const beforePromptUsage = usageMarker(getLatestPathwayUsage(pathwayResolver));
                let result = await pathwayResolver.promptAndParse({
                    ...args,
                    tools: atToolLimit ? undefined : entityToolsOpenAiFormat,
                    tool_choice: atToolLimit ? "none" : "auto",
                });
                rememberPromptTokenUsage(pathwayResolver, args.chatHistory, buildPromptUsageOptions(args, atToolLimit ? undefined : entityToolsOpenAiFormat, {
                    tool_choice: atToolLimit ? 'none' : 'auto',
                }), result, beforePromptUsage);

                // Check if promptAndParse returned null (model call failed or canceled)
                if (!result) {
                    if (isResolverCanceled(pathwayResolver)) {
                        logger.info(`toolCallback: request canceled after promptAndParse, cleaning up`);
                        await closeMcpClientsIfNeeded();
                        return;
                    }
                    const errorMessage = pathwayResolver.errors.length > 0
                        ? pathwayResolver.errors.join(', ')
                        : 'Model request failed - no response received';
                    logger.error(`promptAndParse returned null during tool callback: ${errorMessage}`);
                    const errorResponse = await generateErrorResponse(new Error(errorMessage), args, pathwayResolver);
                    // Ensure errors are cleared before returning
                    pathwayResolver.errors = [];

                    // In streaming mode, the toolCallback is invoked fire-and-forget by the plugin,
                    // so we must stream the error response directly to the client and close the stream
                    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    publishRequestProgress({
                        requestId,
                        progress: 1,
                        data: JSON.stringify(errorResponse),
                        info: JSON.stringify(pathwayResolver.pathwayResultData || {}),
                        error: ''
                    });
                    await closeMcpClientsIfNeeded();
                    return errorResponse;
                }

                // After the model finishes streaming, check for user messages that arrived
                // during the stream. Only handle them here if no new fire-and-forget tool
                // callback was launched (toolCallbackInvoked) — otherwise the new callback
                // will drain pending messages itself at line 576, and handling them here
                // would create a concurrent model call that interleaves with it.
                while (!pathwayResolver.toolCallbackInvoked
                    && hasPendingMessages(injectionRequestId)
                    && !isResolverCanceled(pathwayResolver)) {
                    const laterMsgs = drainPendingMessages(injectionRequestId);
                    if (laterMsgs.length === 0) break;

                    // Use streamedContent from the streaming response (raw stream objects
                    // would serialize as [object Object])
                    const assistantContent = pathwayResolver.streamedContent
                        || (typeof result === 'string' ? result : '')
                        || '';
                    if (assistantContent) {
                        args.chatHistory.push({ role: "assistant", content: assistantContent });
                    }

                    const combinedMsg = laterMsgs.map(m => m.message).join('\n\n');
                    args.chatHistory = insertSystemMessage(args.chatHistory,
                        `The user has sent a new message while you were working. Please acknowledge it and incorporate their feedback into your current task.\n\nUser's message: "${combinedMsg}"`,
                        injectionRequestId
                    );

                    logger.info(`toolCallback: injected ${laterMsgs.length} user message(s) after model stream for request ${injectionRequestId}`);
                    publishRequestProgress({
                        requestId: injectionRequestId,
                        progress: 0.5,
                        data: JSON.stringify(""),
                        info: JSON.stringify({ userMessageInjected: true, count: laterMsgs.length }),
                        error: ''
                    });

                    await say(injectionRequestId, `\n`, 1000, false, false);

                    const rerunAtLimit = pathwayResolver.toolBudgetUsed >= TOOL_BUDGET;
                    const beforeRerunUsage = usageMarker(getLatestPathwayUsage(pathwayResolver));
                    result = await pathwayResolver.promptAndParse({
                        ...args,
                        tools: rerunAtLimit ? undefined : entityToolsOpenAiFormat,
                        tool_choice: rerunAtLimit ? "none" : "auto",
                    });
                    rememberPromptTokenUsage(pathwayResolver, args.chatHistory, buildPromptUsageOptions(args, rerunAtLimit ? undefined : entityToolsOpenAiFormat, {
                        tool_choice: rerunAtLimit ? 'none' : 'auto',
                    }), result, beforeRerunUsage);

                    if (!result) {
                        if (isResolverCanceled(pathwayResolver)) {
                            logger.info(`toolCallback: request canceled after message injection, cleaning up`);
                            await closeMcpClientsIfNeeded();
                            return;
                        }
                        throw new Error('Model execution returned null after message injection in toolCallback');
                    }
                }

                await closeMcpClientsIfNeeded({
                    preserveClients: resultHasToolCalls(result),
                });
                return result;
            } catch (parseError) {
                // On cancellation, clean up and return — don't waste an API call
                // generating an error response. We must NOT throw here because
                // toolCallback is invoked fire-and-forget by plugins (no await/catch),
                // and an unhandled rejection would crash Node.
                if (parseError.message === 'Request canceled') {
                    logger.info(`toolCallback: request canceled (caught), cleaning up`);
                    await closeMcpClientsIfNeeded();
                    return;
                }
                // If promptAndParse fails, generate error response instead of re-throwing
                logger.error(`Error in promptAndParse during tool callback: ${parseError.message}`);
                const errorResponse = await generateErrorResponse(parseError, args, pathwayResolver);
                // Ensure errors are cleared before returning
                pathwayResolver.errors = [];

                // In streaming mode, the toolCallback is invoked fire-and-forget by the plugin,
                // so we must stream the error response directly to the client and close the stream
                const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                publishRequestProgress({
                    requestId,
                    progress: 1,
                    data: JSON.stringify(errorResponse),
                    info: JSON.stringify(pathwayResolver.pathwayResultData || {}),
                    error: ''
                });
                await closeMcpClientsIfNeeded();
                return errorResponse;
            }
        }
    },
  
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;
        const traceBase = {
            requestId: pathwayResolver?.requestId,
            rootRequestId: pathwayResolver?.rootRequestId || undefined,
            pathway: pathwayResolver?.pathway?.name,
            model: pathwayResolver?.modelName,
            chatHistoryLength: Array.isArray(args?.chatHistory) ? args.chatHistory.length : undefined,
        };
        const preflightSpan = latencyTrace.start('sysEntity.preflight', traceBase);

        // Load input parameters and information into args
        let {
            entityId,
            voiceResponse,
            aiMemorySelfModify,
            chatId,
            researchMode,
            reasoningEffort: reasoningEffortOverride,
            clientSideTools,
            mcpConfig,
            mcpAvailableServers
        } = { ...pathwayResolver.pathway.inputParameters, ...args };

        const userId =
            Array.isArray(args.fileAccessPlan) &&
            args.fileAccessPlan.length > 0
                ? (
                    args.fileAccessPlan.find((target) => target?.userContextId)
                        || args.fileAccessPlan[0]
                )?.userContextId || null
                : null;

        // Parse clientSideTools if it's a string (from GraphQL)
        if (typeof clientSideTools === 'string') {
            try {
                clientSideTools = JSON.parse(clientSideTools);
            } catch (e) {
                logger.error(`Failed to parse clientSideTools: ${e.message}`);
                clientSideTools = [];
            }
        }

        let entityConfig = null;
        if (entityId) {
            const entityResolveSpan = latencyTrace.start('sysEntity.resolveExplicitEntity', {
                ...traceBase,
                entityId,
                userId,
            });
            const resolvedEntity = await resolveExplicitEntityConfig(entityId, { userId });
            latencyTrace.end(entityResolveSpan, {
                disabled: Boolean(resolvedEntity?.disabled),
                resolvedEntityId: resolvedEntity?.entityId,
                found: Boolean(resolvedEntity?.entityConfig),
            });
            if (resolvedEntity?.disabled) {
                latencyTrace.end(preflightSpan, { earlyReturn: 'disabledEntity' });
                return await generateErrorResponse(
                    new Error(`Entity ${entityId} is disabled - missing required environment variables`),
                    args,
                    pathwayResolver,
                );
            }
            if (resolvedEntity?.entityConfig) {
                entityConfig = resolvedEntity.entityConfig;
                entityId = Object.prototype.hasOwnProperty.call(resolvedEntity, 'entityId')
                    ? resolvedEntity.entityId
                    : entityId;
            }
        }

        if (!entityConfig) {
            const loadEntitySpan = latencyTrace.start('sysEntity.loadEntityConfig', {
                ...traceBase,
                entityId,
            });
            entityConfig = await loadEntityConfig(entityId);
            latencyTrace.end(loadEntitySpan, {
                found: Boolean(entityConfig),
                entityName: entityConfig?.name,
            });
        }

        const toolsSpan = latencyTrace.start('sysEntity.getToolsForEntity', {
            ...traceBase,
            entityId,
            entityName: entityConfig?.name,
        });
        let { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);
        const { name: entityName, instructions: entityInstructions } = entityConfig || {};
        latencyTrace.end(toolsSpan, {
            toolCount: Object.keys(entityTools || {}).length,
            openAiToolCount: entityToolsOpenAiFormat?.length || 0,
        });

        // Determine useMemory: entityConfig.useMemory === false is a hard disable (entity can't use memory)
        // Otherwise args.useMemory can disable it, default true
        args.useMemory = entityConfig?.useMemory === false ? false : (args.useMemory ?? true);

        // Add client-side tools from the caller
        const clientToolsSpan = latencyTrace.start('sysEntity.registerClientTools', {
            ...traceBase,
            clientToolCount: Array.isArray(clientSideTools) ? clientSideTools.length : 0,
        });
        if (clientSideTools && Array.isArray(clientSideTools) && clientSideTools.length > 0) {
            const registeredClientToolNames = [];
            clientSideTools.forEach(tool => {
                const toolName = tool.function?.name?.toLowerCase();
                if (toolName) {
                    const {
                        allowResultCompaction,
                        ...openAiTool
                    } = tool;
                    // Mark as client-side tool and add to available tools
                    entityTools[toolName] = {
                        definition: {
                            ...tool,
                            clientSide: true,  // Mark it as client-side
                            icon: tool.icon || '📱'
                        },
                        pathwayName: 'client_side_execution',  // Placeholder pathway
                        clientSide: true,
                        allowResultCompaction,
                    };
                    entityToolsOpenAiFormat.push(openAiTool);
                    registeredClientToolNames.push(toolName);
                }
            });
            logger.info(`Registered ${registeredClientToolNames.length} client-side tool(s) from caller: ${registeredClientToolNames.join(', ')}`);
        }
        latencyTrace.end(clientToolsSpan, {
            toolCount: Object.keys(entityTools || {}).length,
            openAiToolCount: entityToolsOpenAiFormat?.length || 0,
        });

        const lazyLocalToolSearch = entityConfig?.lazyToolSearch !== false
            && (!entityConfig?.tools || entityConfig.tools.includes('*') || entityConfig.lazyToolSearch === true);
        const localEntityToolsDeferred = lazyLocalToolSearch ? { ...entityTools } : {};
        const localToolCatalog = lazyLocalToolSearch ? buildLocalToolCatalog(localEntityToolsDeferred) : {};
        if (lazyLocalToolSearch) {
            entityToolsOpenAiFormat = getAlwaysVisibleLocalToolDefinitions(entityTools);
            const deferredSchemaCount = Math.max(Object.keys(localEntityToolsDeferred).length - entityToolsOpenAiFormat.length, 0);
            logger.info(`Deferred ${deferredSchemaCount} local tool schema(s) behind SearchAvailableTools for entity ${entityId || entityConfig?.name || 'unknown'}; kept ${entityToolsOpenAiFormat.length} always visible`);
        }

        // Initialize MCP clients and discover tools into a catalog (two-step tool search pattern).
        // Instead of adding all MCP tools upfront (which causes tool pollution), we store them
        // in a catalog and expose a single "SearchAvailableTools" tool. The model searches
        // for relevant tools first, and only matched tools are loaded into the context.
        const mcpSpan = latencyTrace.start('sysEntity.mcpSetup', {
            ...traceBase,
            hasMcpConfig: Boolean(mcpConfig && typeof mcpConfig === 'string' && mcpConfig.trim()),
            hasMcpAvailableServers: Boolean(mcpAvailableServers && typeof mcpAvailableServers === 'string' && mcpAvailableServers.trim()),
        });
        let mcpClients = new Map();
        let mcpToolCatalog = {};
        let mcpEntityToolsDeferred = {};
        if (mcpConfig && typeof mcpConfig === 'string' && mcpConfig.trim()) {
            try {
                const { clients: connectedMcpClients, expiredServers: mcpExpiredServers = [] } = await initializeMcpClients(mcpConfig);
                mcpClients = connectedMcpClients;
                if (mcpClients.size > 0) {
                    const { entityTools: mcpEntityTools, mcpToolCatalog: catalog } = await discoverMcpTools(mcpClients);
                    // Store full tool definitions for later loading, but do NOT add to entityToolsOpenAiFormat
                    mcpEntityToolsDeferred = mcpEntityTools;
                    mcpToolCatalog = catalog;
                }

                registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, {
                    mcpClients,
                    mcpToolCatalog,
                    localToolCatalog,
                    mcpExpiredServers,
                    logger,
                    fetchToolDefaultLength: TOOL_RESULT_INLINE_MAX,
                    compactionEnabled: TOOL_RESULT_COMPACTION_ENABLED,
                });
            } catch (mcpError) {
                logger.warn(`MCP initialization failed: ${mcpError?.message || mcpError}`);
            }
        }

        if (mcpAvailableServers && typeof mcpAvailableServers === 'string' && mcpAvailableServers.trim()) {
            try {
                const availableServers = JSON.parse(mcpAvailableServers);
                registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, {
                    availableServers,
                    logger,
                    fetchToolDefaultLength: TOOL_RESULT_INLINE_MAX,
                    compactionEnabled: TOOL_RESULT_COMPACTION_ENABLED,
                });
            } catch (parseError) {
                logger.warn(`Failed to parse mcpAvailableServers: ${parseError?.message || parseError}`);
            }
        }

        registerRequestScopedTools(entityTools, entityToolsOpenAiFormat, {
            localToolCatalog,
            fetchToolDefaultLength: TOOL_RESULT_INLINE_MAX,
        });
        latencyTrace.end(mcpSpan, {
            mcpClientCount: mcpClients?.size || 0,
            mcpCatalogCount: Object.keys(mcpToolCatalog || {}).length,
            localCatalogCount: Object.keys(localToolCatalog || {}).length,
            deferredToolCount: Object.keys(mcpEntityToolsDeferred || {}).length,
            toolCount: Object.keys(entityTools || {}).length,
            openAiToolCount: entityToolsOpenAiFormat?.length || 0,
        });

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

        const entityFilesSpan = latencyTrace.start('sysEntity.attachEntityFiles', {
            ...traceBase,
            entityFileCount: entityConfig?.files?.length || 0,
        });
        if(entityConfig?.files && entityConfig?.files.length > 0) {
            //get last user message if not create one to add files to
            let lastUserMessage = args.chatHistory.filter(message => message.role === "user").slice(-1)[0];
            if(!lastUserMessage) {
                lastUserMessage = {
                    role: "user",
                    content: []
                };
                args.chatHistory.push(lastUserMessage);
            }

            //if last user message content is not array then convert to array
            if(!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = lastUserMessage.content ? [lastUserMessage.content] : [];
            }

            //add files to the last user message content
            lastUserMessage.content.push(...entityConfig?.files.map(file => ({
                    type: "image_url",
                    gcs: file?.gcs,
                    url: file?.url,
                    image_url: { url: file?.url },
                    originalFilename: file?.name
                })
            ));
        }
        latencyTrace.end(entityFilesSpan, {
            chatHistoryLength: args.chatHistory.length,
        });

        args = {
            ...args,
            ...config.get('entityConstants'),
            entityId,
            entityTools,
            entityToolsOpenAiFormat,
            entityInstructions,
            voiceResponse,
            aiMemorySelfModify,
            chatId,
            researchMode,
            mcpClients,
            mcpToolCatalog,
            mcpEntityToolsDeferred,
            localToolCatalog,
            localEntityToolsDeferred,
            reasoningEffort: reasoningEffortOverride || entityConfig?.reasoningEffort || null,
        };

        pathwayResolver.args = {...args};

        const promptSetupSpan = latencyTrace.start('sysEntity.promptSetup', {
            ...traceBase,
            useMemory: Boolean(args.useMemory),
            openAiToolCount: entityToolsOpenAiFormat?.length || 0,
        });
        const promptPrefix = '';

        const memoryTemplates = args.useMemory ? 
            `{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n\n{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_MEMORY_CONTEXT}}\n\n` : '';

        const instructionTemplates = entityInstructions ? (entityInstructions + '\n\n') : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n{{renderTemplate AI_EXPERTISE}}\n\n`;

        const promptMessages = [
            {"role": "system", "content": `${promptPrefix}${instructionTemplates}{{renderTemplate AI_TOOLS}}\n\n{{renderTemplate AI_SEARCH_RULES}}\n\n{{renderTemplate AI_SEARCH_SYNTAX}}\n\n{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n${memoryTemplates}{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];
        latencyTrace.end(promptSetupSpan, {
            promptMessageCount: promptMessages.length,
            memoryTemplates: Boolean(args.useMemory),
        });

        const reasoningEffort = reasoningEffortOverride || entityConfig?.reasoningEffort || 'low';
        args.reasoningEffort = reasoningEffort;
        args.entityInstructions = entityInstructions || '';

        // Limit the chat history to 20 messages to speed up processing
        const historyLimitSpan = latencyTrace.start('sysEntity.limitChatHistory', {
            ...traceBase,
            originalChatHistoryLength: Array.isArray(args.chatHistory) ? args.chatHistory.length : 0,
            messagesLength: Array.isArray(args.messages) ? args.messages.length : 0,
        });
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }
        latencyTrace.end(historyLimitSpan, {
            chatHistoryLength: args.chatHistory.length,
        });

        // Process files in chat history:
        // - Files in collection (all fileAccessPlan targets): stripped, accessible via tools
        // - Files not in collection: left in message for model to see directly
        const fileSyncSpan = latencyTrace.start('sysEntity.syncAndStripFiles', {
            ...traceBase,
            chatHistoryLength: args.chatHistory.length,
            fileAccessPlanTargets: Array.isArray(args.fileAccessPlan) ? args.fileAccessPlan.length : 0,
        });
        const { chatHistory: strippedHistory } = await syncAndStripFilesFromChatHistory(
            args.chatHistory, args.fileAccessPlan
        );
        args.chatHistory = strippedHistory;
        latencyTrace.end(fileSyncSpan, {
            chatHistoryLength: args.chatHistory.length,
        });

        // truncate the chat history in case there is really long content
        const truncateSpan = latencyTrace.start('sysEntity.truncateMessages', {
            ...traceBase,
            chatHistoryLength: args.chatHistory.length,
        });
        const truncatedChatHistory = resolver.modelExecutor.plugin.truncateMessagesToTargetLength(args.chatHistory, null, 1000);
        latencyTrace.end(truncateSpan, {
            truncatedChatHistoryLength: Array.isArray(truncatedChatHistory) ? truncatedChatHistory.length : undefined,
        });

        // Asynchronously manage memory for this context
        if (args.aiMemorySelfModify && args.useMemory) {
            latencyTrace.mark('sysEntity.memoryManager.start', {
                ...traceBase,
                chatHistoryLength: truncatedChatHistory?.length,
            });
            callPathway('sys_memory_manager', {  ...args, chatHistory: truncatedChatHistory, stream: false, reasoningEffort: 'none' })
            .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
        }

        // Update pathwayResolver.args with stripped chatHistory
        // This ensures toolCallback receives the processed history, not the original
        pathwayResolver.args = {...args};
        latencyTrace.end(preflightSpan, {
            openAiToolCount: entityToolsOpenAiFormat?.length || 0,
            chatHistoryLength: args.chatHistory.length,
        });

        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));
            currentMessages = compactHistoricalToolResults(currentMessages, pathwayResolver, buildPromptUsageOptions(args, entityToolsOpenAiFormat, {
                tool_choice: 'auto',
            }));

            const firstRunSpan = latencyTrace.start('sysEntity.initialRunAllPrompts', {
                ...traceBase,
                chatHistoryLength: currentMessages.length,
                openAiToolCount: entityToolsOpenAiFormat?.length || 0,
                toolChoice: "auto",
                reasoningEffort,
            });
            const beforeFirstRunUsage = usageMarker(getLatestPathwayUsage(pathwayResolver));
            let response = await runAllPrompts({
                ...args,
                chatHistory: currentMessages,
                reasoningEffort,
                tools: entityToolsOpenAiFormat,
                tool_choice: "auto"
            });
            rememberPromptTokenUsage(pathwayResolver, currentMessages, buildPromptUsageOptions(args, entityToolsOpenAiFormat, {
                tool_choice: 'auto',
            }), response, beforeFirstRunUsage);
            latencyTrace.end(firstRunSpan, {
                responseKind: response instanceof CortexResponse ? 'CortexResponse' : typeof response,
                hasToolCalls: response instanceof CortexResponse ? response.hasToolCalls() : Boolean(response?.tool_calls),
            });

            // Handle null response (can happen when ModelExecutor catches an error)
            if (!response) {
                throw new Error('Model execution returned null - the model request likely failed');
            }

            let toolCallback = pathwayResolver.pathway.toolCallback;
            const postLoopRequestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;

            // Outer loop: handles both tool calls and injected user messages
            let continueLoop = true;
            while (continueLoop) {
                continueLoop = false;

                // Check for cancellation at the top of each outer loop iteration
                if (isResolverCanceled(pathwayResolver)) break;

                // Inner loop: process tool calls
                while (response && (
                    (response instanceof CortexResponse && response.hasToolCalls()) ||
                    (typeof response === 'object' && response.tool_calls)
                )) {
                    // Check for cancellation before each tool callback iteration
                    if (isResolverCanceled(pathwayResolver)) break;

                    try {
                        response = await toolCallback(args, response, pathwayResolver);

                        // Handle null response from tool callback
                        if (!response) {
                            throw new Error('Tool callback returned null - a model request likely failed');
                        }
                    } catch (toolError) {
                        // Re-throw cancellation — don't waste an API call generating an error response
                        if (toolError.message === 'Request canceled') throw toolError;
                        // Handle errors in tool callback
                        logger.error(`Error in tool callback: ${toolError.message}`);
                        // Generate error response for tool callback errors
                        const errorResponse = await generateErrorResponse(toolError, args, pathwayResolver);
                        // Ensure errors are cleared before returning
                        pathwayResolver.errors = [];
                        clearPendingMessages(postLoopRequestId);
                        return errorResponse;
                    }
                }

                // After inner loop, check if we broke out due to cancellation
                if (isResolverCanceled(pathwayResolver)) break;

                // Check for user messages injected while the model was generating its final response.
                // Skip this if a fire-and-forget tool callback was invoked during streaming —
                // the tool callback already handles message injection internally (drainPendingMessages
                // inside toolCallback), and running a second model call here would race against it,
                // causing two concurrent streams to interleave on the same requestId.
                if (!pathwayResolver.toolCallbackInvoked && hasPendingMessages(postLoopRequestId)) {
                    const postLoopMsgs = drainPendingMessages(postLoopRequestId);
                    if (postLoopMsgs.length > 0) {
                        // Add the model's last response as an assistant message
                        const assistantContent = typeof response === 'string' ? response :
                            (response instanceof CortexResponse ? response.output_text : String(response));
                        args.chatHistory.push({ role: "assistant", content: assistantContent });

                        // Inject user message — allow model to continue with tools
                        const combinedPostMsg = postLoopMsgs.map(m => m.message).join('\n\n');
                        args.chatHistory = insertSystemMessage(args.chatHistory,
                            `The user has sent a new message while you were working. Please acknowledge it and incorporate their feedback into your current task.\n\nUser's message: "${combinedPostMsg}"`,
                            postLoopRequestId
                        );

                        logger.info(`Post-loop: injected ${postLoopMsgs.length} user message(s) for request ${postLoopRequestId}`);
                        publishRequestProgress({
                            requestId: postLoopRequestId,
                            progress: 0.5,
                            data: JSON.stringify(""),
                            info: JSON.stringify({ userMessageInjected: true, count: postLoopMsgs.length }),
                            error: ''
                        });

                        await say(postLoopRequestId, `\n`, 1000, false, false);

                        // Re-run model with tools so it can act on the user's message
                        const postLoopAtLimit = pathwayResolver.toolBudgetUsed >= TOOL_BUDGET;
                        const beforePostLoopUsage = usageMarker(getLatestPathwayUsage(pathwayResolver));
                        response = await runAllPrompts({
                            ...args,
                            tools: postLoopAtLimit ? undefined : entityToolsOpenAiFormat,
                            tool_choice: postLoopAtLimit ? "none" : "auto",
                        });
                        rememberPromptTokenUsage(pathwayResolver, args.chatHistory, buildPromptUsageOptions(args, postLoopAtLimit ? undefined : entityToolsOpenAiFormat, {
                            tool_choice: postLoopAtLimit ? 'none' : 'auto',
                        }), response, beforePostLoopUsage);

                        if (!response) {
                            throw new Error('Model execution returned null after message injection');
                        }

                        // Continue the outer loop so tool calls from this
                        // response are processed and further injections are
                        // picked up.
                        continueLoop = true;
                    }
                }
            }

            // Only clear pending messages if no fire-and-forget tool callback is active.
            // When toolCallbackInvoked is true, the tool callback will drain/clear messages
            // itself — clearing here would destroy messages before it gets to them.
            if (!pathwayResolver.toolCallbackInvoked) {
                clearPendingMessages(postLoopRequestId);
            }

            // If we broke out of the loops due to cancellation, throw to
            // let asyncResolve close the stream cleanly.
            if (isResolverCanceled(pathwayResolver)) {
                throw new Error('Request canceled');
            }

            // Do NOT close MCP clients here. In streaming mode, executePathway returns
            // before the fire-and-forget tool callback runs, so any close here races against
            // in-flight MCP tool calls. The tool callback closes MCP clients when the last
            // callback in the chain completes. For no-tool-call paths, MCP clients are
            // lightweight HTTP transports that will be garbage collected.

            return response;

        } catch (e) {
            // Re-throw cancellation — don't waste an API call generating an error response.
            // asyncResolve will publish progress:1 to close the stream.
            if (e.message === 'Request canceled') {
                clearPendingMessages(pathwayResolver.rootRequestId || pathwayResolver.requestId);
                throw e;
            }

            logger.error(`Error in sys_entity_agent: ${e.message}`);

            // Generate a smart error response instead of throwing
            // Note: We don't call logError here because generateErrorResponse will clear errors
            // and we want to handle the error gracefully rather than tracking it
            const errorResponse = await generateErrorResponse(e, args, pathwayResolver);

            // Ensure errors are cleared before returning (in case any were added during error response generation)
            pathwayResolver.errors = [];

            return errorResponse;
        }
    }
};
