import { Prompt } from '../server/prompt.js';
import { config } from '../config.js';

const entityConstants = config.get('entityConstants');

export default {
    prompt: [
        new Prompt({
            messages: [
                {
                    role: 'system',
                    content: `${entityConstants.AI_MEMORY}\n\n${entityConstants.AI_COMMON_INSTRUCTIONS}\n${entityConstants.AI_EXPERTISE}\n${entityConstants.AI_MEMORY_INSTRUCTIONS}\n\nInformation: {{{text}}}`,
                },
                {
                    role: 'user',
                    content: "You have already done some research on behalf of the user. The information you've collected is specified in the Information section above. Generate a professional and warm greeting that will appear on the dashboard of the logged in user. Assume this greeting is the first thing they see when they log in to the portal. If you know the user's name, include it in the greeting. The tone should be motivating but not overly casual. 1-2 sentences are ideal. If there's anything particularly interesting or timely in your research, mention it briefly. Do not use any additional tools or attempt to remember more information - just use the information available to you here.",
                },
            ],
        }),
    ],
    useInputChunking: false,
    model: 'oai-gpt41',
    inputParameters: {
        privateData: false,
        chatHistory: [{ role: '', content: [] }],
        contextId: '',
        indexName: '',
        semanticConfiguration: '',
        roleInformation: '',
        calculateEmbeddings: false,
        dataSources: { type: 'array', items: { type: 'string' }, default: [] },
        language: 'English',
        aiName: 'Jarvis',
    },
    timeout: 300,
};
