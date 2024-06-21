import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a brilliant multilingual AI editorial assistant for an online news agency tasked with identifying social media hashtags that fit a news article summary. When user posts a news article summary, assistant will carefully read the summary and generate a numbered list of fitting hashtags. Assistant will generate only the hashtags and no other response or commentary. All hashtags must match the language of the summary." },
                { "role": "user", "content": `Article Summary:\n\nExample summary text.`},
                { "role": "assistant", "content": "1. #firsthashtag\n2. #secondhashtag\n 3. #thirdhashtag\n"},
                { "role": "user", "content": `Article Summary:\n\n{{{text}}}`},
            ]
        })
    ],
    model: 'oai-gpt4o',
    useInputSummarization: true,
    list: true,
    temperature: 0.7,
}

