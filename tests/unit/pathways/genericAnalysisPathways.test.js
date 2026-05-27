import test from 'ava';
import benchmark from '../../../pathways/benchmark.js';
import tagImage from '../../../pathways/tag_image.js';
import {
    buildCosineSimilarityResult,
    cosineSimilarity,
} from '../../../pathways/cosine_similarity.js';

test('benchmark pathway passes text through without caching', t => {
    t.is(benchmark.prompt, '{{text}}');
    t.false(benchmark.useInputChunking);
    t.false(benchmark.enableCache);
    t.deepEqual(Object.keys(benchmark.inputParameters), ['model', 'reasoningEffort']);
});

test('cosineSimilarity handles identical, orthogonal, and zero vectors', t => {
    t.is(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
    t.is(cosineSimilarity([1, 0], [0, 1]), 0);
    t.is(cosineSimilarity([0, 0], [1, 2]), 0);
    t.throws(() => cosineSimilarity([1], [1, 2]), {
        message: 'Vectors must have the same length',
    });
});

test('buildCosineSimilarityResult ranks candidates using injected embeddings', async t => {
    const embeddings = new Map([
        ['alpha', [[1, 0]]],
        ['near alpha', [[0.9, 0.1]]],
        ['beta', [[0, 1]]],
        ['empty', [[0, 0]]],
    ]);
    const calls = [];

    const result = await buildCosineSimilarityResult({
        text: 'alpha',
        input: ['beta', 'near alpha', '', 'empty'],
        embeddingPathway: async (pathwayName, args) => {
            calls.push({ pathwayName, args });
            return JSON.stringify(embeddings.get(args.input[0]));
        },
    });

    t.is(result.text, 'alpha');
    t.is(result.totalStrings, 3);
    t.deepEqual(result.results.map(item => item.string), ['near alpha', 'beta', 'empty']);
    t.true(result.results[0].similarity > result.results[1].similarity);
    t.true(calls.every(call => call.pathwayName === 'embeddings'));
    t.deepEqual(calls.map(call => call.args.model), [
        'azure-embeddings',
        'azure-embeddings',
        'azure-embeddings',
        'azure-embeddings',
    ]);
});

test('buildCosineSimilarityResult rejects empty inputs before embedding calls', async t => {
    await t.throwsAsync(
        buildCosineSimilarityResult({
            text: 'alpha',
            input: ['   '],
            embeddingPathway: async () => {
                throw new Error('should not be called');
            },
        }),
        { message: 'Input must contain at least one non-empty string' },
    );
});

test('tag_image uses generic image tagging instructions and JSON output', t => {
    t.true(tagImage.json);
    t.false(tagImage.useInputChunking);
    t.is(tagImage.inputParameters.model, 'oai-gpt4o');

    const [systemMessage, chatHistoryTemplate] = tagImage.prompt[0].messages;
    t.regex(systemMessage.content, /AI image analysis and tagging assistant/);
    t.regex(systemMessage.content, /valid JSON object/);
    t.regex(systemMessage.content, /Identify public figures/);
    t.is(chatHistoryTemplate, '{{chatHistory}}');
    t.false(/news agency/i.test(systemMessage.content));
});
