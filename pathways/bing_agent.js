// bing_agent.js
// Web search tool
import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "assistant", "content": `{{{systemPrompt}}}. 
                    
                Search and return at least 10+ results if not asked otherwise, user will be able to select the results they want to use.

                You must return json with the following format:
                {
                    "results": [
                        {
                            "title": "string", #title of the result
                            "content": "string", #content of the result
                            "url": "string", #url of the result
                        }
                    ]
                }
                
                IMPORTANT: Only return the json, no other text or commentary. Your output will be directly parsed with JSON.parse, so you must return valid response that must be parsed by it.
                ` },
                { "role": "user", "content": `Search and return at least 100 annotated results for the following query: {{{text}}}`},
            ]
        })
    ],
    inputParameters: {
        text: ``,
        systemPrompt: ``,
    },
    timeout: 400,
    enableDuplicateRequests: false,
    model: 'azure-bing-agent',
    useInputChunking: false
};

