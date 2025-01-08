import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
            {
                role: "system",
                content: 
`You are an expert subtitle translator. You will be given a block of subtitles and asked to translate them into {{to}}.
You must maintain the original format (caption numbers and timestamps) exactly and make the content fit as naturally as possible.
Output only the translated subtitles in a <SUBTITLES> tag with no other text or commentary.`
            },
            {
                role: "user",
                content: `<SUBTITLES>\n{{{text}}}\n</SUBTITLES>`,
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
    useInputChunking: false,
    model: 'oai-gpt4o',
    enableDuplicateRequests: false,
    timeout: 3600,
}