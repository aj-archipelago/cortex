import test from 'ava';
import serverFactory from '../index.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';
import { SubtitleUtils } from '@aj-archipelago/subvibe';

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

async function testSubtitleTranslation(t, text, language = 'English', format = 'srt') {
    const response = await testServer.executeOperation({
        query: 'query translate_subtitle($text: String!, $to: String, $format: String) { translate_subtitle(text: $text, to: $to, format: $format) { result } }',
        variables: {
            to: language,
            text,
            format
        },
    });

    t.falsy(response.body?.singleResult?.errors);

    const result = response.body?.singleResult?.data?.translate_subtitle?.result;
    t.true(result?.length > text.length * 0.5);

    // Check format-specific header
    if (format === 'vtt') {
        t.true(result.startsWith('WEBVTT\n\n'), 'VTT output should start with WEBVTT header');
    }

    // Check timestamps based on format
    const timestampPattern = format === 'srt' 
        ? /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g
        : /(?:\d{2}:)?\d{2}:\d{2}\.\d{3} --> (?:\d{2}:)?\d{2}:\d{2}\.\d{3}/g;

    const originalTimestamps = text.match(timestampPattern);
    const translatedTimestamps = result.match(timestampPattern);

    // Compare timestamps using SubtitleUtils.parseLooseTime
    const areTimestampsEquivalent = originalTimestamps?.every((timestamp, index) => {
        const [origStart, origEnd] = timestamp.split(' --> ');
        const [transStart, transEnd] = translatedTimestamps[index].split(' --> ');
        
        const origStartTime = SubtitleUtils.parseLooseTime(origStart);
        const origEndTime = SubtitleUtils.parseLooseTime(origEnd);
        const transStartTime = SubtitleUtils.parseLooseTime(transStart);
        const transEndTime = SubtitleUtils.parseLooseTime(transEnd);
        
        return origStartTime === transStartTime && origEndTime === transEndTime;
    });

    if (!areTimestampsEquivalent) {
        const differences = originalTimestamps?.map((timestamp, index) => {
            const [origStart, origEnd] = timestamp.split(' --> ');
            const [transStart, transEnd] = translatedTimestamps[index].split(' --> ');
            
            const origStartTime = SubtitleUtils.parseLooseTime(origStart);
            const origEndTime = SubtitleUtils.parseLooseTime(origEnd);
            const transStartTime = SubtitleUtils.parseLooseTime(transStart);
            const transEndTime = SubtitleUtils.parseLooseTime(transEnd);
            
            if (origStartTime !== transStartTime || origEndTime !== transEndTime) {
                return {
                    index,
                    original: timestamp,
                    translated: translatedTimestamps[index],
                    parsedOriginal: { start: origStartTime, end: origEndTime },
                    parsedTranslated: { start: transStartTime, end: transEndTime }
                };
            }
            return null;
        }).filter(Boolean);

        console.log('Timestamp differences found:', differences);
    }
    
    t.true(areTimestampsEquivalent, 'All timestamps should be equivalent when parsed');

    // Check line count (accounting for WEBVTT header in VTT)
    const originalLineCount = text.split('\n').length;
    const translatedLineCount = result.split('\n').length;
    
    t.is(originalLineCount, translatedLineCount, 'Total number of lines should be the same');

    // For VTT, verify any custom identifiers are preserved
    if (format === 'vtt') {
        const originalBlocks = text.split(/\n\s*\n/).filter(block => block.trim());
        const translatedBlocks = result.split(/\n\s*\n/).filter(block => block.trim());
        
        // Skip WEBVTT header block
        const startIndex = originalBlocks[0].trim() === 'WEBVTT' ? 1 : 0;
        
        for (let i = startIndex; i < originalBlocks.length; i++) {
            const origLines = originalBlocks[i].split('\n');
            const transLines = translatedBlocks[i].split('\n');
            
            // If first line isn't a timestamp, it's an identifier and should be preserved
            if (!/^\d{2}:\d{2}/.test(origLines[0])) {
                t.is(transLines[0], origLines[0], 'VTT identifiers should be preserved');
            }
        }
    }
}

test('test subtitle translation with SRT format', async t => {
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

    await testSubtitleTranslation(t, text, 'Spanish', 'srt');
});

test('test subtitle translation with VTT format', async t => {
    const text = `WEBVTT

1
00:00:00.000 --> 00:00:07.000
It's here to change the game.

intro
00:00:07.000 --> 00:00:11.360
With the power of AI transforming the future.

question
00:00:11.360 --> 00:00:14.160
The possibilities endless.

00:00:14.160 --> 00:00:17.240
It's not just about the generative AI itself.
`;

    await testSubtitleTranslation(t, text, 'Spanish', 'vtt');
});

test('test subtitle translation with long SRT file', async t => {
    t.timeout(400000);
    const text = fs.readFileSync(path.join(__dirname, 'sublong.srt'), 'utf8');
    await testSubtitleTranslation(t, text, 'English', 'srt');
});

test('test subtitle translation with horizontal SRT file', async t => {
    t.timeout(400000);
    const text = fs.readFileSync(path.join(__dirname, 'subhorizontal.srt'), 'utf8');
    await testSubtitleTranslation(t, text, 'Turkish', 'srt');
});