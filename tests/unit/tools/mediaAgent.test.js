import test from 'ava';
import media from '../../../pathways/system/entity/tools/sys_tool_media.js';
import { CONCIERGE_AGENT_TOOL_NAMES, isLiveMediaStatus, mediaTaskPresentation } from '../../../lib/mediaAgentTools.js';
import { classifyToolPermission } from '../../../lib/toolPermissionReview.js';
import { COLLEAGUE_AGENT_TOOL_NAMES } from '../../../lib/colleagueAgentTools.js';
import { getAlwaysVisibleLocalToolDefinitions, buildLocalToolCatalog } from '../../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import { registerSearchAvailableTools } from '../../../pathways/system/entity/tools/shared/request_scoped_tools.js';

test('media is discoverable without adding an always-visible schema or a model catalog', (t) => {
    const tools = { media: { definition: media.toolDefinition, pathwayName: 'sys_tool_media' } };
    t.deepEqual(getAlwaysVisibleLocalToolDefinitions(tools), []);
    t.true(CONCIERGE_AGENT_TOOL_NAMES.has('media'));
    t.false(COLLEAGUE_AGENT_TOOL_NAMES.has('media'));
    const catalog = buildLocalToolCatalog(tools);
    const schemas = [];
    registerSearchAvailableTools({}, schemas, { localToolCatalog: catalog });
    t.true(schemas[0].function.description.includes('Media'));
    t.true(catalog.media.description.includes('speech'));
    t.is(schemas.length, 1);
    t.true(JSON.stringify(media.toolDefinition).length < 2600);
    t.falsy(media.toolDefinition.function.parameters.properties.model.enum);
});

test('only generation receipts attach bounded media pointers to completion events', (t) => {
    const mediaTask = { taskId: 'a'.repeat(24), type: 'image', model: 'model', name: 'Model' };
    for (const result of [{ mediaTask }, JSON.stringify({ mediaTask }), { result: JSON.stringify({ mediaTask }) }]) {
        t.deepEqual(mediaTaskPresentation('media', 'sys_tool_media', { operation: 'generate' }, result), { mediaTask });
    }
    for (const [name, pathway, operation, receipt] of [
        ['media', 'remote', 'generate', mediaTask],
        ['another', 'sys_tool_media', 'generate', mediaTask],
        ['media', 'sys_tool_media', 'status', mediaTask],
        ['media', 'sys_tool_media', 'generate', { ...mediaTask, taskId: '../other' }],
        ['media', 'sys_tool_media', 'generate', { ...mediaTask, type: 'html' }],
    ]) t.deepEqual(mediaTaskPresentation(name, pathway, { operation }, { mediaTask: receipt }), {});
    t.deepEqual(mediaTaskPresentation('media', 'sys_tool_media', { operation: 'generate' }, { mediaTask: { ...mediaTask, url: 'secret' } }), { mediaTask });
});

test('status stays live and discovery reads need no model permission review', (t) => {
    t.true(isLiveMediaStatus('media', 'sys_tool_media', { operation: 'status' }));
    t.false(isLiveMediaStatus('media', 'remote', { operation: 'status' }));
    t.false(isLiveMediaStatus('media', 'sys_tool_media', { operation: 'generate' }));
    for (const operation of ['search', 'describe', 'status']) {
        t.is(classifyToolPermission('media', { pathwayName: 'sys_tool_media' }, { operation }).classification, 'safe');
    }
    t.is(classifyToolPermission('media', { pathwayName: 'sys_tool_media' }, { operation: 'generate' }).classification, 'questionable');
    t.is(classifyToolPermission('media', { pathwayName: 'sys_tool_media', mcpServer: 'external' }, { operation: 'search' }).classification, 'questionable');
});

test.serial('media forwards only explicit parameters through the authenticated server bridge', async (t) => {
    const oldFetch = globalThis.fetch;
    const oldEndpoint = process.env.CONCIERGE_AGENT_TOOLS_URL;
    process.env.CONCIERGE_AGENT_TOOLS_URL = 'http://localhost:3002/api/agent-tools';
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, ...options, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ taskId: 'receipt' }) };
    };
    try {
        const explicit = { operation: 'generate', model: 'chosen-media-model', prompt: 'A scene', settings: { duration: 5, generateAudio: false }, references: [{ type: 'image', hash: 'owned' }], requestKey: 'scene-v1' };
        const result = await media.executePathway({ args: {
            toolFunction: 'media', agentToolsToken: 'bound-token', entityId: 'assistant', contextId: 'agent-context', fileAccessPlan: [{ userContextId: 'user-context' }],
            _toolRequestId: 'turn', _parentToolCallId: 'call', model: 'inherited-chat-model',
            _agentToolParameters: { ...explicit, endpoint: 'http://evil.test', contextId: 'other-user' },
        } });
        t.deepEqual(JSON.parse(result), { taskId: 'receipt' });
        t.deepEqual(calls[0].body.args, explicit);
        t.is(calls[0].body.contextId, 'user-context');
        t.is(calls[0].body.callId, 'turn:call');
        t.is(calls[0].headers.Authorization, 'Bearer bound-token');
        t.is(calls[0].redirect, 'error');
        t.is(calls[0].url, process.env.CONCIERGE_AGENT_TOOLS_URL);
        const unavailable = await media.executePathway({ args: { toolFunction: 'media' } });
        t.truthy(JSON.parse(unavailable).error);
        t.is(calls.length, 1);
    } finally {
        globalThis.fetch = oldFetch;
        if (oldEndpoint === undefined) delete process.env.CONCIERGE_AGENT_TOOLS_URL;
        else process.env.CONCIERGE_AGENT_TOOLS_URL = oldEndpoint;
    }
});
