// pathwayTools.js
import { encode, decode } from '../lib/encodeCache.js';
import { config } from '../config.js';
import { publishRequestProgress } from "../lib/redisSubscription.js";
import { getSemanticChunks } from "../server/chunker.js";
import logger from '../lib/logger.js';
import { requestState } from '../server/requestState.js';
import { processPathwayParameters } from '../server/typeDef.js';
import { rejectClientToolCallback, waitForClientToolResult } from '../server/clientToolCallbacks.js';
import { callMcpTool } from '../lib/mcpClient.js';
import latencyTrace from '../lib/latencyTrace.js';

// callPathway - call a pathway from another pathway
const callPathway = async (pathwayName, inArgs, pathwayResolver) => {
    const span = latencyTrace.start('tool.callPathway', {
        requestId: pathwayResolver?.requestId,
        rootRequestId: pathwayResolver?.rootRequestId || undefined,
        parentPathway: pathwayResolver?.pathway?.name,
        pathway: pathwayName,
        stream: Boolean(inArgs?.stream),
        async: Boolean(inArgs?.async),
    });

    // Clone the args object to avoid modifying the original
    const args = JSON.parse(JSON.stringify(inArgs));
    
    const pathway = config.get(`pathways.${pathwayName}`);
    if (!pathway) {
        throw new Error(`Pathway ${pathwayName} not found`);
    }

    // Merge pathway default parameters with input args, similar to GraphQL typeDef behavior
    const mergedParams = { ...pathway.defaultInputParameters, ...pathway.inputParameters, ...args };
    
    // Process the merged parameters to convert type specification objects to actual values
    const processedArgs = processPathwayParameters(mergedParams);

    const parent = {};
    let rootRequestId = pathwayResolver?.rootRequestId || pathwayResolver?.requestId;
    
    const contextValue = { config, pathway, requestState };

    let data = await pathway.rootResolver(parent, {...processedArgs, rootRequestId}, contextValue );

    let returnValue = data?.result || null;

    if (args.async || args.stream) {
        const { result: requestId } = data;

        // Fire the resolver for the async requestProgress
        logger.info(`Callpathway starting async requestProgress, pathway: ${pathwayName}, requestId: ${requestId}`);
        const { resolver, args } = requestState[requestId];
        requestState[requestId].useRedis = false;
        requestState[requestId].started = true;

        resolver && await resolver(args);

        returnValue = null;
    }

    // Merge after execution completes (sync or async) so pathwayResultData
    // (including artifacts) reflects the final state of the sub-pathway resolver.
    if (pathwayResolver && contextValue.pathwayResolver) {
        pathwayResolver.mergeResolver(contextValue.pathwayResolver);
    }

    latencyTrace.end(span, {
        childRequestId: contextValue.pathwayResolver?.requestId,
        returnKind: returnValue && typeof returnValue.on === 'function' ? 'stream' : typeof returnValue,
        returnChars: typeof returnValue === 'string' ? returnValue.length : undefined,
    });
    return returnValue;
};

// Pull inline screenshots / images out of a client-side tool's result so
// they're delivered to the model as vision input (via toolImages →
// image_url parts in the agent loop) rather than as base64 strings stuffed
// inside the tool result JSON. Recognized top-level shapes:
//
//   { screenshot: { base64, mimeType }, ... }            // canvas / page-inspect tools
//   { screenshots: [{ base64, mimeType }, ...], ... }
//   { imageUrl: { url, ... }, ... }                      // ViewImage convention
//   { imageUrls: [{ url, ... }, ...], ... }
//
// Returns { result: <stringified data with images stripped>, toolImages: [...] }.
// Non-object data (string / number / null) is passed through unchanged with
// no extracted images.
const extractClientToolImages = (data) => {
    if (typeof data === 'string') {
        return { result: data, toolImages: [] };
    }
    if (!data || typeof data !== 'object') {
        return { result: JSON.stringify(data), toolImages: [] };
    }

    // Shallow clone so we don't mutate the caller's data — pathwayResolver.tool
    // captures the original (un-stripped) version for downstream consumers.
    const cleaned = { ...data };
    const toolImages = [];

    if (cleaned.imageUrl && typeof cleaned.imageUrl === 'object') {
        toolImages.push(cleaned.imageUrl);
        delete cleaned.imageUrl;
    }
    if (Array.isArray(cleaned.imageUrls)) {
        toolImages.push(...cleaned.imageUrls);
        delete cleaned.imageUrls;
    }

    const pushScreenshot = (shot) => {
        if (!shot || typeof shot !== 'object') return;
        const { base64, mimeType, mime_type } = shot;
        if (typeof base64 !== 'string' || !base64) return;
        const mime = mimeType || mime_type || 'image/png';
        toolImages.push({ image_url: { url: `data:${mime};base64,${base64}` } });
    };
    if (cleaned.screenshot) {
        pushScreenshot(cleaned.screenshot);
        delete cleaned.screenshot;
    }
    if (Array.isArray(cleaned.screenshots)) {
        cleaned.screenshots.forEach(pushScreenshot);
        delete cleaned.screenshots;
    }

    return { result: JSON.stringify(cleaned), toolImages };
};

