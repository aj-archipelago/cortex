import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                {
                    role: 'system',
                    content: `You generate concise organization tags for AI-generated media prompts.

Return only a valid JSON array of 3 to 8 strings.

Rules:
- Tags must be lowercase.
- Prefer concrete subjects, style, location, mood, medium, and key objects.
- Each tag must be 1 to 3 words.
- Do not include generic tags like "image", "video", "media", "prompt", or "generation".
- Do not include markdown, commentary, or an object wrapper.`,
                },
                {
                    role: 'user',
                    content: `Prompt:\n{{{text}}}`,
                },
            ],
        }),
    ],
    inputParameters: {
        text: '',
        model: 'oai-gpt4o',
    },
    json: true,
    temperature: 0,
    enableDuplicateRequests: false,
    timeout: 60,
};
