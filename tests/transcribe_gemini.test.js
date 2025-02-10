import test from 'ava';
import { convertSrtToVtt } from '../pathways/transcribe_gemini.js';

test('should return empty WebVTT for null or empty input', t => {
    t.is(convertSrtToVtt(null), "WEBVTT\n\n");
    t.is(convertSrtToVtt(''), "WEBVTT\n\n");
    t.is(convertSrtToVtt('   '), "WEBVTT\n\n");
});

test('should convert basic SRT to WebVTT format', t => {
    const srtInput = 
`1
00:00:01,000 --> 00:00:04,000
Hello world`;

    const expectedOutput = 
`WEBVTT

1
00:00:01.000 --> 00:00:04.000
Hello world

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should convert multiple subtitle entries', t => {
    const srtInput = 
`1
00:00:01,000 --> 00:00:04,000
First subtitle

2
00:00:05,000 --> 00:00:08,000
Second subtitle`;

    const expectedOutput = 
`WEBVTT

1
00:00:01.000 --> 00:00:04.000
First subtitle

2
00:00:05.000 --> 00:00:08.000
Second subtitle

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle DOS line endings', t => {
    const srtInput = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello world\r\n";
    const expectedOutput = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello world\n\n";
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle multi-line subtitles', t => {
    const srtInput = 
`1
00:00:01,000 --> 00:00:04,000
First line
Second line
Third line

2
00:00:05,000 --> 00:00:08,000
Another subtitle`;

    const expectedOutput = 
`WEBVTT

1
00:00:01.000 --> 00:00:04.000
First line
Second line
Third line

2
00:00:05.000 --> 00:00:08.000
Another subtitle

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle invalid timestamp formats', t => {
    const srtInput = 
`1
invalid timestamp
Hello world

2
00:00:05,000 --> 00:00:08,000
Valid subtitle`;

    const expectedOutput = 
`WEBVTT

2
00:00:05.000 --> 00:00:08.000
Valid subtitle

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should convert comma to dot in timestamps', t => {
    const srtInput = 
`1
00:00:01,500 --> 00:00:04,750
Test subtitle`;

    const expectedOutput = 
`WEBVTT

1
00:00:01.500 --> 00:00:04.750
Test subtitle

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle extra whitespace in input', t => {
    const srtInput = `

1   
  00:00:01,000 --> 00:00:04,000  
  Hello world  

`;
    const expectedOutput = 
`WEBVTT

1
00:00:01.000 --> 00:00:04.000
Hello world

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle timestamps with only minutes and seconds', t => {
    const srtInput = 
`1
01:30,000 --> 02:45,500
Short timestamp format`;

    const expectedOutput = 
`WEBVTT

1
00:01:30.000 --> 00:02:45.500
Short timestamp format

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle ultra-short timestamps (SS.mmm)', t => {
    const srtInput = 
`1
03.298 --> 04.578
First line

2
04.578 --> 06.178
Second line`;

    const expectedOutput = 
`WEBVTT

1
00:00:03.298 --> 00:00:04.578
First line

2
00:00:04.578 --> 00:00:06.178
Second line

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
});

test('should handle mixed timestamp formats', t => {
    const srtInput = 
`1
03.298 --> 04.578
First line

2
00:04.578 --> 00:06.178
Second line

3
00:00:06.178 --> 00:00:07.518
Third line`;

    const expectedOutput = 
`WEBVTT

1
00:00:03.298 --> 00:00:04.578
First line

2
00:00:04.578 --> 00:00:06.178
Second line

3
00:00:06.178 --> 00:00:07.518
Third line

`;
    t.is(convertSrtToVtt(srtInput), expectedOutput);
}); 