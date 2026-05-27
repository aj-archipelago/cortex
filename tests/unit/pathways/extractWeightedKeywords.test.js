import test from 'ava';
import extractWeightedKeywords from '../../../pathways/extract_weighted_keywords.js';

const { parser, typeDef } = extractWeightedKeywords;

test('weighted keywords parser accepts a JSON array', (t) => {
    const result = parser('[{"keyword":"earthquake","weight":0.95},{"keyword":"Turkey","weight":0.88}]');

    t.deepEqual(result, [
        { keyword: 'earthquake', weight: 0.95 },
        { keyword: 'Turkey', weight: 0.88 },
    ]);
});

test('weighted keywords parser unwraps keyword objects and markdown fences', (t) => {
    const result = parser('```json\n{"keywords":[{"keyword":"UN Security Council","weight":"0.92"}]}\n```');

    t.deepEqual(result, [
        { keyword: 'UN Security Council', weight: 0.92 },
    ]);
});

test('weighted keywords parser filters invalid items, clamps weights, and sorts descending', (t) => {
    const result = parser(JSON.stringify([
        { keyword: 'low', weight: 0.3 },
        { keyword: '', weight: 0.99 },
        { weight: 0.7 },
        { keyword: 'over max', weight: 1.5 },
        { keyword: 'under min', weight: -0.3 },
    ]));

    t.deepEqual(result, [
        { keyword: 'over max', weight: 1 },
        { keyword: 'low', weight: 0.3 },
        { keyword: 'under min', weight: 0 },
    ]);
});

test('weighted keywords parser returns an empty array for malformed JSON', (t) => {
    t.deepEqual(parser('not json'), []);
});

test('weighted keywords typedef exposes structured keyword results', (t) => {
    const definition = typeDef({ name: 'extract_weighted_keywords', objName: 'ExtractWeightedKeywords' });

    t.regex(definition.gqlDefinition, /type KeywordResult/);
    t.regex(definition.gqlDefinition, /keyword: String/);
    t.regex(definition.gqlDefinition, /weight: Float/);
    t.regex(definition.gqlDefinition, /extend type Query/);
    t.deepEqual(definition.restDefinition, [
        { name: 'text', type: 'String' },
        { name: 'userPrompt', type: 'String' },
    ]);
});
