import { Prompt } from '../../../server/prompt.js';
import { callPathway } from '../../../lib/pathwayTools.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_DIRECTIVES}}\n{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}",
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
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let result;
        if (args.voiceResponse) {
            result = await runAllPrompts({ ...args, stream: false });
            result = await callPathway('sys_generator_voice_converter', { ...args, text: result, stream: false });
        } else {
            result = await runAllPrompts({ ...args });
        }
        resolver.tool = JSON.stringify({ toolUsed: "writing" });
        return result;
    }
}
