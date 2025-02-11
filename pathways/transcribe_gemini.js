import logger from "../lib/logger.js";
import { publishRequestProgress } from "../lib/redisSubscription.js";
import { alignSubtitles, getMediaChunks } from "../lib/util.js";
import { Prompt } from "../server/prompt.js";

const OFFSET_CHUNK = 500; //seconds of each chunk offset, only used if helper does not provide

export function convertSrtToVtt(data) {
    if (!data || !data.trim()) {
        return "WEBVTT\n\n";
    }

    // If it's already VTT format and has header
    if (data.trim().startsWith("WEBVTT")) {
        const lines = data.split("\n");
        const result = ["WEBVTT", ""]; // Start with header and blank line
        let currentCue = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Skip empty lines and the WEBVTT header
            if (!line || line === "WEBVTT") {
                continue;
            }

            // If it's a number by itself, it's a cue identifier
            if (/^\d+$/.test(line)) {
                // If we have a previous cue, add it with proper spacing
                if (currentCue.length > 0) {
                    result.push(currentCue.join("\n"));
                    result.push(""); // Add blank line between cues
                    currentCue = [];
                }
                currentCue.push(line);
                continue;
            }

            // Check for and convert timestamps
            const fullTimeRegex = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;
            const shortTimeRegex = /^(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2})[,.](\d{3})$/;
            const ultraShortTimeRegex = /^(\d{1,2})[.](\d{3})\s*-->\s*(\d{1,2})[.](\d{3})$/;

            const fullMatch = line.match(fullTimeRegex);
            const shortMatch = line.match(shortTimeRegex);
            const ultraShortMatch = line.match(ultraShortTimeRegex);

            if (fullMatch) {
                // Already in correct format, just convert comma to dot
                const convertedTime = line.replace(/,/g, '.');
                currentCue.push(convertedTime);
            } else if (shortMatch) {
                // Convert MM:SS to HH:MM:SS
                const convertedTime = `00:${shortMatch[1]}:${shortMatch[2]}.${shortMatch[3]} --> 00:${shortMatch[4]}:${shortMatch[5]}.${shortMatch[6]}`;
                currentCue.push(convertedTime);
            } else if (ultraShortMatch) {
                // Convert SS to HH:MM:SS
                const convertedTime = `00:00:${ultraShortMatch[1].padStart(2, '0')}.${ultraShortMatch[2]} --> 00:00:${ultraShortMatch[3].padStart(2, '0')}.${ultraShortMatch[4]}`;
                currentCue.push(convertedTime);
            } else if (!line.includes('-->')) {
                // Must be subtitle text
                currentCue.push(line);
            }
        }

        // Add the last cue if there is one
        if (currentCue.length > 0) {
            result.push(currentCue.join("\n"));
            result.push(""); // Add final blank line
        }

        // Join with newlines and ensure proper ending
        return result.join("\n") + "\n";
    }

    // remove dos newlines and trim
    var srt = data.replace(/\r+/g, "");
    srt = srt.replace(/^\s+|\s+$/g, "");

    // Split into cues and filter out empty ones
    var cuelist = srt.split("\n\n").filter(cue => cue.trim());

    // Always add WEBVTT header
    var result = "WEBVTT\n\n";

    // Convert each cue to VTT format
    for (const cue of cuelist) {
        const lines = cue.split("\n").map(line => line.trim()).filter(line => line);
        if (lines.length < 2) continue;

        let output = [];
        
        // Handle cue identifier
        if (/^\d+$/.test(lines[0])) {
            output.push(lines[0]);
            lines.shift();
        }

        // Handle timestamp line
        const timeLine = lines[0];
        const fullTimeRegex = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;
        const shortTimeRegex = /^(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2})[,.](\d{3})$/;
        const ultraShortTimeRegex = /^(\d{1,2})[.](\d{3})\s*-->\s*(\d{1,2})[.](\d{3})$/;

        const fullMatch = timeLine.match(fullTimeRegex);
        const shortMatch = timeLine.match(shortTimeRegex);
        const ultraShortMatch = timeLine.match(ultraShortTimeRegex);

        if (fullMatch) {
            output.push(timeLine.replace(/,/g, '.'));
        } else if (shortMatch) {
            output.push(`00:${shortMatch[1]}:${shortMatch[2]}.${shortMatch[3]} --> 00:${shortMatch[4]}:${shortMatch[5]}.${shortMatch[6]}`);
        } else if (ultraShortMatch) {
            output.push(`00:00:${ultraShortMatch[1].padStart(2, '0')}.${ultraShortMatch[2]} --> 00:00:${ultraShortMatch[3].padStart(2, '0')}.${ultraShortMatch[4]}`);
        } else {
            continue; // Invalid timestamp format
        }

        // Add remaining lines as subtitle text
        output.push(...lines.slice(1));
        
        // Add the cue to result
        result += output.join("\n") + "\n\n";
    }

    return result;
}

