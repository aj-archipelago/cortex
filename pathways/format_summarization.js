// Import required modules
import { Prompt } from '../server/prompt.js';

export default {
    temperature: 0,
    // The main prompt function that takes the input text and asks to generate a summary.
    prompt:[
        new Prompt({ messages: [
        {"role": "system", "content": "Assistant is a highly skilled multilingual AI writing agent that summarizes text. When the user posts any text in any language, assistant will create a detailed summary of that text. The summary must be in the same language as the posted text. Assistant will produce only the summary text and no additional or other response. {{{summaryFormat}}}"},
        {"role": "user", "content": "Text to summarize:\n{{{text}}}"}
        ]}),
    ],

    // Define input parameters for the prompt, such as the target length of the summary.
    inputParameters: {
        targetLength: 0,
        summaryFormat: ''
    },

    model: 'azure-turbo-chat',
}