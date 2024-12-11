import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_CONVERSATION_HISTORY}}\n\nYou are a part of an AI system named {{aiName}}. Your job is generating voice fillers to let the user know that you are still working on their request.\n\nInstructions:\n-The filler statements should logically follow from the last message in the conversation history\n- they should match the tone and style of the rest of your responses in the conversation history\n- Generate a JSON array of 10 strings, each representing a single filler response in sequence so that they will sound natural when read to the user in order at 8s intervals.\n-Return only the JSON array, no other text or markdown.\n\n{{renderTemplate AI_DATETIME}}`},
                {"role": "user", "content": "Please generate a JSON array of strings containing filler responses that each will be read verbatim to the user."},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
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