function convertSrtCue(caption) {
    if (!caption || !caption.trim()) {
        return "";
    }

    var cue = "";
    var s = caption.split(/\n/);

    // concatenate multi-line string separated in array into one
    while (s.length > 3) {
        for (var i = 3; i < s.length; i++) {
            s[2] += "\n" + s[i];
        }
        s.splice(3, s.length - 3);
    }

    var line = 0;

    // detect identifier
    if (
        s[0] &&
        s[1] &&
        !s[0].match(/\d+:\d+:\d+/) &&
        s[1].match(/\d+:\d+:\d+/)
    ) {
        const match = s[0].match(/^\d+$/); // Only match if the entire line is a number
        if (match) {
            cue += match[0] + "\n";
            line += 1;
        }
    }

    // get time strings
    if (s[line] && s[line].match(/\d+:\d+:\d+/)) {
        // convert time string
        var m = s[line].match(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*--?>\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/,
        );
        if (m) {
            cue +=
                m[1] +
                ":" +
                m[2] +
                ":" +
                m[3] +
                "." +
                m[4] +
                " --> " +
                m[5] +
                ":" +
                m[6] +
                ":" +
                m[7] +
                "." +
                m[8] +
                "\n";
            line += 1;
        } else {
            // Try alternate timestamp format
            m = s[line].match(
                /(\d{2}):(\d{2})\.(\d{3})\s*--?>\s*(\d{2}):(\d{2})\.(\d{3})/,
            );
            if (m) {
                // Convert to full timestamp format
                cue +=
                    "00:" +
                    m[1] +
                    ":" +
                    m[2] +
                    "." +
                    m[3] +
                    " --> " +
                    "00:" +
                    m[4] +
                    ":" +
                    m[5] +
                    "." +
                    m[6] +
                    "\n";
                line += 1;
            } else {
                // Unrecognized timestring
                return "";
            }
        }
    } else {
        // file format error or comment lines
        return "";
    }

    // get cue text
    if (s[line]) {
        cue += s[line] + "\n\n";
    }

    return cue;
}

