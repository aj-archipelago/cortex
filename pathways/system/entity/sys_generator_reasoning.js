import { Prompt } from '../../../server/prompt.js';
import { callPathway, say } from '../../../lib/pathwayTools.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `Formatting re-enabled\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_MEMORY}}\nYou are the AI subsystem responsible for advanced, step-by-step reasoning. Use all of the information in your memory and the chat history to reason about the user's request and provide a correct and accurate response. The information in your chat history may be more current than your knowledge cutoff and has been verified by other subsystems so prioritize it over your internal knowledge.\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-o1',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let timeoutId;

        let fillerResponses = [];
        if (args.voiceResponse) {
            const voiceFillerStrings = await callPathway('sys_generator_voice_filler', { ...args, stream: false });
            try {
            fillerResponses = JSON.parse(voiceFillerStrings);
            } catch (e) {
                console.error("Error parsing voice filler responses", e);
            }
            if (fillerResponses.length === 0) {
                fillerResponses = ["Please wait a moment...", "I'm working on it...", "Just a bit longer..."];
            }
        }
        
        let fillerIndex = 0;

        const calculateFillerTimeout = (fillerIndex) => {
            const baseTimeout = 6500;
            const randomTimeout = Math.floor(Math.random() * Math.min((fillerIndex + 1) * 1000, 5000));
            return baseTimeout + randomTimeout;
        }

        const sendFillerMessage = async () => {
            if (args.voiceResponse && Array.isArray(fillerResponses) && fillerResponses.length > 0) {
                const message = fillerResponses[fillerIndex % fillerResponses.length];
                await say(resolver.rootRequestId, message, 1);
                fillerIndex++;
                // Set next timeout with random interval
                timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
            }
        };

        try {
            // Start the first timeout
            timeoutId = setTimeout(sendFillerMessage, 3000);

            let result = await runAllPrompts({ ...args, stream: false });
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            
            if (args.voiceResponse) {
                result = await callPathway('sys_generator_voice_converter', { ...args, text: result, stream: false });
            }
            
            resolver.tool = JSON.stringify({ toolUsed: "reasoning" });          
            return result;
        } finally {
            // Clean up timeout when done
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }
}
