import test from 'ava';

import runWorkspaceAgent from '../../../pathways/system/workspaces/run_workspace_agent.js';
import runWorkspacePrompt from '../../../pathways/system/workspaces/run_workspace_prompt.js';

test('workspace prompt uses generic entity defaults and file access plan input', t => {
    t.is(runWorkspacePrompt.inputParameters.entityId, 'jarvis');
    t.is(runWorkspacePrompt.inputParameters.aiName, 'Jarvis');
    t.truthy(runWorkspacePrompt.inputParameters.fileAccessPlan);
    t.is(runWorkspacePrompt.inputParameters.fileAccessPlan.items.objType, 'FileAccessTargetInput');
    t.falsy(runWorkspacePrompt.inputParameters.agentContext);
});

test('workspace agent forwards file access plan input shape', t => {
    t.truthy(runWorkspaceAgent.inputParameters.fileAccessPlan);
    t.is(runWorkspaceAgent.inputParameters.fileAccessPlan.items.objType, 'FileAccessTargetInput');
    t.truthy(Object.hasOwn(runWorkspaceAgent.inputParameters, 'contextId'));
    t.truthy(Object.hasOwn(runWorkspaceAgent.inputParameters, 'contextKey'));
    t.falsy(runWorkspaceAgent.inputParameters.agentContext);
    t.falsy(Object.hasOwn(runWorkspaceAgent.inputParameters, 'researchMode'));
});
