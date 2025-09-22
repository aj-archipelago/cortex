import { Prompt } from '../../../../server/prompt.js';
import { config } from '../../../../config.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `Current conversation turn:\n\n {{{toJSON chatHistory}}}\n\nInstructions: You are part of an AI entity named {{{aiName}}}.\n{{renderTemplate AI_DIRECTIVES}}\nYour role is to analyze the latest conversation turn (your last response and the last user message) to understand if there is anything in the turn worth remembering and adding to your memory or anything you need to forget. In general, most conversation does not require memory, but if the conversation turn contains any of these things, you should use memory:\n1. Important personal details about the user (name, preferences, location, etc.)\n2. Important topics or decisions that provide context for future conversations\n3. Specific instructions or directives given to you to learn\n4. Anything the user has specifically asked you to remember or forget\n\nIf you decide to use memory, you must produce an array of JSON objects that communicates your decision.\nReturn an array of JSON objects (one object per memory) like the following: [{"memoryOperation": "add" or "delete", "memoryContent": "complete description of the memory including as much specificity and detail as possible", "memorySection": "the section of your memory the memory belongs in ("memorySelf" - things about you, "memoryUser" - things about your users or their world, "memoryDirectives" - your directives and learned behaviors)", "priority": 1-5 (1 is the most important)}]. If you decide not to use memory, simply return an array with a single object: [{memoryOperation: "none"}]. You must return only the JSON array with no additional notes or commentary.`},
                {"role": "user", "content": "Generate a JSON object to indicate if memory is required and what memories to process based on the last turn of the conversation."},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        text: '',
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt41',
    useInputChunking: false,
    json: true,
    requestLoggingDisabled: true,
    ...config.get('entityConstants')
}