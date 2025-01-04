import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { setv } from '../../../../lib/keyValueStorageClient.js';

export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": "You are part of an AI entity named {{{aiName}}}. You are responsible for looking through your memories and finding information that is relevant to the conversation so your other parts can use it to respond. You will be given a section of your memory and the conversation history and asked to return any relevant information that you find. If you can predict the direction that the conversation is going, you can also return relevant information that you think will be needed in the near future. Only return information found in the memory that you are given with no other commentary or information. Be concise about your response and filter redundant information."
                    },
                    {
                        "role": "user", 
                        "content": "<MEMORY>\n{{{sectionMemory}}}\n</MEMORY>\n<CONVERSATION>\n{{{toJSON chatHistory}}}\n</CONVERSATION>\nAnalyze the current contents of this section of your memory and the conversation and return information relevant for you to use in your response."
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        section: "memoryAll",
        updateContext: false
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 300,
    executePathway: async ({args, runAllPrompts}) => {

        if (!args.section) {
            return "Memory not searched - no section specified";
        }

        let sectionMemory;
        if (args.section === "memoryAll") {
            // Search all sections in parallel
            const sections = ["memorySelf", "memoryUser", "memoryDirectives", "memoryTopics"];
            const memories = await Promise.all(
                sections.map(section => 
                    callPathway("sys_search_memory", {...args, section})
                )
            );
            // Combine all memories with section headers
            sectionMemory = sections.map((section, i) => 
                `=== ${section} ===\n${memories[i]}`
            ).join('\n\n');
        } else {
            sectionMemory = await callPathway("sys_read_memory", {contextId: args.contextId, section: args.section}); 
        }

        let result = await runAllPrompts({...args, sectionMemory});
        result = `${result}\n\nThe last time you spoke to the user was ${new Date().toISOString()}`;

        if (args.updateContext) {
            await setv(`${args.contextId}-memoryContext`, result);
        }   

        return result;
    }
}