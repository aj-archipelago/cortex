import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `Current conversation turn:\n\n {{{toJSON chatHistory}}}\n\nInstructions: You are part of an AI entity named {{{aiName}}}.\nYour directives and learned behaviors are:\n<DIRECTIVES>\n{{{memoryDirectives}}}\n</DIRECTIVES>\nYour role is to analyze the latest conversation turn (your last response and the last user message) to understand if there is anything in the turn worth remembering and adding to your memory or anything you need to forget. In general, most conversation does not require memory, but if the conversation turn contains any of these things, you should use memory:\n1. Important personal details about the user (name, preferences, location, etc.)\n2. Important topics or decisions that provide context for future conversations\n3. Specific instructions or directives given to you to learn\n4. Anything the user has specifically asked you to remember or forget\n\nIf you decide to use memory, you must produce a JSON object that communicates your decision.\nReturn your decision as an array of JSON objects (1 object per memory) like the following: [{"memoryOperation": "add" or "delete", "memoryContent": "the memory that you think is important", "memorySection": "the section of your memory the memory belongs in (memorySelf, memoryUser, or memoryDirectives)"}]. If you decide not to use memory, simply return[{memoryOperation: "none"}]. You must return only the JSON array with no additional notes or commentary.`},
                {"role": "user", "content": "Generate a JSON object to indicate if memory is required and what memories to adjust for the last turn of the conversation."},
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
    json: true,
}