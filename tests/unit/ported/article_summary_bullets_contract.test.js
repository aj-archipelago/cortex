import test from 'ava';
import articleSummary from '../../../pathways/article_summary_bullets.js';

process.env.OPENAI_API_KEY ||= 'test-openai-key';
// Request construction is local; do not initialize shared storage from .env.
process.env.STORAGE_CONNECTION_STRING = '';
process.env.MONGO_URI = '';
const { default: OpenAIVisionPlugin } = await import('../../../server/plugins/openAiVisionPlugin.js');

async function executeSummary({ output, args = {}, modelName = 'oai-gpt4o' } = {}) {
    const model = { name: modelName, type: 'OPENAI-VISION', maxTokenLength: 128000, maxReturnTokens: 4096 };
    const plugin = new OpenAIVisionPlugin(articleSummary, model);
    const resolver = {
        modelName,
        model,
        modelExecutor: { plugin },
        requestId: 'summary-contract-request',
        errors: [],
        logError(message) { this.errors.push(message); },
    };
    let request;
    let calls = 0;
    const result = await articleSummary.executePathway({
        args: { ...articleSummary.inputParameters, text: 'Synthetic article text.', ...args },
        resolver,
        runAllPrompts: async (parameters) => {
            calls++;
            request = await plugin.getRequestParameters(parameters.text, parameters, resolver.pathwayPrompt[0]);
            return output ?? JSON.stringify({ bullets: ['Fact one.', 'Fact two.'] });
        },
    });
    return { result, resolver, request, calls };
}

test('default model sends a strict bullets schema while retaining the caller editorial prompt', async (t) => {
    const customPrompt = 'Write two short facts in English. Return a JSON array of strings.';
    const { request, result, calls } = await executeSummary({ args: { userPrompt: customPrompt, count: 2 } });

    t.deepEqual(request.response_format, {
        type: 'json_schema',
        json_schema: {
            name: 'article_summary_bullets',
            strict: true,
            schema: {
                type: 'object',
                properties: { bullets: { type: 'array', items: { type: 'string' } } },
                required: ['bullets'],
                additionalProperties: false,
            },
        },
    });
    t.true(request.messages[0].content.startsWith(customPrompt));
    t.true(request.messages[0].content.includes('"bullets"'));
    t.is(request.messages[1].content, 'Synthetic article text.');
    t.deepEqual(JSON.parse(result), { bullets: ['Fact one.', 'Fact two.'] });
    t.is(calls, 1);
});

test('other caller-selected models retain the format instruction without an unverified schema option', async (t) => {
    const { request, resolver } = await executeSummary({
        modelName: 'caller-selected-model',
        args: { model: 'caller-selected-model', userPrompt: 'Summarise in Arabic.' },
    });

    t.is(resolver.modelName, 'caller-selected-model');
    t.is(request.response_format, undefined);
    t.true(request.messages[0].content.startsWith('Summarise in Arabic.'));
    t.true(request.messages[0].content.includes('"bullets"'));
});

test('count remains a prompt hint rather than a validation constraint', async (t) => {
    const { result, resolver } = await executeSummary({ args: { count: 5 } });
    t.deepEqual(JSON.parse(result), { bullets: ['Fact one.', 'Fact two.'] });
    t.deepEqual(resolver.errors, []);
});

for (const [label, value] of [
    ['array', ['Private summary text']],
    ['wrong object', { status: 'Private summary text' }],
    ['empty bullets', { bullets: [] }],
    ['mixed bullet types', { bullets: ['Private summary text', 7] }],
    ['blank bullet', { bullets: ['   '] }],
    ['null', null],
]) {
    test(`invalid ${label} returns null with correlated diagnostics and no article content`, async (t) => {
        const { result, resolver } = await executeSummary({ output: JSON.stringify(value) });
        t.is(result, null);
        t.is(resolver.errors.length, 1);
        t.regex(resolver.errors[0], /expected.*bullets/);
        t.true(resolver.errors[0].includes('summary-contract-request'));
        t.false(resolver.errors[0].includes('Private summary text'));
        t.false(resolver.errors[0].includes('Synthetic article text'));
    });
}

test('the duplicate-article placeholder guard still rejects without a provider call', async (t) => {
    const { result, calls, resolver } = await executeSummary({ args: { userPrompt: 'Summarise {{text}}.' } });
    t.is(result, null);
    t.is(calls, 0);
    t.regex(resolver.errors[0], /\{\{text\}\}/);
});
