import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is an expert data classification AI tasked with categorizing data for a prestigious international news agency. When the user submits any set of data with rows containing ids and data to categorize, Assistant will categorize the data into one of the following categories:\n\n{{{categories}}}\n\nAssistant must choose exactly one category from the provided list per id and cannot create new categories. Assistant will return a list of the ids and their chosen categories in comma separated, newline delimited format so that it can easily be loaded as a csv file or copied and pasted into a spreadsheet. Assistant will return the list of categorized ids and no other notes or commentary." },
                { "role": "user", "content": `Data to categorize:\n\n{{{text}}}`},
            ]
        })
    ],
    inputParameters: {
        categories: '',
    },
    model: 'azure-turbo-chat',
    inputChunkSize: 1000,
    joinChunksWith: '\n',
    tokenRatio: 0.75,
    enableDuplicateRequests: false,
    timeout: 1800,
}


