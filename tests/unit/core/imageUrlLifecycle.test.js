import test from 'ava';
import sinon from 'sinon';
import axios from 'axios';
import { config } from '../../../config.js';
import { cfhAxios } from '../../../lib/cfhClient.js';
import { ensureShortLivedUrl, renewManagedImageUrl } from '../../../lib/fileUtils.js';
import { getSignedUrlTiming, isSignedUrlFresh } from '../../../lib/signedUrlExpiry.js';
import { refreshChatImageUrls, runWithFreshImageUrls } from '../../../lib/imageUrlLifecycle.js';
import ModelPlugin from '../../../server/plugins/modelPlugin.js';
import OpenAIResponsesPlugin from '../../../server/plugins/openAiResponsesPlugin.js';
import { Prompt } from '../../../server/prompt.js';

const epoch = Date.parse('2026-09-23T18:00:00Z');
const signed = (expiresAt = epoch + 300_000, path = 'chats/chat/preview.png') =>
    `https://files.blob.core.windows.net/cortexfiles-owner/${path}?se=${encodeURIComponent(new Date(expiresAt).toISOString())}&sig=fixture`;
const plan = [{ kind: 'chat', userContextId: 'owner', chatId: 'chat' }];
const image = (url = signed()) => ({ type: 'image_url', url, image_url: { url }, blobPath: 'chats/chat/preview.png', _contextId: 'owner', originalFilename: 'preview.png' });
const history = item => [{ role: 'user', content: [item, structuredClone(item)] }];

// No timers or HTTP: use the same URL-derived decision as the production path.
test('signed expiry handles Azure boundaries, start time, delegation, and GCS formats', t => {
    t.true(isSignedUrlFresh(signed(), { now: epoch }));
    t.false(isSignedUrlFresh(signed(epoch + 60_000), { now: epoch }));
    t.false(isSignedUrlFresh(signed(epoch - 1), { now: epoch }));
    t.false(isSignedUrlFresh(`${signed()}&st=2026-09-23T18%3A00%3A01Z`, { now: epoch }));
    t.false(isSignedUrlFresh(`${signed()}&ske=2026-09-23T18%3A00%3A30Z`, { now: epoch }));
    t.false(isSignedUrlFresh('https://files.example/image?se=garbage', { now: epoch }));
    t.false(isSignedUrlFresh('https://files.example/image', { now: epoch }));
    t.false(isSignedUrlFresh(signed(epoch + 86_400_000), { now: epoch, maxRemainingMs: 300_000 }));
    t.is(getSignedUrlTiming('https://storage.googleapis.com/b/file?X-Goog-Date=20260923T180000Z&X-Goog-Expires=300').expiresAt, epoch + 300_000);
    t.is(getSignedUrlTiming(`https://storage.googleapis.com/b/file?GoogleAccessId=fixture&Expires=${(epoch + 300_000) / 1000}`).expiresAt, epoch + 300_000);
});

test('forty tool rounds over twenty minutes renew only at the margin, once per image', async t => {
    let now = epoch;
    let renewals = 0;
    const state = {};
    let messages = history(image());
    const renew = async item => { renewals++; return image(signed(now + 300_000)); };
    for (let round = 0; round <= 40; round++) {
        now = epoch + round * 30_000;
        const result = await refreshChatImageUrls(messages, plan, state, { now: () => now, renew });
        messages = result.chatHistory;
        t.true(isSignedUrlFresh(messages[0].content[0].url, { now }));
        t.is(messages[0].content[0].url, messages[0].content[1].url);
    }
    t.is(renewals, 5);
});

test('fresh rounds do no renewal; concurrent stale copies share renewal and preserve labels', async t => {
    const state = {};
    const renew = sinon.stub().callsFake(async () => image(signed(epoch + 300_000)));
    const fresh = history(image());
    await refreshChatImageUrls(fresh, plan, state, { now: () => epoch, renew });
    t.is(renew.callCount, 0);
    const stale = history(image(signed(epoch - 1)));
    stale[0].content[1].originalFilename = 'second occurrence';
    const results = await Promise.all(Array.from({ length: 10 }, () => refreshChatImageUrls(stale, plan, state, { now: () => epoch, renew })));
    t.is(renew.callCount, 1);
    t.is(results[0].chatHistory[0].content[1].originalFilename, 'second occurrence');
    t.is(stale[0].content[0].url, signed(epoch - 1));
});

