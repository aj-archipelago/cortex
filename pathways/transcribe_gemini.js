import logger from "../lib/logger.js";
import { publishRequestProgress } from "../lib/redisSubscription.js";
import { alignSubtitles, getMediaChunks } from "../lib/util.js";
import { Prompt } from "../server/prompt.js";

const OFFSET_CHUNK = 500; //seconds of each chunk offset, only used if helper does not provide

function isYoutubeUrl(url) {
    try {
        const urlObj = new URL(url);

        // Check for standard youtube.com domains
        if (
            urlObj.hostname === "youtube.com" ||
            urlObj.hostname === "www.youtube.com"
        ) {
            // For standard watch URLs, verify they have a video ID
            if (urlObj.pathname === "/watch") {
                return !!urlObj.searchParams.get("v");
            }
            // For embed URLs, verify they have a video ID in the path
            if (urlObj.pathname.startsWith("/embed/")) {
                return urlObj.pathname.length > 7; // '/embed/' is 7 chars
            }
            // For shorts URLs, verify they have a video ID in the path
            if (urlObj.pathname.startsWith("/shorts/")) {
                return urlObj.pathname.length > 8; // '/shorts/' is 8 chars
            }
            return false;
        }

        // Check for shortened youtu.be domain
        if (urlObj.hostname === "youtu.be") {
            // Verify there's a video ID in the path
            return urlObj.pathname.length > 1; // '/' is 1 char
        }

        return false;
    } catch (err) {
        return false;
    }
}

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    model: 'gemini-pro-25-vision',
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

        const { file, wordTimestamped, maxLineWidth } = args;

        const responseFormat = args.responseFormat || 'text';

        if(!file) {
            throw new Error("Please provide a file to transcribe.");
        }


        //check if fils is a gcs file or youtube
        const isGcs = file.startsWith('gs://');
        const isYoutube = isYoutubeUrl(file);

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

        let respectLimitsPrompt = "";
        if (maxLineWidth) {

            const possiblePlacement = maxLineWidth <= 25
            ? "vertical" : maxLineWidth <= 35 ? "horizontal" : "";

            respectLimitsPrompt += `  These subtitles will be shown in a ${possiblePlacement} formatted video player.  Each subtitle line should not exceed ${maxLineWidth} characters to fit the player.`;
        }

        function getMessages(file) {
            
            // Base system content that's always included
            let systemContent = `Instructions:
You are a transcription assistant. Your job is to transcribe the audio/video content accurately.

IMPORTANT: Only provide the transcription in your response - no explanations, comments, or additional text.

Format your response in ${responseFormat} format.`;

            // Only include timestamp instructions if we're not using plain text format
            if (responseFormat !== 'text') {
                systemContent += `

CRITICAL TIMESTAMP INSTRUCTIONS:
- Timestamps MUST match the actual timing in the media
- For each new segment, look at the media time directly
- Start times should precisely match when spoken words begin
- Consecutive segments should have matching end/start times (no gaps or overlaps)`;
            }

            systemContent += `

Examples:

SRT format:
1
00:00:00,498 --> 00:00:02,827
Hello World!

2
00:00:02,827 --> 00:00:06,383
Being AI is fun!

VTT format:
WEBVTT

1
00:00:00.000 --> 00:00:02.944
Hello World!

2
00:00:02.944 --> 00:00:08.809
Being AI is great!

Text format:
Hello World! Being AI is great!`;

            if (wordTimestamped) {
                systemContent += `

For word-level transcription, timestamp each word:

WEBVTT

1
00:00:00.000 --> 00:00:01.944
Hello

2
00:00:01.944 --> 00:00:02.383
World!
`;
            }

            // Only include anti-drift procedure and timestamp reminders for non-text formats
            if (responseFormat !== 'text') {
                systemContent += `

ANTI-DRIFT PROCEDURE:
1. For EVERY new segment, check the actual media time directly
2. After every 5 segments, verify your timestamps against the video/audio
3. Never calculate timestamps based on previous segments
4. Always match the end time of one segment with the start time of the next

REMEMBER:
- Transcription accuracy is your primary goal
- Timestamp accuracy is equally important
- Timestamp drift is the most common error - actively prevent it
- When in doubt, check the media time directly`;
            }

            const messages = [
                {"role": "system", "content": systemContent},
                {"role": "user", "content": [
                    `{ type: 'text', text: 'Transcribe this file in ${responseFormat} format.${respectLimitsPrompt} Output only the transcription, no other text or comments or formatting.' }`,
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
        
        if (['srt','vtt'].includes(responseFormat.toLowerCase()) || wordTimestamped) { // align subtitles for formats
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
