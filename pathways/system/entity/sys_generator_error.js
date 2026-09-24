import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_DIRECTIVES}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n{{renderTemplate AI_EXPERTISE}}\n\n{{renderTemplate AI_CONVERSATION_HISTORY}}\n\nYou were trying to fulfill the user's last request in the above conversation, but ran into an error. The interrupted model request failed; do not claim that the underlying files are missing or corrupt without evidence.\n{{renderTemplate AI_DATETIME}}`},
                {
                    "role": "user",
                    "content": `The model that you were trying to use to fulfill the user's request returned the following error(s): {{{text}}}. Please let them know what happened. Your response should be concise, fit the rest of the conversation, include detail appropriate for the technical level of the user if you can determine it, and be appropriate for the context. The interrupted model request failed; do not claim that the underlying files are missing or corrupt without evidence.\n\nFor file or image URL download errors, explain that the model could not fetch a preview or attachment URL. This does not establish that the stored file is missing. Preserve the chat and any completed outputs. Suggest continuing with the existing workspace files or requesting the image again through ViewImages. Do not recommend deleting attachments, starting a new chat, or re-uploading unless a separate verified file problem requires it. Do not claim that you inspected or recovered files during this error response.`
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
    model: 'oai-gpt54-mini',
    useInputChunking: false,
}
