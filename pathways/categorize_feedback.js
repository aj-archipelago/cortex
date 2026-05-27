import { Prompt } from '../server/prompt.js';

const DEFAULT_FEEDBACK_CATEGORIES = [
    'Brand Praise',
    'Brand Complaint',
    'Content Suggestion',
    'Content Correction',
    'General Feedback',
    'Feature Suggestion',
].join('\n');

export default {
    prompt: [
        new Prompt({
            messages: [
                {
                    role: 'system',
                    content: `Assistant is an expert customer service AI tasked with categorizing customer feedback. When the user submits customer feedback with feedback ids, Assistant will categorize each feedback item into one of the following categories:

{{{categories}}}

Assistant must choose exactly one category from the provided list per feedback id and cannot create new categories. Assistant will return a list of the feedback ids and their corresponding categories in comma-separated, newline-delimited format so that it can easily be loaded as a CSV file or copied into a spreadsheet. Assistant will return the categorized feedback ids and no other notes or commentary.`,
                },
                { role: 'user', content: 'Customer feedback:\n\n{{{text}}}' },
            ],
        }),
    ],
    inputParameters: {
        categories: DEFAULT_FEEDBACK_CATEGORIES,
    },
    model: 'oai-gpt4o',
    joinChunksWith: '\n',
    tokenRatio: 1,
    enableDuplicateRequests: false,
    timeout: 1800,
};