function toolEntryToOpenAiTool(toolKey, toolEntry, forceToolKeyName = false) {
    const toolFunction = toolEntry?.definition?.function || {};
    const name = (forceToolKeyName || toolEntry?.mcpServer) ? toolKey : (toolFunction.name || toolKey);
    return {
        type: 'function',
        function: {
            name,
            description: toolFunction.description || '',
            parameters: toolFunction.parameters || { type: 'object', properties: {} },
        },
    };
}

function hasOpenAiToolSchema(entityToolsOpenAiFormat, toolKey, toolEntry) {
    if (!Array.isArray(entityToolsOpenAiFormat)) return false;
    const toolFunctionName = toolEntry?.definition?.function?.name || toolKey;
    return entityToolsOpenAiFormat.some(tool => {
        const name = tool?.function?.name;
        return typeof name === 'string' && (
            name.toLowerCase() === toolKey.toLowerCase() ||
            name.toLowerCase() === toolFunctionName.toLowerCase()
        );
    });
}

const INSPECT_TOOL_RESULT_DEFAULT_LIMIT = 4000;
const INSPECT_TOOL_RESULT_MAX_LIMIT = 12000;
const INSPECT_TOOL_RESULT_MAX_SEARCH_MATCHES = 5;
const INSPECT_TOOL_RESULT_SEARCH_CONTEXT_MAX = 1200;

function clampInspectLimit(limit) {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return INSPECT_TOOL_RESULT_DEFAULT_LIMIT;
    }
    return Math.min(Math.floor(parsed), INSPECT_TOOL_RESULT_MAX_LIMIT);
}

function parseToolResultSnapshotContent(content) {
    if (typeof content !== 'string') {
        return { envelope: null, text: '' };
    }
    try {
        const envelope = JSON.parse(content);
        const streamParts = [
            ['stdout', envelope.stdoutPreview],
            ['stderr', envelope.stderrPreview],
        ].filter(([, value]) => typeof value === 'string');
        if (streamParts.length > 1) {
            return {
                envelope,
                text: streamParts.map(([label, value]) => `[${label}]\n${value}`).join('\n\n'),
            };
        }
        const candidates = [
            envelope.contentPreview,
            streamParts[0]?.[1],
            envelope.result,
        ];
        const text = candidates.find(value => typeof value === 'string') || content;
        return { envelope, text };
    } catch {
        return { envelope: null, text: content };
    }
}

function buildToolResultSummary(resultRef, snap, envelope, text) {
    return {
        ok: true,
        resultRef,
        mode: 'summary',
        tool: envelope?.tool,
        kind: envelope?.kind,
        summary: envelope?.summary,
        compacted: envelope?.compacted,
        contentTotalChars: envelope?.contentTotalChars,
        stdoutTotalChars: envelope?.stdoutTotalChars,
        stderrTotalChars: envelope?.stderrTotalChars,
        storedChars: snap?.length || snap?.content?.length || text.length,
        readableChars: text.length,
        artifactRefs: Array.isArray(envelope?.artifactRefs) ? envelope.artifactRefs : undefined,
    };
}

