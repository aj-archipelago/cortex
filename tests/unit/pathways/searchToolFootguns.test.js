import test from 'ava';
import cognitiveSearchTool, {
    resolveToolIndexName,
} from '../../../pathways/system/entity/tools/sys_tool_cognitive_search.js';

test('SearchIndex schema lists valid indexes and rejects invalid index with choices', async (t) => {
    const definition = cognitiveSearchTool.toolDefinition[0].function;

    t.true(definition.description.includes('wires'));
    t.deepEqual(definition.parameters.properties.index.enum, ['wires']);
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
    t.true(error.message.includes('Valid indexes: wires'));
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
    const indexes = { news_en: 'sample-news', wires: 'idx-wires' };
    t.is(resolveToolIndexName({ index: 'news_en', indexName: 'news_en' }, indexes), 'sample-news');
    t.is(resolveToolIndexName({ index: 'wires', indexName: 'wires' }), 'idx-wires');
    t.is(resolveToolIndexName({ index: 'NEWS_EN', indexName: 'wires' }, indexes), 'sample-news');
    t.is(resolveToolIndexName({ index: 'unknown', indexName: 'idx-wires' }, indexes), '');
});

test('SearchIndex keeps custom physical indexName when no logical index is supplied', (t) => {
    t.is(resolveToolIndexName({ indexName: 'sample-documents' }), 'sample-documents');
    t.is(resolveToolIndexName({ indexName: ' news_en ' }, { news_en: 'sample-news' }), 'sample-news');
    t.is(resolveToolIndexName({ indexName: 'wires' }), 'idx-wires');
});
