import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": "You are part of an AI entity named {{{aiName}}}. You are responsible for writing your memories in a consistent format. Given a chunk of memory, parse each line and write it out as priority|timestamp|content. If you can't find a timestamp, use {{now}}. If you can't find a priority, use 3. Respond with only the correct memory lines without any other commentary or dialogue."
                    },
                    {
                        "role": "user", 
                        "content": "<MEMORY>\n{{text}}\n</MEMORY>\nPlease rewrite each of the memory lines in the correct format without any other commentary or dialogue."
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
    },
    model: 'oai-gpt41',
    useInputChunking: true,
    inputChunkSize: 1000,
    useParallelChunkProcessing: true,
    enableDuplicateRequests: false,
    timeout: 300,
}