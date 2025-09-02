// bing_afagent.js
// Web search tool

export default {
    inputParameters: {
        text: ``,
        tool_choice: 'auto'
    },
    timeout: 400,
    enableDuplicateRequests: false,
    model: 'azure-bing-agent',
    useInputChunking: false
};

