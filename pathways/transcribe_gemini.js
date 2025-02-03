import logger from "../lib/logger.js";
import { alignSubtitles, getMediaChunks } from "../lib/util.js";
import { Prompt } from "../server/prompt.js";

const OFFSET_CHUNK = 500; //seconds of each chunk offset, only used if helper does not provide

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
        const { file, responseFormat, wordTimestamped, maxLineWidth } = args;
        if(!file) {
            throw new Error("Please provide a file to transcribe.");
        }

        const { requestId } = resolver;
        const chunks = await getMediaChunks(file, requestId);
        logger.info(`Processing  chunks: ${JSON.stringify(chunks)}`);

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
00:05.344 --> 00:00:08.809
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
                        messages: getMessages(chunk.gcs || chunk.uri, responseFormat)
                    })
                }));
        
                const results = await Promise.all(chunkPromises);
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
    }
};