function valuePathSegment(key) {
    if (typeof key === 'number') return `[${key}]`;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function contextAroundMatch(value, index, needleLength, limit) {
    const maxContext = Math.min(limit, INSPECT_TOOL_RESULT_SEARCH_CONTEXT_MAX);
    const start = Math.max(0, index - Math.floor((maxContext - needleLength) / 2));
    const end = Math.min(value.length, start + maxContext);
    return {
        snippetOffset: start,
        snippet: `${start > 0 ? '...' : ''}${value.slice(start, end)}${end < value.length ? '...' : ''}`,
    };
}

function findJsonStringOffset(text, value, valueOffset, cursor) {
    const encoded = JSON.stringify(value);
    const start = text.indexOf(encoded, cursor.position);
    if (start === -1) return null;
    cursor.position = start + encoded.length;
    return start + 1 + valueOffset;
}

function collectJsonSearchMatches(value, query, limit, matches, cursor, path = '$') {
    if (matches.length >= INSPECT_TOOL_RESULT_MAX_SEARCH_MATCHES) return;

    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            collectJsonSearchMatches(item, query, limit, matches, cursor, `${path}${valuePathSegment(index)}`);
        });
        return;
    }

    if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => {
            collectJsonSearchMatches(item, query, limit, matches, cursor, `${path}${valuePathSegment(key)}`);
        });
        return;
    }

    const textValue = typeof value === 'string' ? value : String(value ?? '');
    if (!textValue) return;

    const haystack = textValue.toLowerCase();
    const needle = query.toLowerCase();
    let searchFrom = 0;
    while (matches.length < INSPECT_TOOL_RESULT_MAX_SEARCH_MATCHES) {
        const index = haystack.indexOf(needle, searchFrom);
        if (index === -1) break;
        const context = contextAroundMatch(textValue, index, needle.length, limit);
        matches.push({
            offset: findJsonStringOffset(cursor.sourceText, textValue, index, cursor) ?? undefined,
            valueOffset: index,
            path,
            snippetOffset: context.snippetOffset,
            snippet: context.snippet,
        });
        searchFrom = index + Math.max(needle.length, 1);
    }
}

function searchJsonPayload(text, query, limit) {
    try {
        const parsed = JSON.parse(text);
        const matches = [];
        collectJsonSearchMatches(parsed, query, limit, matches, { sourceText: text, position: 0 });
        return matches.length > 0 ? matches : null;
    } catch {
        return null;
    }
}

function inspectToolResult(args, pathwayResolver) {
    const resultRef = typeof args.resultRef === 'string' ? args.resultRef.trim() : '';
    if (!resultRef) {
        return { result: JSON.stringify({ error: true, message: 'resultRef is required.' }) };
    }

    const snap = pathwayResolver?._toolResultSnapshots?.get(resultRef);
    if (!snap || typeof snap.content !== 'string') {
        return {
            result: JSON.stringify({
                error: true,
                resultRef,
                message: `Tool result ${resultRef} is not available in this request.`,
            }),
        };
    }

    const mode = typeof args.mode === 'string' ? args.mode : 'summary';
    const limit = clampInspectLimit(args.limit);
    const { envelope, text } = parseToolResultSnapshotContent(snap.content);
    const base = buildToolResultSummary(resultRef, snap, envelope, text);

    if (mode === 'summary') {
        return { result: JSON.stringify(base) };
    }

    if (mode === 'head') {
        return {
            result: JSON.stringify({
                ...base,
                mode,
                offset: 0,
                limit,
                content: text.slice(0, limit),
                hasMore: text.length > limit,
            }),
        };
    }

    if (mode === 'tail') {
        const offset = Math.max(0, text.length - limit);
        return {
            result: JSON.stringify({
                ...base,
                mode,
                offset,
                limit,
                content: text.slice(offset),
                hasMoreBefore: offset > 0,
            }),
        };
    }

    if (mode === 'chunk') {
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        return {
            result: JSON.stringify({
                ...base,
                mode,
                offset,
                limit,
                content: text.slice(offset, offset + limit),
                hasMoreBefore: offset > 0,
                hasMoreAfter: offset + limit < text.length,
            }),
        };
    }

    if (mode === 'search') {
        const query = typeof args.query === 'string' ? args.query : '';
        if (!query.trim()) {
            return {
                result: JSON.stringify({
                    error: true,
                    resultRef,
                    mode,
                    message: 'query is required for search mode.',
                }),
            };
        }
        const haystack = text.toLowerCase();
        const needle = query.toLowerCase();
        let matches = searchJsonPayload(text, query, limit) || [];
        if (!matches.length) {
            let searchFrom = 0;
            while (matches.length < INSPECT_TOOL_RESULT_MAX_SEARCH_MATCHES) {
                const index = haystack.indexOf(needle, searchFrom);
                if (index === -1) break;
                const snippetStart = Math.max(0, index - Math.floor(limit / 2));
                const snippetEnd = Math.min(text.length, snippetStart + limit);
                matches.push({
                    offset: index,
                    snippetOffset: snippetStart,
                    snippet: text.slice(snippetStart, snippetEnd),
                });
                searchFrom = index + Math.max(needle.length, 1);
            }
        }
        return {
            result: JSON.stringify({
                ...base,
                mode,
                query,
                limit,
                matchCount: matches.length,
                matches,
            }),
        };
    }

    return {
        result: JSON.stringify({
            error: true,
            resultRef,
            mode,
            message: 'mode must be one of summary, head, tail, chunk, or search.',
        }),
    };
}

