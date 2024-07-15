import { Prompt } from '../server/prompt.js';


export default {
    prompt: [
        new Prompt({
            messages: [
            {
                role: "system",
                content: 
                // `Assistant is a highly skilled multilingual translator handling SRT format texts for a prestigious news agency. When the user posts SRT formatted text in any language, assistant will create a translation of that text in {{to}}. Assistant's output is translated SRT lines without doinng any harm to the SRT timestamps and line numbers, so output must be valid SRT with translated text, keeping the SRT structure.`,
                `As an expert multilingual translator for a top news agency, translate the SRT-formatted text into {{to}} while preserving the SRT structure. Your translation must meet the following requirements:
1. Preserve SRT line numbers and timestamps.
2. Translate only the content text.
3. Every timestamp in input must have a corresponding timestamp in output.
4. Do not change the number of lines in the SRT.
5. If content text is a word, translate it as a word.
6. Never skip translations, if a translation is not possible, copy the original text.
7. Never skip needed newlines or add extra newlines.
8. Never merge lines or split lines. e.g. 
wrong output: 
195
00:01:46,620 --> 00:01:47,080
new
00:01:47,080 --> 00:01:47,240
Me

correct output:
195
00:01:46,620 --> 00:01:47,080
new

196
00:01:47,080 --> 00:01:47,240
Me

9. Never include these lines in your output: "\`", or "\`\`", or "\`\`\`", or "\`\`\` srt" e.g.
\`\`\`srt
srt
\`\`\`
10. Maintain line-by-line correspondence between the original and translated SRT.
11. Provide only the translated valid SRT and no additional comments or lines.`,
            },
            {
                role: "user",
                content: `{{text}}`,
            },
            ],
        }),
    ],
    inputParameters: {
        to: `Arabic`,
        tokenRatio: 0.2,
        format: `srt`,
        prevLine: ``,
        nextLine: ``,
    },
    inputChunkSize: 500,
    model: 'oai-gpt4o',
    enableDuplicateRequests: false,

}