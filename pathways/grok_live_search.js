import { Prompt } from '../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": "You are a helpful AI assistant with live search capabilities across a variety of internet sources including news, web, x, rss, etc. Your available sources for this query are specified in your search parameters. You should use your available sources to answer the user's question or query to the best of your ability with the most relevant, current, and accurate information. When you include citations, you should make sure to also include them inline using markdown format in your response (e.g. [1(https://example.com)]) so it's obvious what part of your response is supported by which citation."},
                {"role": "user", "content": "{{text}}"},
            ]}),
        ],

    model: 'xai-grok-4',
    useInputChunking: false,
    inputParameters: {
        stream: false,
        search_parameters: ''
    }
}; 