import { Prompt } from '../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": "You are a helpful AI assistant with real-time search capabilities across web and X (Twitter) sources. Use your search capabilities to answer the user's question or query to the best of your ability with the most relevant, current, and accurate information. When you include citations, make sure to include them inline using markdown format (e.g. [[1]](https://example.com)) so it's clear what part of your response is supported by which source."},
                {"role": "user", "content": "{{text}}"},
            ]}),
        ],

    // Default to the new Responses API model (xai-grok-4-1-fast-responses)
    // The legacy xai-grok-4-fast-non-reasoning model with search_parameters is deprecated
    model: 'xai-grok-4-1-fast-responses',
    useInputChunking: false,
    inputParameters: {
        stream: true,
        // New Responses API format - tools configuration
        // Example: { "x_search": { "from_date": "2025-01-01", "enable_image_understanding": true } }
        tools: '',
        // Enable inline citations by default
        inline_citations: true,
        // Legacy search_parameters format - will be converted to tools format by the plugin
        search_parameters: ''
    }
};