test('failed refreshes back off and versioned/external images are not renewed', async t => {
    const state = {};
    const renew = sinon.stub().resolves(null);
    const stale = history(image(signed(epoch - 1)));
    await refreshChatImageUrls(stale, plan, state, { now: () => epoch, renew });
    await refreshChatImageUrls(stale, plan, state, { now: () => epoch + 1000, renew });
    t.is(renew.callCount, 1);
    const special = [{ role: 'user', content: [image(`${signed(epoch - 1)}&versionid=snapshot`), { type: 'image_url', image_url: { url: 'https://external.example/preview' } }] }];
    await refreshChatImageUrls(special, plan, state, { now: () => epoch, renew });
    t.is(renew.callCount, 1);
});

test('URL download recovery retries one model call and preserves completed tool work', async t => {
    const tool = { role: 'tool', tool_call_id: 'done', content: 'report already written' };
    const args = { chatHistory: [tool, ...history(image())], fileAccessPlan: plan };
    const resolver = { errors: [], args: { ...args } };
    const renew = sinon.stub().resolves(image(signed(epoch + 400_000)));
    let calls = 0;
    const run = async next => {
        calls++;
        t.deepEqual(next.chatHistory[0], tool);
        if (calls === 1) { resolver.errors.push('Unable to download content from the provided URL before the timeout.'); return null; }
        t.is(next.chatHistory[1].content[0].url, signed(epoch + 400_000));
        return 'completed';
    };
    t.is(await runWithFreshImageUrls(args, resolver, run, { now: () => epoch, renew }), 'completed');
    t.is(calls, 2);
    t.is(renew.callCount, 1);
    t.deepEqual(resolver.errors, []);
    t.is(resolver.args.chatHistory, args.chatHistory);
});

test('recovery never loops, retries unrelated errors, or retries after cancellation', async t => {
    for (const [message, canceled, expectedCalls] of [
        ['Unable to download content from the provided URL before the timeout.', false, 2],
        ['rate limit exceeded', false, 1],
        ['Unable to download content from the provided URL before the timeout.', true, 0],
    ]) {
        const args = { chatHistory: history(image()), fileAccessPlan: plan };
        const resolver = { errors: [] };
        const renew = async () => image(signed(epoch + 400_000));
        let calls = 0;
        const result = await runWithFreshImageUrls(args, resolver, async () => {
            calls++; resolver.errors.push(message); return null;
        }, { now: () => epoch, renew, isCanceled: () => canceled });
        t.is(result, null);
        t.is(calls, expectedCalls);
    }
});

test.serial('short-lived helper reuses fresh URLs and still narrows long-lived storage URLs', async t => {
    const now = Date.now();
    const fresh = signed(now + 300_000);
    const get = sinon.stub(cfhAxios, 'get').resolves({ status: 200, data: { url: signed(now + 86_400_000), shortLivedUrl: fresh } });
    t.teardown(() => get.restore());
    t.is((await ensureShortLivedUrl({ ...image(fresh) }, 'https://cfh.example/', 'owner')).url, fresh);
    t.is(get.callCount, 0);
    t.is((await ensureShortLivedUrl(image(signed(now + 86_400_000)), 'https://cfh.example/', 'owner')).url, fresh);
    t.is(get.callCount, 1);
});

test.serial('renewal enforces the current access plan and exact storage identity', async t => {
    const previous = config.get('whisperMediaApiUrl');
    config.set('whisperMediaApiUrl', 'https://cfh.example/');
    const fresh = signed(Date.now() + 300_000);
    const get = sinon.stub(cfhAxios, 'get').resolves({ status: 200, data: { url: fresh, shortLivedUrl: fresh } });
    t.teardown(() => { get.restore(); config.set('whisperMediaApiUrl', previous); });
    t.is(await renewManagedImageUrl({ ...image(), _contextId: 'someone-else' }, plan), null);
    t.is(await renewManagedImageUrl(image(), [{ kind: 'chat', userContextId: 'owner', chatId: 'different' }]), null);
    t.is(await renewManagedImageUrl(image(`${signed()}&snapshot=old`), plan), null);
    t.is(get.callCount, 0);
    const result = await renewManagedImageUrl(image(), plan);
    t.is(result.url, fresh);
    const request = new URL(get.firstCall.args[0]);
    t.is(request.searchParams.get('contextId'), 'owner');
    t.is(request.searchParams.get('chatId'), 'chat');
    t.is(request.searchParams.get('fileScope'), 'chat');
    t.is(request.searchParams.get('ensureBackup'), 'false');
    get.resolves({ status: 200, data: { url: fresh.replace('cortexfiles-owner', 'cortexfiles-other') } });
    t.is(await renewManagedImageUrl(image(), plan), null);
});

