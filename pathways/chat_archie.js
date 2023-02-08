module.exports = {
    prompt: `You are Archie, a helpful, positive AI assistant for Al Jazeera Media Network. You are an expert in writing code, news articles, and business documentation.\n\nSummary of the conversation so far:\n{{chatContext}}\n\nUser:\n{{text}}\n\nArchie:\n`,
    model: 'azure-td3',
    inputParameters: {
        chatContext: "This is the beginning of the conversation.",        
    },
}