const callTool = async (toolName, args, toolDefinitions, pathwayResolver) => {
    const span = latencyTrace.start('tool.call', {
        requestId: pathwayResolver?.requestId,
        rootRequestId: pathwayResolver?.rootRequestId || undefined,
        pathway: pathwayResolver?.pathway?.name,
        toolName,
    });
    let toolResult = null;
    let toolImages = [];

    const toolDef = toolDefinitions[toolName.toLowerCase()];
    if (!toolDef) {
        throw new Error(`Tool ${toolName} not found in available tools`);
    }

    // Create a sanitized copy of args for logging - only include tool parameters
    const toolParams = toolDef.definition?.function?.parameters?.properties || {};
    const paramKeys = Object.keys(toolParams);
    const logArgs = {};
    
    // Include only parameters defined in the tool's parameter schema
    for (const key of paramKeys) {
        if (args.hasOwnProperty(key)) {
            const value = args[key];
            // Sanitize large objects/arrays
            if (key === 'chatHistory' || (Array.isArray(value) && value.length > 10)) {
                logArgs[key] = `[${Array.isArray(value) ? value.length : 'N/A'} items]`;
            } else if (typeof value === 'object' && value !== null && Object.keys(value).length > 10) {
                logArgs[key] = `[object with ${Object.keys(value).length} keys]`;
            } else {
                logArgs[key] = value;
            }
        }
    }
    
    // Also include pathwayParams if they exist (hard-coded tool parameters)
    if (toolDef.pathwayParams) {
        Object.assign(logArgs, toolDef.pathwayParams);
    }
    
    logger.debug(`callTool: Starting execution of ${toolName} ${JSON.stringify(logArgs)}`);

    try {
        // Built-in tool: SearchAvailableTools — searches the MCP tool catalog and
        // dynamically loads matched tools into the entity's available tools so the model
        // can call them in subsequent turns.
        if (toolDef.pathwayName === '_builtin_search_tools') {
            const catalog = {
                ...(pathwayResolver?.args?.localToolCatalog || {}),
                ...(pathwayResolver?.args?.mcpToolCatalog || {}),
            };
            const deferred = {
                ...(pathwayResolver?.args?.localEntityToolsDeferred || {}),
                ...(pathwayResolver?.args?.mcpEntityToolsDeferred || {}),
            };
            const query = (args.query || '').toLowerCase();

            if (!query) {
                const result = { result: JSON.stringify({ error: true, message: 'A search query is required.' }) };
                latencyTrace.end(span, { toolKind: 'builtin', error: 'missing_query' });
                return result;
            }

            // Split query into keywords for matching
            const keywords = query.split(/\s+/).filter(Boolean);

            // Score each catalog entry by how many keywords match name, description, or parameter names
            const scored = Object.values(catalog).map(entry => {
                const haystack = `${entry.name} ${entry.displayName || ''} ${entry.originalName} ${entry.description} ${entry.parameters.join(' ')}`.toLowerCase();
                const score = keywords.reduce((s, kw) => s + (haystack.includes(kw) ? 1 : 0), 0);
                return { ...entry, score };
            });

            // Return top matches (score > 0), up to 5
            const matches = scored
                .filter(e => e.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);

            if (matches.length === 0) {
                const result = { result: JSON.stringify({ tools: [], message: `No tools found matching "${args.query}". Try different keywords.` }) };
                latencyTrace.end(span, { toolKind: 'builtin', matchCount: 0 });
                return result;
            }

            // Dynamically load matched tools into the entity's available tool set
            const entityTools = pathwayResolver?.args?.entityTools;
            const entityToolsOpenAiFormat = pathwayResolver?.args?.entityToolsOpenAiFormat;
            const loadedToolNames = [];

            for (const match of matches) {
                const toolKey = match.name;
                if (!deferred[toolKey]) {
                    continue;
                }
                if (entityTools && !entityTools[toolKey]) {
                    entityTools[toolKey] = deferred[toolKey];
                }
                if (entityToolsOpenAiFormat && !hasOpenAiToolSchema(entityToolsOpenAiFormat, toolKey, deferred[toolKey])) {
                    entityToolsOpenAiFormat.push(toolEntryToOpenAiTool(toolKey, deferred[toolKey], match.source !== 'local'));
                    loadedToolNames.push(toolKey);
                }
            }

            if (loadedToolNames.length > 0) {
                logger.info(`SearchAvailableTools: loaded ${loadedToolNames.length} tools into context: ${loadedToolNames.join(', ')}`);
            }

            // Return concise search results to the model
            const resultTools = matches.map(m => ({
                name: m.source === 'local' ? (m.displayName || m.originalName || m.name) : m.name,
                description: m.description,
                server: m.server,
            }));

            const result = { result: JSON.stringify({ tools: resultTools, message: `Found ${resultTools.length} tool(s). These tools are now available for you to call directly.` }) };
            latencyTrace.end(span, { toolKind: 'builtin', matchCount: resultTools.length, loadedToolCount: loadedToolNames.length });
            return result;
        }

        if (toolDef.pathwayName === '_builtin_inspect_tool_result') {
            const result = inspectToolResult(args, pathwayResolver);
            latencyTrace.end(span, { toolKind: 'builtin', resultKind: typeof result?.result });
            return result;
        }

        // Check if this is an MCP tool
        if (toolDef.mcpServer) {
            const mcpClients = pathwayResolver?.args?.mcpClients;
            if (!mcpClients || mcpClients.size === 0) {
                throw new Error('MCP clients not initialized');
            }
            // Only pass tool-specific parameters defined in the tool's schema,
            // not the full args object (which includes chatHistory, entityTools, etc.)
            const toolParamKeys = Object.keys(toolDef.definition?.function?.parameters?.properties || {});
            const mcpArgs = {};
            for (const key of toolParamKeys) {
                if (key in args) {
                    mcpArgs[key] = args[key];
                }
            }
            // Use the original MCP tool name (preserving case) from the tool definition,
            // not the lowercased composite key, since MCP servers are case-sensitive.
            const mcpResult = await callMcpTool(mcpClients, toolName, mcpArgs, toolDef.mcpToolName);
            latencyTrace.end(span, { toolKind: 'mcp', resultKind: typeof mcpResult?.result });
            return mcpResult;
        }

        // Check if this is a client-side tool
        if (toolDef.clientSide === true || toolDef.definition?.clientSide === true) {
            logger.info(`Tool ${toolName} is a client-side tool - waiting for client execution`);
            
            const toolCallbackId = `${toolName}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
            
            // Explicitly publish the marker to the stream so the client receives it
            if (pathwayResolver) {
                const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                
                const toolCallbackData = {
                    toolUsed: [toolName],
                    clientSideTool: true,
                    toolCallbackName: toolName,
                    toolCallbackId: toolCallbackId,
                    toolCallbackMessage: args.userMessage || `Executing ${toolName}...`,
                    chatId: args.chatId || "",
                    requestId: requestId, // Include requestId so client can submit tool results
                    toolArgs: args
                };
                const clientResultPromise = waitForClientToolResult(toolCallbackId, requestId, {
                    maxTimeoutMs: 300000,
                    initialHeartbeatTimeoutMs: 10000,
                    heartbeatStaleMs: 15000,
                    checkEveryMs: 1000,
                });
                
                try {
                    logger.info(`Publishing client-side tool marker to requestId: ${requestId}, toolCallbackId: ${toolCallbackId}`);
                    await publishRequestProgress({
                        requestId,
                        progress: 0.5,
                        data: JSON.stringify(""),
                        info: JSON.stringify(toolCallbackData)
                    });
                } catch (error) {
                    logger.error(`Error publishing client-side tool marker: ${error.message}`);
                    clientResultPromise.catch(() => {});
                    await rejectClientToolCallback(toolCallbackId, error).catch(() => {});
                    throw error;
                }
                
                // Wait for the client to execute the tool and send back the result
                logger.info(`Waiting for client tool result: ${toolCallbackId}`);
                try {
                    const clientResult = await clientResultPromise;
                    const serializedClientResult = JSON.stringify(clientResult) ?? String(clientResult);
                    const resultData = clientResult?.data;
                    const resultDataType = Array.isArray(resultData) ? 'array' : typeof resultData;
                    logger.info(JSON.stringify({
                        event: 'client_tool_result_received',
                        requestId,
                        toolCallbackId,
                        success: clientResult?.success === true,
                        resultDataType,
                        resultDataKeys: resultData && typeof resultData === 'object' && !Array.isArray(resultData)
                            ? Object.keys(resultData)
                            : undefined,
                        resultBytes: serializedClientResult.length,
                    }));
                    logger.debug(JSON.stringify({
                        event: 'client_tool_result_payload',
                        requestId,
                        toolCallbackId,
                        result: clientResult,
                    }));
                    
                    // If the client reported an error, throw it
                    if (!clientResult.success) {
                        throw new Error(clientResult.error || 'Client tool execution failed');
                    }
                    
                    // Extract any inline screenshots / images from the
                    // client's result before stringifying. Otherwise they
                    // sit inside the tool result JSON as raw base64, which
                    // (a) bloats the message past the agent's truncation
                    // cutoff, getting chopped mid-base64, and (b) reaches
                    // the model as text noise rather than as vision input.
                    // Pulling them into toolImages routes them through the
                    // image_url path the agent loop already implements.
                    const { result: cleanedResult, toolImages: extractedImages } =
                        extractClientToolImages(clientResult.data);
                    toolResult = cleanedResult;

                    // Update resolver with the original (un-stripped) data —
                    // downstream consumers may want to see screenshots too.
                    pathwayResolver.tool = JSON.stringify({
                        ...toolCallbackData,
                        result: clientResult.data
                    });

                    latencyTrace.end(span, {
                        toolKind: 'client',
                        toolCallbackId,
                        hasResult: Boolean(toolResult),
                        toolImagesLength: extractedImages?.length || 0,
                    });
                    return {
                        result: toolResult,
                        toolImages: extractedImages,
                    };
                } catch (error) {
                    logger.error(`Error waiting for client tool result: ${error.message}`);
                    throw new Error(`Client tool execution failed: ${error.message}`);
                }
            } else {
                throw new Error('PathwayResolver is required for client-side tools');
            }
        }

        const pathwayName = toolDef.pathwayName;
        // Merge hard-coded pathway parameters with runtime args
        const mergedArgs = {
            ...(toolDef.pathwayParams || {}),
            ...args
        };

        if (pathwayName.includes('_generator_')) {
            toolResult = await callPathway('sys_entity_continue', {
                ...mergedArgs,
                generatorPathway: pathwayName,
                stream: false
            },
            pathwayResolver
        );
        } else {
            toolResult = await callPathway(pathwayName, mergedArgs,
            pathwayResolver
        );
        }

        if (toolResult === null) {
            const result = { error: `Tool ${toolName} returned null result` };
            latencyTrace.end(span, { toolKind: 'pathway', pathwayName, error: result.error });
            return result;
        }

        // Handle search results accumulation
        let parsedResult = null;

        // Parse the result if it's a string
        try {
            parsedResult = typeof toolResult === 'string' ? JSON.parse(toolResult) : toolResult;
        } catch (e) {
            // If parsing fails, just return the original result
            latencyTrace.end(span, {
                toolKind: 'pathway',
                pathwayName: toolDef.pathwayName,
                resultKind: typeof toolResult,
                parseableJson: false,
            });
            return {
                result: toolResult,
                toolImages: toolImages
            };
        }

        if (pathwayResolver) {
            // Initialize searchResults array if it doesn't exist
            if (!pathwayResolver.searchResults) {
                pathwayResolver.searchResults = [];
            }

            // Check if tool result has imageUrl or imageUrls field (for ViewImage/ViewImages tools)
            // Extract into toolImages and remove from parsedResult so the URLs
            // don't also appear in the tool result content sent to the model
            if (parsedResult.imageUrl && typeof parsedResult.imageUrl === 'object') {
                toolImages.push(parsedResult.imageUrl);
                delete parsedResult.imageUrl;
            }
            if (parsedResult.imageUrls && Array.isArray(parsedResult.imageUrls)) {
                toolImages.push(...parsedResult.imageUrls);
                delete parsedResult.imageUrls;
            }

            // Check if this is a search response
            if (parsedResult._type === "SearchResponse" && Array.isArray(parsedResult.value)) {
                // Extract and add each search result
                parsedResult.value.forEach(result => {
                    if (result.searchResultId) {
                        // Extract screenshot if present
                        if (result.screenshot) {
                            toolImages.push(result.screenshot);
                            delete result.screenshot;
                        }

                        // Build content by concatenating headers and chunk if available
                        let content = '';
                        if (result.header_1) content += result.header_1 + '\n\n';
                        if (result.header_2) content += result.header_2 + '\n\n';
                        if (result.header_3) content += result.header_3 + '\n\n';
                        if (result.chunk) content += result.chunk;
                        
                        // If no headers/chunk were found, fall back to existing content fields
                        if (!content) {
                            content = result.content || result.text || result.chunk || '';
                        }

                        pathwayResolver.searchResults.push({
                            searchResultId: result.searchResultId,
                            title: result.title || result.key || '',
                            url: result.url || '',
                            content: content,
                            path: result.path || '',
                            wireid: result.wireid || '',
                            source: result.source || '',
                            slugline: result.slugline || '',
                            date: result.date || ''
                        });
                    }
                });
            }
        }

        const finalResult = {
            result: parsedResult,
            toolImages: toolImages
        };
        logger.debug(`callTool: ${toolName} completed successfully, returning: ${JSON.stringify({
            hasResult: !!finalResult.result,
            hasToolImages: !!finalResult.toolImages,
            toolImagesLength: finalResult.toolImages?.length || 0
        })}`);
        latencyTrace.end(span, {
            toolKind: toolDef.clientSide === true || toolDef.definition?.clientSide === true
                ? 'client'
                : toolDef.mcpServer
                    ? 'mcp'
                    : 'pathway',
            pathwayName: toolDef.pathwayName,
            hasResult: !!finalResult.result,
            toolImagesLength: finalResult.toolImages?.length || 0,
        });
        return finalResult;
    } catch (error) {
        logger.error(`Error calling tool ${toolName}: ${error.message}`);
        const errorResult = { error: error.message };
        logger.debug(`callTool: ${toolName} failed, returning error: ${JSON.stringify(errorResult)}`);
        latencyTrace.end(span, { error: error.message });
        return errorResult;
    }
}

const addCitationsToResolver = (pathwayResolver, contentBuffer, directCitations = null) => {
    if (!pathwayResolver) {
        return;
    }

    // If direct citations are provided, add them directly
    // This is used by plugins like grokResponsesPlugin that get citations from the API
    if (directCitations && Array.isArray(directCitations) && directCitations.length > 0) {
        const pathwayResultData = pathwayResolver.pathwayResultData || {};
        pathwayResultData.citations = [...(pathwayResultData.citations || []), ...directCitations];
        pathwayResolver.pathwayResultData = pathwayResultData;
        logger.info(`Adding ${directCitations.length} direct citations to resolver`);
    }

    // Also check for :cd_source[id] patterns in content and match against searchResults
    // Only proceed if there are searchResults to match against
    if (!pathwayResolver.searchResults) {
        return;
    }

    const regex = /:cd_source\[(.*?)\]/g;
    let match;
    const foundIds = [];
    while ((match = regex.exec(contentBuffer)) !== null) {
        // Ensure the capture group exists and is not empty
        if (match[1] && match[1].trim()) { 
            foundIds.push(match[1].trim());
        }
    }

    if (foundIds.length > 0) {
        const {searchResults} = pathwayResolver;
        logger.info(`Found referenced searchResultIds: ${foundIds.join(', ')}`);

        if (searchResults) {
            const matchingResults = searchResults.filter(result => foundIds.includes(result.searchResultId));
            // Only modify pathwayResultData if we actually found matching results
            if (matchingResults.length > 0) {
                const pathwayResultData = pathwayResolver.pathwayResultData || {};
                pathwayResultData.citations = [...(pathwayResultData.citations || []), ...matchingResults];
                pathwayResolver.pathwayResultData = pathwayResultData;
            }
        }
    }
}

const gpt3Encode = (text) => {
    return encode(text);
}

const gpt3Decode = (text) => {
    return decode(text);
}

const say = async (requestId, message, maxMessageLength = Infinity, voiceResponse = true, isEphemeral = true) => {
    try {
        const chunks = getSemanticChunks(message, maxMessageLength);

        const info = JSON.stringify({
            ephemeral: isEphemeral,
        });

        for (let chunk of chunks) {
            await publishRequestProgress({
                requestId,
                progress: 0.5,
                data: JSON.stringify(chunk),
                info
            });
        }

        if (voiceResponse) {
            await publishRequestProgress({
                requestId,
                progress: 0.5,
                data: JSON.stringify(" ... "),
                info
            });
        }

        await publishRequestProgress({
            requestId,
            progress: 0.5,
            data: JSON.stringify("\n\n"),
            info
        });

    } catch (error) {
        logger.error(`Say error: ${error.message}`);
    }
};

/**
 * Send a structured tool start message
 * @param {string} requestId - The request ID
 * @param {string} toolCallId - Unique identifier for this tool call
 * @param {string} toolIcon - Icon for the tool (e.g., '🛠️')
 * @param {string} userMessage - User-friendly message describing what the tool is doing
 */
const sendToolStart = async (requestId, toolCallId, toolIcon, userMessage) => {
    try {
        const info = JSON.stringify({
            toolMessage: {
                type: 'start',
                callId: toolCallId,
                icon: toolIcon || '🛠️',
                userMessage: userMessage
            }
        });

        await publishRequestProgress({
            requestId,
            progress: 0.5,
            data: JSON.stringify(""),
            info
        });
    } catch (error) {
        logger.error(`sendToolStart error: ${error.message}`);
    }
};

/**
 * Send a structured tool finish message
 * @param {string} requestId - The request ID
 * @param {string} toolCallId - Unique identifier for this tool call (must match the start message)
 * @param {boolean} success - Whether the tool execution was successful
 * @param {string} error - Optional error message if success is false
 */
const sendToolFinish = async (requestId, toolCallId, success, error = null) => {
    try {
        const toolMessage = {
            type: 'finish',
            callId: toolCallId,
            success: success
        };

        if (!success && error) {
            toolMessage.error = error;
        }

        const info = JSON.stringify({
            toolMessage
        });

        await publishRequestProgress({
            requestId,
            progress: 0.5,
            data: JSON.stringify(""),
            info
        });
    } catch (error) {
        logger.error(`sendToolFinish error: ${error.message}`);
    }
};

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} errorMessage - Error message if timeout occurs
 * @returns {Promise} - The original promise or rejection on timeout
 */
const withTimeout = (promise, timeoutMs, errorMessage = 'Operation timed out') => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(errorMessage));
        }, timeoutMs);
    });
    
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
};

export { callPathway, gpt3Encode, gpt3Decode, say, callTool, addCitationsToResolver, sendToolStart, sendToolFinish, withTimeout, extractClientToolImages };