test.serial('validation uses one HEAD for concurrent signed images and none after expiry', async t => {
    const clock = sinon.useFakeTimers({ now: epoch, toFake: ['Date'] });
    const head = sinon.stub(axios, 'head').resolves({ headers: { 'content-type': 'image/png' } });
    t.teardown(() => { head.restore(); clock.restore(); });
    const plugin = new ModelPlugin({}, { name: 'test' });
    t.true((await Promise.all(Array.from({ length: 20 }, () => plugin.validateImageUrl(signed())))).every(Boolean));
    t.is(head.callCount, 1);
    clock.setSystemTime(epoch + 240_000);
    t.false(await plugin.validateImageUrl(signed()));
    t.is(head.callCount, 1);
    t.true(await plugin.validateImageUrl(signed(epoch + 540_000)));
    t.is(head.callCount, 2);
    head.resolves({ headers: { 'content-type': 'text/html' } });
    t.false(await plugin.validateImageUrl(signed(epoch + 550_000)));
});

test.serial('Responses receives a renewed preview and preserves unavailable-image guidance', async t => {
    const clock = sinon.useFakeTimers({ now: epoch, toFake: ['Date'] });
    const head = sinon.stub(axios, 'head').resolves({ headers: { 'content-type': 'image/png' } });
    t.teardown(() => { head.restore(); clock.restore(); });
    const plugin = new OpenAIResponsesPlugin({ name: 'test' }, { name: 'test', emulateOpenAIChatModel: 'test' });
    let payload;
    plugin.executeRequest = async request => { payload = request.data; return 'done'; };
    const args = { chatHistory: history(image(signed(epoch - 1))), fileAccessPlan: plan };
    await runWithFreshImageUrls(args, { errors: [] }, next => plugin.execute('', next, new Prompt({ messages: ['{{chatHistory}}'] }), {}), {
        now: () => epoch, renew: async () => image(),
    });
    const inputs = payload.input.flatMap(m => Array.isArray(m.content) ? m.content : []);
    t.is(inputs.filter(x => x.type === 'input_image').length, 2);
    t.true(inputs.filter(x => x.type === 'input_image').every(x => x.image_url === signed()));
    t.is(head.callCount, 1);
    const unavailable = await plugin.tryParseMessages(history(image(signed(epoch - 1))));
    t.regex(unavailable[0].content[0].text, /does not establish that the original file is missing/);
    t.false(unavailable[0].content[0].text.includes('sig='));
});

test('renewed markdown references match vision input while user-authored text is preserved', async t => {
    const old = signed(epoch - 1);
    const messages = [
        { role: 'user', content: [{ type: 'text', text: `Image URLs for markdown: preview.png: ${old}` }, image(old)] },
        { role: 'user', content: `User supplied this URL: ${old}` },
    ];
    const result = await refreshChatImageUrls(messages, plan, {}, { now: () => epoch, renew: async () => image() });
    t.is(result.chatHistory[0].content[0].text, `Image URLs for markdown: preview.png: ${signed()}`);
    t.is(result.chatHistory[1].content, messages[1].content);
});

test('renewal fan-out is bounded and cancellation during renewal prevents a model call', async t => {
    const messages = [{ role: 'user', content: Array.from({ length: 24 }, (_, i) => ({
        ...image(signed(epoch - 1, `chats/chat/${i}.png`)), blobPath: `chats/chat/${i}.png`,
    })) }];
    let active = 0;
    let peak = 0;
    const renew = async item => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return { ...item, url: signed(epoch + 300_000, item.blobPath) };
    };
    await refreshChatImageUrls(messages, plan, {}, { now: () => epoch, renew });
    t.is(peak, 8);
    let canceled = false;
    const run = sinon.stub().resolves('must not run');
    await runWithFreshImageUrls({ chatHistory: history(image(signed(epoch - 1))), fileAccessPlan: plan }, { errors: [] }, run, {
        now: () => epoch, isCanceled: () => canceled,
        renew: async () => { canceled = true; return image(); },
    });
    t.is(run.callCount, 0);
});
