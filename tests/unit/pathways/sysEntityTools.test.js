import test from 'ava';
import {
    getAlwaysVisibleLocalToolDefinitions,
    getToolsForEntity,
} from '../../../pathways/system/entity/tools/shared/sys_entity_tools.js';

const toolEntry = (name) => ({
    definition: {
        type: 'function',
        function: {
            name,
            description: `${name} description`,
            parameters: { type: 'object', properties: {} },
        },
    },
});

test('lazy local tool search keeps WorkspaceSSH always visible', (t) => {
    const tools = {
        workspacessh: toolEntry('WorkspaceSSH'),
        searchinternet: toolEntry('SearchInternet'),
    };

    const visible = getAlwaysVisibleLocalToolDefinitions(tools);

    t.deepEqual(visible.map(tool => tool.function.name), ['WorkspaceSSH']);
});

test('default entity does not expose WorkspaceSSH even with wildcard tools', (t) => {
    const entityConfig = {
        isDefault: true,
        tools: ['*'],
        customTools: {
            workspacessh: toolEntry('WorkspaceSSH'),
            searchinternet: toolEntry('SearchInternet'),
        },
    };

    const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);
    const toolNames = entityToolsOpenAiFormat.map(tool => tool.function.name);

    t.false('workspacessh' in entityTools);
    t.true(toolNames.includes('SearchInternet'));
    t.false(toolNames.includes('WorkspaceSSH'));
    t.deepEqual(getAlwaysVisibleLocalToolDefinitions(entityTools), []);
});

test('personal entity keeps WorkspaceSSH when explicitly available', (t) => {
    const entityConfig = {
        isDefault: false,
        tools: ['*'],
        customTools: {
            workspacessh: toolEntry('WorkspaceSSH'),
        },
    };

    const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);
    const toolNames = entityToolsOpenAiFormat.map(tool => tool.function.name);

    t.truthy(entityTools.workspacessh);
    t.true(toolNames.includes('WorkspaceSSH'));
});
