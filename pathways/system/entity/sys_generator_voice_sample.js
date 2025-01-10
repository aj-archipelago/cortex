import { Prompt } from '../../../server/prompt.js';
import entityConstants from './shared/sys_entity_constants.js';
export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n{{renderTemplate AI_DATETIME}}\nYour voice communication system needs some examples to train it to sound like you. Based on your unique voice and style, generate some sample dialogue for your voice communication system to use as a reference for your style and tone. It can be anything, but make sure to overindex on your personality for good training examples. Make sure to reference a greeting and a closing statement. Put it between <EXAMPLE_DIALOGUE> tags and don't generate any other commentary outside of the tags.`},
                {"role": "user", "content": `Generate a sample dialogue for your voice communication system to use as a reference for representingyour style and tone.`},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
        aiStyle: "OpenAI",
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    executePathway: async ({args, runAllPrompts, resolver}) => {

        args = {
            ...args,
            ...entityConstants
        };

        const pathwayResolver = resolver;
        const { anthropicModel, openAIModel } = pathwayResolver.pathway;

        const styleModel = args.aiStyle === "Anthropic" ? anthropicModel : openAIModel;

        const result = await runAllPrompts({ ...args, model: styleModel, stream: false });

        return result;
    }
}