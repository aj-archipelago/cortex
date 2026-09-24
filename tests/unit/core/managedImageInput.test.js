import test from 'ava';
import sinon from 'sinon';
import axios from 'axios';
import { config } from '../../../config.js';
import { cfhAxios } from '../../../lib/cfhClient.js';
import { inlineManagedImageInputs } from '../../../lib/managedImageInput.js';
import { runWithFreshImageUrls } from '../../../lib/imageUrlLifecycle.js';
import OpenAIResponsesPlugin from '../../../server/plugins/openAiResponsesPlugin.js';
import { Prompt } from '../../../server/prompt.js';

const signed = () => `https://files.blob.core.windows.net/cortexfiles-owner/chats/chat/photo.png?se=${encodeURIComponent(new Date(Date.now() + 300_000).toISOString())}&sig=fixture`;
const plan = [{ kind: 'chat', userContextId: 'owner', chatId: 'chat' }];
const source = url => ({ type: 'image_url', url, image_url: { url }, blobPath: 'chats/chat/photo.png', _contextId: 'owner' });
const messages = url => [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }];
const history = url => [{ role: 'user', content: [JSON.stringify(source(url))] }];

test.serial('provider URL timeout retries the same large image inline without changing history or tool output', async t => {
    const url = signed();
    const bytes = Buffer.alloc(10_811_255, 65); // Size of the PNG in the reported failure.
    const originalHistory = [
        { role: 'tool', tool_call_id: 'already-done', content: 'completed tool result' },
        ...history(url),
        { role: 'user', content: [{ type: 'text', text: `Image URLs for markdown: ${url}` }] },
    ];
    const args = { chatHistory: structuredClone(originalHistory), fileAccessPlan: plan };
    const resolver = { errors: [], args };
    const plugin = new OpenAIResponsesPlugin({ name: 'preview' }, { name: 'mock', emulateOpenAIChatModel: 'mock', type: 'OPENAI-RESPONSES', maxTokenLength: 100_000 });
    const head = sinon.stub(axios, 'head').resolves({ headers: { 'content-type': 'image/png' } });
    const get = sinon.stub(axios, 'get').resolves({ data: bytes, headers: { 'content-type': 'image/png' } });
    const lookup = sinon.stub(cfhAxios, 'get').resolves({ status: 200, data: { url, shortLivedUrl: url } });
    const previous = config.get('whisperMediaApiUrl');
    config.set('whisperMediaApiUrl', 'https://cfh.example/');
    t.teardown(() => { head.restore(); get.restore(); lookup.restore(); config.set('whisperMediaApiUrl', previous); });
    let calls = 0;
    plugin.executeRequest = async request => {
        calls++;
        const input = request.data.input;
        const image = input.flatMap(m => m.content || []).find(p => p.type === 'input_image');
        t.true(input.some(m => m.type === 'function_call_output' && m.output === 'completed tool result'));
        t.false('_inlineManagedImages' in request.data);
        if (calls === 1) {
            t.is(image.image_url, url);
            t.is(get.callCount, 0); // Healthy requests never fetch inline bytes.
            throw new Error('Unable to download content from the provided URL before the timeout.');
        }
        t.true(Buffer.from(image.image_url.split(',')[1], 'base64').equals(bytes));
        t.true(input.some(m => m.content?.some?.(p => p.text === `Image URLs for markdown: ${url}`)));
        return { output_text: 'Image identified.' };
    };
    const run = next => plugin.execute('', next, new Prompt({ messages: ['{{chatHistory}}'] }), {});
    await runWithFreshImageUrls(args, resolver, run, { renew: async () => source(url) });
    t.is(calls, 2);
    t.is(get.callCount, 1);
    t.deepEqual(args.chatHistory, originalHistory);
    t.false(JSON.stringify(args).includes('base64'));
    await runWithFreshImageUrls(args, resolver, run);
    t.is(calls, 3);
    t.is(get.callCount, 1); // Reused only within this resolver/request.
    t.deepEqual(resolver.errors, []);
});

