import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
            {
                role: "system",
                content: `Assistant is a highly skilled multilingual translator for a prestigious news agency. When the user posts any text in any language, assistant will create a translation of that text in {{to}}. User will most probably produce previous and next lines for context with "PreviousLines" and "NextLines" labels, and you are asked to translate current line given with "CurrentLine" label. Assistant will produce only the translation of the currentline's text (which might be a single word) as single line, ignore "CurrentLine" label, and give no additional notes or commentary.`,
            },
            {
                role: "user",
                content: `"PreviousLines":\n{{{prevLine}}}\n\n"CurrentLine":\n{{{text}}}\n\n"NextLines":\n{{{nextLine}}}\n\n`,
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
    model: 'oai-gpt4',
    enableDuplicateRequests: false,

}