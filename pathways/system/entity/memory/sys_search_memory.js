import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { setvWithDoubleEncryption } from '../../../../lib/keyValueStorageClient.js';

export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": "You are part of an AI entity named {{{aiName}}}. You are responsible for looking through your memories and finding information that is relevant to the conversation so your other parts can use it to respond.\n\nInstructions:\n- You will be given a section of your memory and the conversation history and asked to return any relevant information that you find. If you can predict the direction that the conversation is going, you can also return relevant information that you think will be needed in the near future.\n- IMPORTANT:Only return information found in the memory that you are given. Do not make up information. If it's not in the memory section, it doesn't exist.\n- Return the information in a concise format with no other commentary or dialogue.\n- If you don't find any relevant information in the memory section, return 'No relevant information found.'."
                    },
                    {
                        "role": "user", 
                        "content": "<MEMORY>\n{{{sectionMemory}}}\n</MEMORY>\n<CONVERSATION>\n{{{toJSON chatHistory}}}\n</CONVERSATION>\nAnalyze the current contents of this section of your memory and the conversation and return any information relevant for you to use in your response. Accuracy is critical. You must never make up or hallucinate information - if you don't see it in the memory, you must return 'No relevant information found.'"
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        section: "memoryAll",
        updateContext: false,
        contextKey: ``
    },
    model: 'oai-gpt41-mini',
    useInputChunking: false,
    enableDuplicateRequests: false,
    requestLoggingDisabled: true,
    timeout: 300,
    executePathway: async ({args, runAllPrompts}) => {

        if (!args.section) {
            return "Memory not searched - no section specified";
        }

        let sectionMemory;
        let result = "";
        if (args.section === "memoryAll") {
            // Search all sections in parallel
            const sections = ["memorySelf", "memoryUser", "memoryDirectives", "memoryTopics"];
            const memories = await Promise.all(
                sections.map(section => 
                    callPathway("sys_search_memory", {...args, section})
                )
            );
            // Combine all memories with section headers
            result = sections.map((section, i) => 
                `=== ${section} ===\n${memories[i]}`
            ).join('\n\n');
            result = `${result}\n\nThe last time you spoke to the user was ${new Date().toISOString()}.`;

        } else {
            sectionMemory = await callPathway("sys_read_memory", {contextId: args.contextId, section: args.section, stripMetadata: (args.section !== 'memoryTopics'), contextKey: args.contextKey}); 
            result = await runAllPrompts({...args, sectionMemory});
        }

        if (args.updateContext) {
            await setvWithDoubleEncryption(`${args.contextId}-memoryContext`, result, args.contextKey);
        }   

        return result;
    }
}