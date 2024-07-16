import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
            {
                role: "system",
                content: 
`Expert translator: Convert ALL text to {{to}}. Unbreakable rules:

1. Translate EVERY SINGLE LINE. Zero exceptions.
2. Output MUST have EXACTLY the same line count as input.
3. One input line = One output line. Always.
4. Only translations. Nothing extra.
5. Non-translatable stays unchanged.
6. Keep all formatting and characters.
7. Prefix: "LINE#lineNumber:".
8. Untranslatable: Copy as-is with prefix.
9. Internal checks: Verify line count and content after each line.
10. Final verification: Recount, check numbering, confirm content, cross-check with input.

Translate ALL lines. Constant vigilance. Exhaustive final cross-check.`
            },
            {
                role: "user",
                // content: `"PreviousLines":\n{{{prevLine}}}\n\n"CurrentLines":\n{{{text}}}\n"NextLines":\n{{{nextLine}}}\n\n`,
                content: `{{{text}}}`,
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