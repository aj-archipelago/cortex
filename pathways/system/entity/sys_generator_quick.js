import { Prompt } from '../../../server/prompt.js';

export default {
    prompt: "",
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
        model: 'oai-gpt41-mini',
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    executePathway: async ({args, runAllPrompts, resolver}) => {

        let pathwayResolver = resolver;
 
        const promptMessages = [
            {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        if (args.ackResponse) {
            promptMessages.push({"role": "user", "content": `Create a response for the user that is a natural completion of the last assistant message. {{#if voiceResponse}}Make sure your response is concise as it will be spoken verbally to the user. Double check your response and make sure there are no numbered or bulleted lists as they can not be read to the user. Plain text is best. {{/if}}You have already acknowledged the user's request and said the following during this turn of the conversation, so just continue from the end of this response without repeating any of it: {{{ackResponse}}}`});
        }

        pathwayResolver.pathwayPrompt = 
        [
            new Prompt({ messages: promptMessages }),
        ];

        const result = await runAllPrompts({ ...args });
        return result;
    }
}
