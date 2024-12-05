import { Prompt } from '../../../server/prompt.js';
import { callPathway, say } from '../../../lib/pathwayTools.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_DIRECTIVES}}\nUse all of the information in your memory and the chat history to reason about the user's request and provide a response. Often this information will be more current than your knowledge cutoff.`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-o1-mini',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let timeoutId;

        // figure out what the user wants us to do
        const contextInfo = args.chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");

        let fillerResponses = [];
        if (args.voiceResponse) {
            const voiceFillerStrings = await callPathway('sys_generator_voice_filler', { ...args, contextInfo, stream: false });
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
            const baseTimeout = 7500;
            const randomTimeout = Math.floor(Math.random() * ((fillerIndex + 1) * 1000));
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
            timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));

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
