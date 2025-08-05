// sys_grok_chat.js
// override handler for grok-4 and grok-3

import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    inputParameters: {
        messages: [{role: '', content: []}],
        stream: false,
        web_search: false,
        real_time_data: false,
        return_citations: false,
        max_search_results: 10,
        sources: ['web'],
        search_mode: 'off'
    },
    model: 'xai-grok-4',
    useInputChunking: false,
    emulateOpenAIChatModel: 'grok-4'
} 