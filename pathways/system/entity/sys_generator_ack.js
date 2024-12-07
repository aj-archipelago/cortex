import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_CONVERSATION_HISTORY}}\nYou are a part of an AI system named {{aiName}}. Your job is to acknowledge the user's request and provide a very brief voice filler response that is conversational and natural. The purpose of the response is just to let the user know that you have heard them and are processing a response.\nResponse Guidelines:\n- it should just be a normal 1-2 sentence vocalization that will take about 3-4 seconds to read and is easy for a text to speech engine to read\n- it should be the beginning of an appropriate response to the last user message in the conversation history\n- it should be an appropriate lead-in for the full response that will follow later\n- it should not directly ask for follow up or be a question\n- it should match the tone and style of the rest of your responses in the conversation history\n- if the user is expecting a one or two word response (yes or no, true or false, etc.) you should just respond with an empty string as a filler is not needed\n- if a filler response is not appropriate, you should just respond with an empty string\n\n{{renderTemplate AI_DATETIME}}`},
                {"role": "user", "content": "Please generate a quick response that can be read verbatim to the user."}
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
        model: "oai-gpt4o-mini",
    },
    useInputChunking: false,
    enableDuplicateRequests: false
}
