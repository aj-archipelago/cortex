import { config } from '../../../../config.js';
import { colleagueAgentToolDefinitions } from '../../../../lib/colleagueAgentTools.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    manageTokenLength: false,
    toolDefinition: colleagueAgentToolDefinitions,
    executePathway: ({ args }) => executeAgentTool(args),
};

export async function executeAgentTool(args, definitions = colleagueAgentToolDefinitions) {
    // The endpoint is deployment configuration, never a model-provided URL.
    const endpoint = process.env.CONCIERGE_AGENT_TOOLS_URL;
    if (!endpoint || !args.agentToolsToken)
        return JSON.stringify({
            error: 'Concierge agent tools are unavailable for this run.',
        });
    const tool = definitions.find(
        (d) => d.function.name.toLowerCase() === args.toolFunction,
    );
    if (!tool) return JSON.stringify({ error: 'Unknown Concierge agent tool' });
    const supplied = args._agentToolParameters || args._colleagueToolParameters || {};
    const parameters = Object.fromEntries(
        Object.keys(tool.function.parameters.properties)
            .filter((key) => supplied[key] !== undefined)
            .map((key) => [key, supplied[key]]),
    );
    const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(90000),
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.agentToolsToken}`,
        },
        body: JSON.stringify({
            tool: args.toolFunction,
            args: parameters,
            entityId: args.entityId,
            contextId:
                args.fileAccessPlan?.find((t) => t.userContextId)
                    ?.userContextId || args.contextId,
            callId: `${args._toolRequestId}:${args._parentToolCallId}`,
        }),
    });
    const result = await response.json();
    if (response.ok && args.toolFunction === 'readcolleaguesettings') {
        result.availableModels = Object.entries({
            ...config.get('models'),
            ...config.get('modelGroups'),
        })
            .filter(([, model]) => model.metadata?.isAgentic)
            .map(([id, model]) => ({
                id,
                name: model.metadata?.displayName || id,
            }));
    }
    return JSON.stringify(result);
}
