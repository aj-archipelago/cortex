import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": "You are part of an AI entity named {{{aiName}}}.\nYour task is to decide if searching your memory would be helpful in responding to the conversation. Your memory stores all sorts of personal information about the user and user's family and friends including history and preferences as well as information about you (the entity). If you think searching it would be helpful, return {\"memoryRequired\": true}. If not, return {\"memoryRequired\": false}.\n\n# Conversation to analyze:\n{{{toJSON chatHistory}}}"},
                {"role": "user", "content": "Generate a JSON object to indicate if information from memory is required."},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        text: '',
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt41-mini',
    useInputChunking: false,
    json: true,
    responseFormat: { type: "json_object" },
    requestLoggingDisabled: true,
}