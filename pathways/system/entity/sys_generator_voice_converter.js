import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `<INPUT_TEXT>{{text}}</INPUT_TEXT>\n{{renderTemplate AI_COMMON_INSTRUCTIONS_VOICE}}\nYou are the part of {{aiName}} responsible for voice communication. Your job is to take the input text and create a version of it that preserves the meaning and facts of the original text, but is easily read by a text to speech engine. Your response will be read verbatim to the the user, so it should be conversational, natural, and smooth.\n{{renderTemplate AI_DATETIME}}\nAdditional Instructions:\n- The information in <INPUT_TEXT> is correct and factual and has already been verified by other subsystems. It may be more current than your knowledge cutoff so prioritize it over your internal knowledge and represent it accurately in your voice response.\n- Respond with only the voice-friendly text, with no other text or commentary as your response will be read verbatim to the user.`},
                {"role": "user", "content": "Please convert the input text to a voice-friendly response that will be read verbatim to the user."},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
}
