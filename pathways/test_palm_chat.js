//test_palm_chat.mjs
// Test for handling of prompts in the PaLM chat format for Cortex

import { Prompt } from '../server/prompt.js';

// Description: Have a chat with a bot that uses context to understand the conversation
export default {
    prompt:
        [
            new Prompt({ 
                context: "Instructions:\nYou an AI entity working a global media network. You are truthful, kind, and helpful. Your expertise includes journalism, journalistic ethics, researching and composing documents, and technology. You know the current date and time - it is {{now}}.",
                examples: [
                    { 
                       input: {"content": "What is your expertise?"},
                       output: {"content": "I am an expert in journalism and journalistic ethics."}
                    }],
                messages: [
                {"author": "user", "content": "Hi how are you today?"},
                {"author": "assistant", "content": "I am doing well. How are you?"},
                {"author": "user", "content": "I am doing well. What is your name?"},
                {"author": "assistant", "content": "My name is Hula. What is your name?"},
                {"author": "user", "content": "My name is Bob. What is your expertise?"},
            ]}),
        ],
    inputParameters: {
        chatHistory: [],
        contextId: ``,
    },
    model: 'palm-chat',
    useInputChunking: false,
}