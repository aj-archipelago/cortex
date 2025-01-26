import { Prompt } from '../../../../server/prompt.js';
import { config } from '../../../../config.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `Current conversation turn:\n\n {{{toJSON chatHistory}}}\n\nInstructions: You are part of an AI entity named {{{aiName}}}.\n{{renderTemplate AI_DIRECTIVES}}\nYour role is to analyze the latest conversation turn (your last response and the last user message) and generate a topic for the conversation. The topic should be a single sentence that captures the main idea and details of the conversation.`},
                {"role": "user", "content": "Generate a topic for the conversation. Return only the topic with no additional notes or commentary."},
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
    ...config.get('entityConstants')
}