import test from 'ava';
import { extractClientToolImages } from '../../../lib/pathwayTools.js';

test('passes string data through unchanged with no images', t => {
    const out = extractClientToolImages('hello world');
    t.is(out.result, 'hello world');
    t.deepEqual(out.toolImages, []);
});

test('passes null / number / boolean through with no images', t => {
    t.deepEqual(extractClientToolImages(null), { result: 'null', toolImages: [] });
    t.deepEqual(extractClientToolImages(42), { result: '42', toolImages: [] });
    t.deepEqual(extractClientToolImages(true), { result: 'true', toolImages: [] });
});

test('extracts top-level screenshot envelope into a data: URL image_url', t => {
    const data = {
        contentType: 'html',
        current: { title: 'page', workspacePath: null },
        screenshot: { type: 'image', mimeType: 'image/png', base64: 'AAAA' },
    };
    const out = extractClientToolImages(data);
    t.deepEqual(out.toolImages, [
        { image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    const cleaned = JSON.parse(out.result);
    t.false('screenshot' in cleaned, 'screenshot should be stripped from result');
    t.is(cleaned.contentType, 'html', 'other fields preserved');
    t.is(cleaned.current.title, 'page');
});

test('honors mime_type alias and falls back to image/png', t => {
    const out = extractClientToolImages({ screenshot: { mime_type: 'image/jpeg', base64: '/9j/' } });
    t.is(out.toolImages[0].image_url.url, 'data:image/jpeg;base64,/9j/');

    const out2 = extractClientToolImages({ screenshot: { base64: 'X' } });
    t.is(out2.toolImages[0].image_url.url, 'data:image/png;base64,X');
});

test('handles a screenshots array', t => {
    const out = extractClientToolImages({
        screenshots: [
            { mimeType: 'image/png', base64: 'A' },
            { mimeType: 'image/jpeg', base64: 'B' },
        ],
        keep: 'me',
    });
    t.is(out.toolImages.length, 2);
    t.is(out.toolImages[0].image_url.url, 'data:image/png;base64,A');
    t.is(out.toolImages[1].image_url.url, 'data:image/jpeg;base64,B');
    const cleaned = JSON.parse(out.result);
    t.false('screenshots' in cleaned);
    t.is(cleaned.keep, 'me');
});

test('skips screenshot envelopes with no base64 (e.g. failed capture)', t => {
    const out = extractClientToolImages({ screenshot: { mimeType: 'image/png' } });
    t.deepEqual(out.toolImages, []);
    // Also strips the empty envelope so the model isn't told there's a useless screenshot field.
    t.false('screenshot' in JSON.parse(out.result));
});

test('extracts top-level imageUrl / imageUrls', t => {
    const out = extractClientToolImages({
        imageUrl: { url: 'https://example.com/a.png', originalFilename: 'a.png' },
        imageUrls: [
            { url: 'https://example.com/b.png' },
            { url: 'https://example.com/c.png' },
        ],
        unrelated: 1,
    });
    t.is(out.toolImages.length, 3);
    t.is(out.toolImages[0].url, 'https://example.com/a.png');
    t.is(out.toolImages[1].url, 'https://example.com/b.png');
    t.is(out.toolImages[2].url, 'https://example.com/c.png');
    const cleaned = JSON.parse(out.result);
    t.false('imageUrl' in cleaned);
    t.false('imageUrls' in cleaned);
    t.is(cleaned.unrelated, 1);
});

test('does not mutate the caller-supplied data object', t => {
    const data = {
        screenshot: { mimeType: 'image/png', base64: 'A' },
        keep: { nested: 'value' },
    };
    const before = JSON.stringify(data);
    extractClientToolImages(data);
    t.is(JSON.stringify(data), before, 'input data should be unchanged');
});

test('result fits under the agent truncation cutoff for typical screenshot payloads', t => {
    // The original bug: a ~58 KB JSON envelope (mostly base64 PNG) was truncated
    // to 50 KB mid-base64. After extraction the stringified result should be tiny.
    const fakeBase64 = 'A'.repeat(60_000);
    const data = {
        contentType: 'html',
        current: { title: 'page' },
        screenshot: { mimeType: 'image/png', base64: fakeBase64 },
    };
    const out = extractClientToolImages(data);
    t.true(out.result.length < 1000, `result should be small after extraction (got ${out.result.length} chars)`);
    t.is(out.toolImages.length, 1);
    t.true(out.toolImages[0].image_url.url.includes(fakeBase64));
});
