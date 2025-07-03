import { Prompt } from '../../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a response quality evaluator. When given a chat history and a response to evaluate, assistant will carefully analyze whether the response is reasonable given the context of the conversation. Primarily the assistant is trying to detect errors and hallucinations in the underlying models. As long as the response looks basically correct and relevant, even if it's not ideal or complete or contradicts some rules, it should be isReasonable: true.\n\nAssistant will return a JSON object with the following structure:\n{\n  \"isReasonable\": boolean,\n  \"score\": number (0-10),\n  \"reasoning\": string\n}\n\nWhere:\n- isReasonable: Overall judgment of whether the response is reasonable\n- score: Numerical score from 0-10 (10 being excellent)\n- reasoning: Brief explanation of the judgment" },
                "{{chatHistory}}",
                { "role": "user", "content": `The response to the above conversation from the model was: '{{{modelResponse}}}'. Is that response acceptable?`},
            ]
        })
    ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        modelResponse: '',
    },
    model: 'oai-gpt4o-mini',
    enableDuplicateRequests: false,
    json: true
} 