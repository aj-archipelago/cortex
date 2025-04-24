import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_DIRECTIVES}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n{{renderTemplate AI_EXPERTISE}}\n\n{{renderTemplate AI_CONVERSATION_HISTORY}}\n\nYou were trying to fulfill the user's last request in the above conversation, but ran into an error. You cannot resolve this error.\n{{renderTemplate AI_DATETIME}}`},
                {
                    "role": "user",
                    "content": `The model that you were trying to use to fulfill the user's request returned the following error(s): {{{text}}}. Please let them know what happened. Your response should be concise, fit the rest of the conversation, include detail appropriate for the technical level of the user if you can determine it, and be appropriate for the context. You cannot resolve this error.`
                },
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        text: '',
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
}