import test from 'ava';

import googleSearchTool from '../../../pathways/system/entity/tools/sys_tool_google_search.js';
import grokXSearchTool from '../../../pathways/system/entity/tools/sys_tool_grok_x_search.js';
import validateUrlTool from '../../../pathways/system/entity/tools/sys_tool_validate_url.js';

test('SearchInternet schema accepts q or query alias', t => {
    const definition = googleSearchTool.toolDefinition.function;
    const source = googleSearchTool.executePathway.toString();

    t.truthy(definition.parameters.properties.q);
    t.truthy(definition.parameters.properties.query);
    t.deepEqual(definition.parameters.required, []);
    t.true(source.includes('q: args.q || args.query'));
    t.true(source.includes("text: normalizedArgs.q"));
});

test('SearchXPlatform uses current Grok Responses model', t => {
    const source = grokXSearchTool.executePathway.toString();

    t.true(source.includes("model: 'xai-grok-4-20-responses'"));
    t.false(source.includes("model: 'xai-grok-4-1-fast-responses'"));
});

test('ValidateUrl has explicit low tool cost', t => {
    t.is(validateUrlTool.toolDefinition.toolCost, 1);
});
