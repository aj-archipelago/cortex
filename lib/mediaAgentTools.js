import { COLLEAGUE_AGENT_TOOL_NAMES } from './colleagueAgentTools.js';

export const mediaAgentToolDefinition = {
    type: 'function',
    icon: '🎨',
    function: {
        name: 'Media',
        description: 'Discover and run media models: images, video, music, speech, editing, dubbing, upscaling. Search, then describe a model for settings. Generate queues a job and displays a live result card in this chat. Give one short setup; do not repeat the brief or narrate each lookup. Cards update automatically: do not poll just to display results or send the user elsewhere. Use status when outputs are needed for another workflow step. Reuse receipts; never generate to check status.',
        parameters: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['search', 'describe', 'generate', 'status'] },
                query: { type: 'string', description: 'Search keywords or model name.' },
                category: { type: 'string', enum: ['image', 'video', 'audio', 'tts', 'upscaling'] },
                offset: { type: 'integer', minimum: 0, description: 'Next offset from a search receipt.' },
                model: { type: 'string', description: 'Exact model ID from search.' },
                prompt: { type: 'string' },
                settings: { type: 'object', description: 'Flat model parameters from describe. Also accepted by describe to resolve conditional options.' },
                references: { type: 'array', maxItems: 50, items: { type: 'object' }, description: 'Reference objects per describe: type and fileId, mediaId, blobPath/hash, or public url; optional role.' },
                outputFolder: { type: 'string', description: 'Relative Files folder; defaults to media.' },
                requestKey: { type: 'string', description: 'Required for generate: unique name for this generation, e.g. scene-1-v1. Reuse only to retry; a changed request needs a new key.' },
                taskId: { type: 'string', description: 'Exact generation receipt ID for status.' },
                waitSeconds: { type: 'integer', minimum: 0, maximum: 20, description: 'Status only: wait up to 20 seconds for completion without another model turn.' },
                userMessage: { type: 'string', description: 'Briefly describe this action.' },
            },
            required: ['operation', 'userMessage'],
        },
    },
};

// Capability binding and parameter forwarding are shared; visibility is not.
// Media remains deferred behind SearchAvailableTools.
export const CONCIERGE_AGENT_TOOL_NAMES = new Set([...COLLEAGUE_AGENT_TOOL_NAMES, 'media']);

export const isLiveMediaStatus = (name, pathway, parameters) =>
    name === 'media' && pathway === 'sys_tool_media' && parameters?.operation === 'status';

// Only a server media-generation receipt can attach a live card. Never send
// arbitrary tool output, URLs or model-supplied task IDs as presentation data.
export function mediaTaskPresentation(name, pathway, parameters, result) {
    if (name !== 'media' || pathway !== 'sys_tool_media' || parameters?.operation !== 'generate') return {};
    try {
        let value = typeof result === 'string' ? JSON.parse(result) : result;
        if (value?.result) value = typeof value.result === 'string' ? JSON.parse(value.result) : value.result;
        const receipt = value?.mediaTask;
        if (!receipt || !/^[a-f0-9]{24}$/i.test(receipt.taskId) || !['image', 'video', 'audio'].includes(receipt.type)) return {};
        return { mediaTask: {
            taskId: receipt.taskId, type: receipt.type,
            model: String(receipt.model || '').slice(0, 128),
            name: String(receipt.name || receipt.model || '').slice(0, 160),
        } };
    } catch { return {}; }
}
