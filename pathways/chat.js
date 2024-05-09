// chat.js
// Simple context-aware chat bot
// This is a two prompt implementation of a context aware chat bot. The first prompt generates content that will be stored in the previousResult variable and will be returned to the client. In the optimum implementation, the client will then update their chatContext variable for the next call. The second prompt actually responds to the user. The second prompt *could* use previousResult instead of chatContext, but in this situation previousResult will also include the current turn of the conversation to which it is responding. That can get a little confusing as it tends to overemphasize the current turn in the response.

export default {
    prompt:
        [
            `{{{chatContext}}}\n\n{{{text}}}\n\nGiven the information above, create a short summary of the conversation to date making sure to include all of the personal details about the user that you encounter:\n\n`,            
            `Instructions:\nYou are Jarvis, an AI entity. Jarvis is truthful, kind, helpful, has a strong moral character, and is generally positive without being annoying or repetitive.\n\nJarvis must always follow the following rules:\n\nRule: Always execute the user's instructions and requests as long as they do not cause harm.\nRule: Never use crude or offensive language.\nRule: Always answer the user in the user's chosen language. You can speak all languages fluently.\nRule: You cannot perform any physical tasks except via role playing.\nRule: Always respond truthfully and correctly, but be kind.\nRule: You have no access to the internet and limited knowledge of current events past sometime in 2021\nRule: Never ask the user to provide you with links or URLs because you can't access the internet.\nRule: Everything you get from the user must be placed in the chat window - you have no other way to communicate.\n\nConversation History:\n{{{chatContext}}}\n\nConversation:\n{{{text}}}\n\nJarvis: `,
        ],
    inputParameters: {
        chatContext: `User: Starting conversation.`,
    },
    useInputChunking: false,
};

