import { callPathway } from '../../../lib/pathwayTools.js';

export default {
    // The main prompt function that takes the input text and asks to generate a summary.
    prompt: [],

    inputParameters: {
        model: "oai-gpt41",
        aiStyle: "OpenAI",
        chatHistory: [{role: '', content: []}],
        altContextId: "",
    },
    timeout: 600,

    executePathway: async ({args, _runAllPrompts, resolver}) => {
        // chatHistory is always passed in complete
        const response = await callPathway('sys_entity_agent', {  
            ...args, 
            chatHistory: args.chatHistory || [],
            stream: false, 
            useMemory: false,
            researchMode: true
        }, resolver);

        return response;
    }
}

