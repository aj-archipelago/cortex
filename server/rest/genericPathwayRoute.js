// rest/genericPathwayRoute.js
// POST /rest/{name} endpoints for non-emulation pathways

import { processRestRequest } from './processRestRequest.js';
import { extractResponseData } from './restUtils.js';

function registerGenericPathwayRoutes(app, pathways, server) {
    for (const [name, pathway] of Object.entries(pathways)) {
        if (pathway.disabled) continue;
        if (pathway.emulateOpenAIChatModel || pathway.emulateOpenAICompletionModel) continue;

        app.post(`/rest/${name}`, async (req, res) => {
            const pathwayResponse = await processRestRequest(server, req, pathway, name);
            const { resultText } = extractResponseData(pathwayResponse);
            res.send(resultText);
        });
    }
}

export { registerGenericPathwayRoutes };
