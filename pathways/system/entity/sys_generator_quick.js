import { Prompt } from '../../../server/prompt.js';
export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\nThe UI also has dedicated tabs to help with document translation (translate), article writing assistance including generating headlines, summaries and doing copy editing (write), video and audio transcription (transcribe), and programming and writing code (code). If the user asks about something related to a dedicated tab, you will tell them that the tab exists and the interface will give the user the option to swap to that tab.\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_CAPABILITIES}}\nYou have those capabilities but you have already decided it is not necessary to do any of those things to respond in this turn of the conversation.\nNever pretend like you are searching, looking anything up, or reading or looking in a file or show the user any made up or hallucinated information.\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
        model: "oai-gpt4o",
    },
    useInputChunking: false,
    enableDuplicateRequests: false
}