test('inline reads require scoped authorization and never remap versioned or unrelated files', async t => {
    const url = signed();
    const get = sinon.stub().throws(new Error('No GET should be made'));
    for (const [item, access] of [
        [source(url), []],
        [source(url), [{ kind: 'chat', userContextId: 'other', chatId: 'chat' }]],
        [source(url), [{ kind: 'chat', userContextId: 'owner', chatId: 'other' }]],
        [source(`${url}&versionid=old`), plan],
        [{ ...source(url), url: 'https://external.example/photo.png' }, plan],
    ]) {
        const input = messages(item.url);
        const result = await inlineManagedImageInputs(input, [{ role: 'user', content: [item] }], access, {}, { get });
        t.deepEqual(result, input);
    }
    t.is(get.callCount, 0);
});

test('duplicate images share a download but each occurrence counts toward the request byte limit', async t => {
    const url = signed();
    const input = [{ role: 'user', content: Array(3).fill(messages(url)[0].content[0]) }];
    const renew = sinon.stub().resolves(source(url));
    const get = sinon.stub().resolves({ data: Buffer.alloc(4), headers: { 'content-type': 'image/png' } });
    const result = await inlineManagedImageInputs(input, history(url), plan, {}, { renew, get, maxInputBytes: 8 });
    t.is(get.callCount, 1);
    t.is(renew.callCount, 1);
    t.true(result[0].content[0].image_url.url.startsWith('data:image/png;base64,'));
    t.is(result[0].content[2].image_url.url, url);
    t.is(input[0].content[0].image_url.url, url);
    t.like(get.firstCall.args[1], { maxRedirects: 0, timeout: 20_000, maxContentLength: 8 });
});

test('invalid MIME, oversized images, empty images and failed downloads retain the original URL', async t => {
    const url = signed();
    for (const response of [
        { data: Buffer.alloc(4), headers: { 'content-type': 'text/html' } },
        { data: Buffer.alloc(9), headers: { 'content-type': 'image/png' } },
        { data: Buffer.alloc(0), headers: { 'content-type': 'image/png' } },
        new Error('download failed with sensitive HTTP config'),
    ]) {
        const get = response instanceof Error ? sinon.stub().rejects(response) : sinon.stub().resolves(response);
        t.deepEqual(await inlineManagedImageInputs(messages(url), history(url), plan, {}, {
            renew: async () => source(url), get, maxImageBytes: 8,
        }), messages(url));
    }
    const get = sinon.stub();
    for (const forbidden of ['http://files.blob.core.windows.net/file', 'https://evil.example/file', 'https://user:pass@files.blob.core.windows.net/file']) {
        await inlineManagedImageInputs(messages(url), history(url), plan, {}, { renew: async () => ({ url: forbidden }), get });
    }
    t.is(get.callCount, 0);
});

test('inline cache stays within its byte limit and is separated by access plan', async t => {
    const url = signed();
    const state = {};
    const renew = sinon.stub().resolves(source(url));
    const get = sinon.stub().resolves({ data: Buffer.alloc(8), headers: { 'content-type': 'image/png' } });
    const options = { renew, get, maxInputBytes: 8 };
    await inlineManagedImageInputs(messages(url), history(url), plan, state, options);
    await inlineManagedImageInputs(messages(url), history(url), plan, state, options);
    t.is(get.callCount, 1);
    await inlineManagedImageInputs(messages(url), history(url), [{ ...plan[0], write: true }], state, options);
    t.is(get.callCount, 2);
    t.is(state.images.size, 1);
    t.is(state.bytes, 8);
});

test('Responses diagnostics redact bytes before token estimation and debug output', t => {
    const plugin = new OpenAIResponsesPlugin({ name: 'preview' }, { name: 'mock' });
    const image = `data:image/png;base64,${Buffer.alloc(1024, 65).toString('base64')}`;
    const estimated = [];
    plugin.getLength = text => { estimated.push(text); return { length: text.length, units: 'tokens' }; };
    const prompt = { debugInfo: 'debug' };
    plugin.logRequestData({ stream: true, input: [{ role: 'user', content: [{ type: 'input_image', image_url: image }] }] }, null, prompt);
    t.false(prompt.debugInfo.includes(image));
    t.false(estimated.some(text => text.includes(image)));
    t.true(prompt.debugInfo.includes('base64 data truncated'));
});
