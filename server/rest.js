// rest.js
// Thin orchestrator that registers all REST route handlers
// and re-exports the public API

import { normalizeResponseOutputText, isLikelyRequestId, extractPathwayErrorMessage } from './rest/restUtils.js';
import { createWeeklyCostMiddleware } from './rest/weeklyCostMiddleware.js';
import { registerModelsRoute } from './rest/modelsRoute.js';
import { registerGenericPathwayRoutes } from './rest/genericPathwayRoute.js';
import { registerOpenAICompletionsRoute } from './rest/openaiCompletionsRoute.js';
import { registerAnthropicMessagesRoute } from './rest/anthropicMessagesRoute.js';
import { registerOpenAIResponsesRoute } from './rest/openaiResponsesRoute.js';

function buildRestEndpoints(pathways, app, server, config) {
    if (config.get('enableRestEndpoints')) {
        const openAIChatModels = {};
        const openAICompletionModels = {};

        // Build model maps from pathway configuration
        for (const [name, pathway] of Object.entries(pathways)) {
            if (pathway.disabled) continue;

            if (pathway.emulateOpenAIChatModel) {
                openAIChatModels[pathway.emulateOpenAIChatModel] = name;
            }
            if (pathway.emulateOpenAICompletionModel) {
                openAICompletionModels[pathway.emulateOpenAICompletionModel] = name;
            }
        }

        // Applies to every public metered generation route, before streaming starts.
        app.post(['/v1/chat/completions', '/v1/completions', '/v1/messages', '/v1/responses'], createWeeklyCostMiddleware());

        // Register all route groups
        registerGenericPathwayRoutes(app, pathways, server);
        registerOpenAICompletionsRoute(app, pathways, openAIChatModels, openAICompletionModels, server);
        registerAnthropicMessagesRoute(app, pathways, openAIChatModels, openAICompletionModels, server);
        registerOpenAIResponsesRoute(app, pathways, openAIChatModels, openAICompletionModels, server);
        registerModelsRoute(app, openAIChatModels, openAICompletionModels, config);
    }
}

export { buildRestEndpoints, normalizeResponseOutputText, isLikelyRequestId, extractPathwayErrorMessage };
