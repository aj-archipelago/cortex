import test from 'ava';
import serverFactory from '../index.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testServer;

test.before(async () => {
    const { server, startServer } = await serverFactory();
    startServer && await startServer();
    testServer = server;
});

test.after.always('cleanup', async () => {
    if (testServer) {
        await testServer.stop();
    }
});

async function testTranslateSrt(t, text, language='English') {
    const response = await testServer.executeOperation({
        query: 'query translate_subtitle($text: String!, $to:String) { translate_subtitle(text: $text, to:$to) { result } }',
        variables: {
            to: language,
            text
         },
    });

    t.falsy(response.body?.singleResult?.errors);

    const result = response.body?.singleResult?.data?.translate_subtitle?.result;
    t.true(result?.length > text.length*0.5);

    //check all timestamps are still there and not translated
    const originalTimestamps = text.match(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g);
    const translatedTimestamps = result.match(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g);
    
    t.deepEqual(originalTimestamps, translatedTimestamps, 'All timestamps should be present and unchanged');

    const originalLineCount = text.split('\n').length;
    const translatedLineCount = result.split('\n').length;
    
    t.is(originalLineCount, translatedLineCount, 'Total number of lines should be the same');
}

test('test translate_srt endpoint with simple srt', async t => {
    const text = `1
00:00:03,069 --> 00:00:04,771
Who's that?

2
00:00:04,771 --> 00:00:06,039
Aseel.

3
00:00:06,039 --> 00:00:07,474
Who is Aseel a mom to?

4
00:00:07,474 --> 00:00:09,376
Aseel is mommy
`;

    await testTranslateSrt(t, text, 'Spanish');
});

test('test translate_srt endpoint with long srt file', async t => {
    t.timeout(400000);
    const text = fs.readFileSync(path.join(__dirname, 'sublong.srt'), 'utf8');
    await testTranslateSrt(t, text, 'English');
});

test('test translate_srt endpoint with horizontal srt file', async t => {
    t.timeout(400000);
    const text = fs.readFileSync(path.join(__dirname, 'subhorizontal.srt'), 'utf8');
    await testTranslateSrt(t, text, 'Turkish');
});