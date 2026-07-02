import test from 'ava';
import cognitiveSearchTool, {
    resolveToolIndexName,
} from '../../../pathways/system/entity/tools/sys_tool_cognitive_search.js';

test('SearchIndex schema lists valid indexes and rejects invalid index with choices', async (t) => {
    const definition = cognitiveSearchTool.toolDefinition[0].function;

    t.true(definition.description.includes('aja, aje, ajb, ajm, aj360, ajd, chinese, sanad, wires'));
    t.deepEqual(definition.parameters.properties.index.enum, [
        'aja',
        'aje',
        'ajb',
        'ajm',
        'aj360',
        'ajd',
        'chinese',
        'sanad',
        'wires',
    ]);
    t.truthy(definition.parameters.properties.query);
    t.deepEqual(definition.parameters.required, ['index']);

    const error = await t.throwsAsync(cognitiveSearchTool.executePathway({
        args: {
            index: 'news',
            query: 'Anthropic SpaceX',
        },
        resolver: { errors: [] },
    }));

    t.true(error.message.includes('Invalid index: news'));
    t.true(error.message.includes('Valid indexes: aja, aje, ajb, ajm, aj360, ajd, chinese, sanad, wires'));
    t.true(error.message.includes('Use wires for news wires'));
});

test('SearchIndex validates missing text/query before dispatch', async (t) => {
    const missingText = await t.throwsAsync(cognitiveSearchTool.executePathway({
        args: {
            index: 'wires',
        },
        resolver: { errors: [] },
    }));

    t.true(missingText.message.includes("Parameter 'text' or alias 'query' is required"));
});

test('SearchIndex maps logical index before honoring supplied indexName', (t) => {
    t.is(resolveToolIndexName({ index: 'aje', indexName: 'aje' }), 'idx-ucms-aje');
    t.is(resolveToolIndexName({ index: 'wires', indexName: 'wires' }), 'idx-wires');
    t.is(resolveToolIndexName({ index: 'aje', indexName: 'wires' }), 'idx-ucms-aje');
});

test('SearchIndex keeps custom physical indexName when no logical index is supplied', (t) => {
    t.is(resolveToolIndexName({ indexName: 'vector-tony-vision-resource' }), 'vector-tony-vision-resource');
    t.is(resolveToolIndexName({ indexName: 'business-performance-index' }), 'business-performance-index');
    t.is(resolveToolIndexName({ indexName: 'aje' }), 'idx-ucms-aje');
    t.is(resolveToolIndexName({ indexName: 'wires' }), 'idx-wires');
});
