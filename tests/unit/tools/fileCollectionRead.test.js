import test from 'ava';
import {
    extractRelevantPassages,
    readBytePage,
} from '../../../pathways/system/entity/tools/sys_tool_file_collection.js';

test('READ pagination returns continuation metadata for evidence beyond the first page', async (t) => {
    const response = new Response('second-page-evidence', {
        status: 206,
        headers: {
            'Content-Range': 'bytes 12000-12019/24000',
            'Content-Type': 'text/plain',
        },
    });

    const page = await readBytePage(response, 12000, 20);

    t.is(page.text, 'second-page-evidence');
    t.is(page.bytesRead, 20);
    t.true(page.hasMore);
    t.is(page.totalBytes, 24000);
});

test('READ pagination preserves multibyte UTF-8 characters across page boundaries', async (t) => {
    const bytes = new TextEncoder().encode('A🙂B');
    const first = await readBytePage(new Response(bytes.slice(0, 3), {
        status: 206,
        headers: { 'Content-Range': `bytes 0-2/${bytes.length}` },
    }), 0, 3);
    const second = await readBytePage(new Response(bytes.slice(first.bytesRead), {
        status: 206,
        headers: {
            'Content-Range': `bytes ${first.bytesRead}-${bytes.length - 1}/${bytes.length}`,
        },
    }), first.bytesRead, bytes.length - first.bytesRead);

    t.is(first.text, 'A');
    t.is(first.bytesRead, 1);
    t.is(`${first.text}${second.text}`, 'A🙂B');
    t.false(second.hasMore);
});

test('READ query extracts relevant passages from a large HTML document', (t) => {
    const html = `<html><body>
        <p>Publishing guidance is unrelated.</p>
        <section><h2>Account access</h2><p>Open a 7777 request for account settings.</p></section>
        <script>window.otherTopic = "unrelated";</script>
    </body></html>`;

    const passages = extractRelevantPassages(html, 'Where are account settings?', true);

    t.true(passages.includes('7777 request'));
});

test('READ query falls back to file content when the question has no searchable terms', (t) => {
    t.is(extractRelevantPassages('Short attached fact.', 'What is it?', false), 'Short attached fact.');
});
