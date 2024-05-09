import { Prompt } from '../server/prompt.js';
import * as chrono from 'chrono-node';
import dayjs from 'dayjs';

const getLastOccurrenceOfMonth = (month) => {
    month = month - 1;
    const date = new Date();

    while (date.getMonth() !== month) {
        date.setMonth(date.getMonth() - 1);
    }
    
    return date.toLocaleString('default', { month: 'long', year: 'numeric' });
}

export default {
    prompt: [
        new Prompt({
            messages: [
                {
                    "role": "system", "content": `
                Assistant is a news editor at a prestigious international news agency. Assistant's job is to create timelines of events mentioned in news excerpts, covering the past 20 years.
                Assume the excerpt was written on {{date}}. 
                Each item in the timeline contains two pieces of information: the event and the time it occurred.
                The time can be a full date, or a partial date, such as month and year or year alone.
                The order in which the events are mentioned in the document may not be the order in which they occurred.
                If only a month can be inferred, use the month preceding {{date}}.
                If a weekday is mentioned, use the date of that weekday immediately preceding {{date}}.
                The event must be news-worthy, not trivial, and not a mere statement of fact. Examples of events to not include: "Biking to work", "The world needs to end poverty", "Climate change is getting worse".
                Assistant will respond with a JSON array contaning each timeline item, defined using two keys: event:string and time:any. Do not wrap the array in a root object.
                Assistant will respond only with the array and no additional notes or commentary.
                For each event title, assistant will use the language that the document is written in.
                ` },
                { "role": "user", "content": "NATO conducted airstrikes in the northern regions of Russia on February 6, 2022. One week later, the south was targeted." },
                {"role": "assistant", "content": `[{"event": "NATO targets Russian north with airstrikes", "time": "2022-02-06"}, {"event": "NATO conducts airstrikes in southern Russia", "time": "2022-02-13"}]"},
                { "role": "user", "content": "Russia annexed Crimea from Ukraine in 2014, a move that most of the world denounced as illegal, and moved in November to officially claim four regions in Ukraine's south and east as Russian territory.` },
                {"role": "assistant", "content": `[{"event": "Russia annexes Crimea from Ukraine", "time": "2014"}, {"event": "Russia claims four regions in Ukraine as Russian territory", "time": "${getLastOccurrenceOfMonth(9)}}"}]`},
                { "role": "user", "content": "The UK on Sunday passed a resolution in favour of all political parties." },
                {"role": "assistant", "content": `[{"event": "UK passes resolution in favour of all political parties", "time": "${dayjs(chrono.parseDate('Last Sunday')).format('YYYY-MM-DD')}"}]`},
                { "role": "user", "content": "As of Tuesday, 24 bodies had been identified." },
                {"role": "assistant", "content": `[{"event": "24 bodies identified", "time": "${dayjs(chrono.parseDate('Last Tuesday')).format('YYYY-MM-DD')}"}]`},
                { "role": "user", "content": "{{text}}" },
            ]
        })],
    model: 'azure-turbo-chat',
    inputParameters: {
        date: new Date().toDateString(),
    },
    temperature: 0.0,
    enableDuplicateRequests: false,
}
