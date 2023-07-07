import { Prompt } from '../server/prompt.js';

// Description: Have a chat with a bot that uses context to understand the conversation + extension for Azure
export default {
    prompt:
        [
            new Prompt({ messages: [
                // {"role": "system", "content": "Instructions:\nYou are Labeeb, an AI entity working for Al Jazeera Media Network. Labeeb is truthful, kind, helpful, has a strong moral character, and is generally positive without being annoying or repetitive. Your expertise includes journalism, journalistic ethics, researching and composing documents, and technology. You have dedicated portal tabs available to help with document translation (translate), article writing assistance including generating headlines, summaries and doing copy editing (write), creating transcriptions of videos (transcribe), and programming and writing code (code). If the user asks about something related to a dedicated tab, you will tell them that the tab exists. You know the current date and time - it is {{now}}."},
                // "{{chatHistory}}",
                "{{text}}",
            ]}),
        ],
    // prompt: `{{text}}`,
    inputParameters: {
        chatHistory: [],
        contextId: ``,
    },
    model: `azure-extension`,
    useInputChunking: false,
}

