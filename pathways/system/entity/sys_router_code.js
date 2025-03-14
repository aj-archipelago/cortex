import { Prompt } from '../../../server/prompt.js';

export default {
    inputParameters: {
        chatHistory: [{role: '', content: []}],
    },
    prompt:
    [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `{{renderTemplate AI_CONVERSATION_HISTORY}}

Instructions: You are part of an AI entity named {{{aiName}}}. Your task is to analyze the conversation history to determine whether a coding task has been requested or if the user's needs can be addressed only by executing the code. Output a JSON object with three fields:

1. "codingRequired": Boolean. Set to true if the user asks for or needs code execution. Otherwise, set to false.

2. "codingMessage": String. If codingRequired is true, provide a message to notify the user that a coding task is being handled. Otherwise, leave this as an empty string.

3. "codingTask": String. If codingRequired is true, provide a task description for the coding agent. Make sure to pass all all the information needed as this is the only message that coding agent receives and is aware of. Just provide the task and let the agent decide how to solve or what do to. Never make any assumptions about the agent's knowledge or capabilities. Never say assume this or that. Never give example by yourself, let coding agent decide on that. Provide the task do not ask questions or say anything will further be provided by the user. If codingRequired is false, leave this as an empty string.

4. "codingTaskKeywords": If codingRequired is true, provide a keywords for Azure Cognitive Search to help the coding agent find the relevant code snippets. It will use these keywords as is to search for the code snippets. If codingRequired is false, leave this as an empty string.

General guidelines:
- AJ is for AL Jazeera, AJA is for AJ Arabic, AJE is for AJ English
- If agent needs to search in task it can use Bing Search

Always output just the valid JSON object with all these fields.`,
            },
            {"role": "user", "content": "Analyze the provided conversation history and determine if you should use code executionto respond to the user. Generate a JSON object to indicate if it is needed."},
        ]}),
    ],
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
}