export function detectSubtitleFormat(text) {
    // Remove DOS newlines and trim whitespace
    const cleanText = text.replace(/\r+/g, "").trim();
    const lines = cleanText.split("\n");

    // Check if it's VTT format - be more lenient with the header
    if (lines[0]?.trim() === "WEBVTT") {
        return "vtt";
    }

    // Define regex patterns for timestamp formats
    const srtTimeRegex =
        /(\d{2}:\d{2}:\d{2})[,.]\d{3}\s*-->\s*(\d{2}:\d{2}:\d{2})[,.]\d{3}/;
    const vttTimeRegex =
        /(?:\d{2}:)?(\d{1,2})[.]\d{3}\s*-->\s*(?:\d{2}:)?(\d{1,2})[.]\d{3}/;

    let hasSrtTimestamps = false;
    let hasVttTimestamps = false;
    let hasSequentialNumbers = false;
    let lastNumber = 0;

    // Look through first few lines to detect patterns
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        // Check for timestamps
        if (srtTimeRegex.test(line)) {
            hasSrtTimestamps = true;
        }
        if (vttTimeRegex.test(line)) {
            hasVttTimestamps = true;
        }

        // Check for sequential numbers
        const numberMatch = line.match(/^(\d+)$/);
        if (numberMatch) {
            const num = parseInt(numberMatch[1]);
            if (lastNumber === 0 || num === lastNumber + 1) {
                hasSequentialNumbers = true;
                lastNumber = num;
            }
        }
    }

    // If it has SRT-style timestamps (HH:MM:SS), it's SRT
    if (hasSrtTimestamps && hasSequentialNumbers) {
        return "srt";
    }

    // If it has VTT-style timestamps (MM:SS) or WEBVTT header, it's VTT
    if (hasVttTimestamps) {
        return "vtt";
    }

    return null;
}

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    model: 'gemini-flash-20-vision',
    inputParameters: {
        file: ``,
        language: ``,
        responseFormat: `text`,
        wordTimestamped: false,
        highlightWords: false,
        maxLineWidth: 0,
        maxLineCount: 0,
        maxWordsPerLine: 0,
        contextId: ``,
    },
    timeout: 3600, // in seconds
    enableDuplicateRequests: false,

    executePathway: async ({args, runAllPrompts, resolver}) => {
        let intervalId;
        const { requestId } = resolver;

        try{
        let totalCount = 11; //init max chunk value
        let completedCount = 0;
        let partialCount = 0;
        let partialRatio = 0;

        const sendProgress = (partial=false, resetCount=false) => {
            partialCount = resetCount ? 0 : partialCount;

            if(partial){
                partialCount++;
                const increment = 0.02 / Math.log2(partialCount + 1); // logarithmic diminishing increment
                partialRatio = Math.min(partialRatio + increment, 0.99); // limit to 0.99
            }else{
                partialCount = 0;
                partialRatio = 0;
                completedCount++;
            }
            if(completedCount >= totalCount) return;

            const progress = (completedCount + partialRatio) / totalCount;
            logger.info(`Progress for ${requestId}: ${progress}`);

            publishRequestProgress({
                requestId,
                progress,
                data: null,
            });
        }
        sendProgress(true);
        intervalId = setInterval(() => sendProgress(true), 3000);

        const { file, responseFormat, wordTimestamped, maxLineWidth } = args;
        if(!file) {
            throw new Error("Please provide a file to transcribe.");
        }


        //check if fils is a gcs file or youtube
        const isGcs = file.startsWith('gs://');
        const isYoutube = file.match(/^(http(s)?:\/\/)?((w){3}.)?youtu(be|.be)?(\.com)?\/.+/);

        let chunks = [{
            url: file,
            gcs: file,
            offset: 0,
        }];
        if(!isGcs && !isYoutube) {
            //get chunks from helper api if not gcs or youtube
            chunks = await getMediaChunks(file, requestId);
        }
        totalCount = chunks.length+1;
        logger.info(`Processing chunks: ${JSON.stringify(chunks)}`);

        sendProgress(true);

        let respectLimitsPrompt = " ";
        if (maxLineWidth) {

            const possiblePlacement = maxLineWidth <= 25
            ? "vertical" : maxLineWidth <= 35 ? "horizontal" : "";

            respectLimitsPrompt += `The output lines must not exceed ${maxLineWidth} characters, so make sure your transcription lines and timestamps are perfectly aligned. `;

            if(possiblePlacement){
                respectLimitsPrompt+= `This limit a must as user will be using the output for ${possiblePlacement} display.`
            }
        }

        const transcriptionLevel = wordTimestamped ? "word" : "phrase";

        function getMessages(file, format) {

            const responseFormat = format!== 'text' ? 'SRT' : 'text';

            const messages = [
                {"role": "system", "content": `Instructions:\nYou are an AI entity with expertise of transcription. Your response only contains the transcription, no comments or additonal stuff. 
                
Your output must be in the format asked, and must be strictly following the formats and parseble by auto parsers. 

Word-level transcriptions must be per word timestamped, and phrase-level transcriptions are per phrase.

Each transcription timestamp must precisely match the corresponding audio/video segment.
Each timestamp must correspond to actual spoken content.
End time cannot exceed total media duration. Especially when transcribing word-level double check your timestamps, never exceed the total duration. 

You must follow 1, 2, 3, ... numbering for each transcription segment without any missing numbers.
Never put newlines or spaces in the middle of a timestamp.
Never put multiple lines for a single timestamp.

Example responses:

- If asked SRT format, e.g.:
1
00:00:00,498 --> 00:00:02,827
Hello World!

2
00:00:02,827 --> 00:00:06,383
Being AI is fun!

- If asked VTT format, e.g.:
WEBVTT

1
00:00:00.000 --> 00:00:02.944
Hello World2!

2
00:00:05.344 --> 00:00:08.809
Being AI is also great!

- If asked text format, e.g.:
Hello World!!! Being AI is being great yet again!

Word-level output e.g.:

WEBVTT

1
00:00:00.000 --> 00:00:01.944
Hello

2
00:00:01.964 --> 00:00:02.383
World!


You must follow spacing, punctuation, and timestamps as shown in the examples otherwise your response will not be accepted.
Never output multiple lines for a single timestamp.
Even a single newline or space can cause the response to be rejected. You must follow the format strictly. You must place newlines and timestamps exactly as shown in the examples.

    `},
                {"role": "user", "content": [
                    `{ type: 'text', text: 'Transcribe the media ${transcriptionLevel}-level in ${responseFormat} format.${respectLimitsPrompt}' }`,
                    JSON.stringify({
                        type: 'image_url',
                        url: file,
                        gcs: file
                    })
                ]},
            ]

            return messages;
        }


        const processChunksParallel = async (chunks, args) => {
            try {
                const chunkPromises = chunks.map(async (chunk, index) => ({
                    index,
                    result: await runAllPrompts({ 
                        ...args, 
                        messages: getMessages(chunk.gcs || chunk.uri, responseFormat),
                        requestId: `${requestId}-${index}`
                    })
                }));
        
                const results = await Promise.all(
                chunkPromises.map(promise => 
                    promise.then(result => {
                        sendProgress();
                        return result;
                    })
                ));

                return results
                    .sort((a, b) => a.index - b.index)
                    .map(item => item.result);
            } catch (error) {
                logger.error('Error processing chunks:', error);
                throw error;
            }
        };
       
        // serial processing of chunks
        // const result = [];
        // for(const chunk of chunks) {
        //     const chunkResult = await runAllPrompts({ ...args, messages: getMessages(chunk.gcs || chunk.uri) });
        //     result.push(chunkResult);
        // }
        
        const result = await processChunksParallel(chunks, args);
        
        if (['srt','vtt'].includes(responseFormat) || wordTimestamped) { // align subtitles for formats
            const offsets = chunks.map((chunk, index) => chunk?.offset || index * OFFSET_CHUNK);
            return alignSubtitles(result, responseFormat, offsets);
        }
        return result.join(` `);
    }catch(error){
        logger.error(`Error in transcribing: ${error}`);
        throw error;
    }finally{
        intervalId && clearInterval(intervalId);
    }
    }
};
