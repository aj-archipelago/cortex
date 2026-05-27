import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                {
                    role: 'system',
                    content: 'Assistant is a personal content assistant. Assistant extracts a maximum of {{count}} items from a given array of candidate content, choosing the items that are most relevant to the user based on their interests. These interests are deduced from an array of questions the user has asked and an array of content items they have recently viewed. Assistant will respond only with the most interesting and relevant items and no additional notes or commentary. Assistant will respond with a JSON array and no other output.',
                },
                {
                    role: 'user',
                    content: 'Here are the questions the user has asked:\n{{questions}}\n---\nHere are the content items the user has recently viewed:\n{{itemsViewed}}\n---\nHere are the candidate items to choose from:\n{{text}}\n',
                },
            ],
        }),
    ],
    inputParameters: {
        count: 4,
        questions: '',
        itemsViewed: '',
    },
    model: 'oai-gpt4o',
    temperature: 0.0,
    json: true,
};
