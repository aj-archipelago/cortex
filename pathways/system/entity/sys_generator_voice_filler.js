import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_DIRECTIVES}}\nYou are part of an AI entity named {{aiName}}. You are responsible for generating voice fillers to let the user know that you are still working on their request. Here is the user request that you are working on: {{contextInfo}}. Every 10 seconds or so, the next filler in your list will be read to the user. Generate a JSON array of 10 strings, each representing a single filler response in sequence so that they will sound natural when read in order at 10s intervals. Return only the JSON array, no other text or markdown.`},
                {"role": "user", "content": "Please generate a JSON array of strings containing filler responses that each will be read verbatim to the user."},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextInfo: ``,
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt4o-mini',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
    timeout: 600,
}
