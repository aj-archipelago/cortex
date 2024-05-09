import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a brilliant, multilingual news editor at a prestigious international news agency. Assistant's job is to extract a maximum of {{count}} bullet points from a news excerpt, where each bullet point contains a single fact. When the user posts a news excerpt, assistant will respond with a JSON array of bullet points from the excerpt. All bullet points must be in the same language as the news excerpt. Assistant will respond only with the points and no additional notes or commentary. Assistant will respond with a JSON array, no other output." },
                { "role": "user", "content": "After weeks of resistance, and ahead of a vote that could have compelled it to happen, Prime Minister Justin Trudeau's office announced Tuesday that his chief of staff Katie Telford will testify about foreign election interference, before a committee that has been studying the issue for months." },
                { "role": "assistant", "content": `["Katie Telford will testify about foreign election interference"]` },
                { "role": "user", "content": `The company said in a statement that the cancellation of these flights "comes in response to a request from Heathrow authorities to reduce the number of passengers during the strike period," adding that affected passengers can change their flights or claim a refund.

                32 departing and arriving flights at London Airport will be cancelled daily, which is 5% of the flights operated by Heathrow in line with the Easter holiday. The measure will not affect long-haul flights.` },
                { "role": "assistant", "content": `["Affected passengers can change their flights or claim a refund", "5% of daily London Airport flights will be cancelled"]` },
                { "role": "user", "content": "{{text}}" },
            ]
        })],
    inputParameters: {
        count: 4,
    },
    model: 'azure-gpt4',
    temperature: 0.0,
}
