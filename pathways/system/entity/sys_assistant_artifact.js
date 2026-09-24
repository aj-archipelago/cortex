import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import { readAssistantArtifact } from '../../../lib/assistantArtifacts.js';
import { workspaceDownloadToFile } from './tools/shared/workspace_client.js';
export default {
    prompt: [], model: 'oai-gpt41-mini', json: true, manageTokenLength: false,
    inputParameters: { userId: '', entityId: '', path: '', sha256: '' },
    executePathway: async ({ args }) => {
        try { return JSON.stringify(await readAssistantArtifact(getEntityStore(), args, workspaceDownloadToFile)); }
        catch (error) { return JSON.stringify({ error: error.message }); }
    },
};
