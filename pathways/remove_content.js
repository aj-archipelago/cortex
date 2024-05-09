import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is highly skilled news editor at a prestigious international news agency. Assistant's task is to remove specific detail from a news excerpt" },
                { "role": "user", "content": "NEWS: After weeks of resistance, and ahead of a vote that could have compelled it to happen, Prime Minister Justin Trudeau’s office announced Tuesday that his chief of staff Katie Telford will testify about foreign election interference, before a committee that has been studying the issue for months. DELETE: Katie Telford is Trudeaus's chief of staff" },
                { "role": "assistant", "content": "After weeks of resistance, and ahead of a vote that could have compelled it to happen, Prime Minister Justin Trudeau’s office announced Tuesday that Katie Telford will testify about foreign election interference, before a committee that has been studying the issue for months" },
                { "role": "user", "content": "NEWS: It seems that the arms race in the field of missiles and anti-missiles is in full swing these days. While traditional defenses are being thwarted in conflicts such as the Ukrainian War, and increasingly appearing in US defense plans, the anti-missile measures presented at the Johar Air Show indicate that Beijing is also preparing for this vital aspect of the future of wars. DELETE: Arms race in the field of missiles and anti-missiles is in full swing" },
                { "role": "assistant", "content": "While traditional defenses are being thwarted in conflicts such as the Ukrainian War, and increasingly appearing in US defense plans, the anti-missile measures presented at the Johar Air Show indicate that Beijing is also preparing for this vital aspect of the future of wars." },
                {
                    "role": "user", "content":
                        `NEWS: Sundowns leads the group with 11 points, one point ahead of Al-Hilal in second place. Al-Ahly comes in third place with 7 points, while Cotonsport of Cameroon is in last place without points.

                Al-Hilal said in its statement that CAF had not responded to three previous letters and asked it to take a stance before a "new Burseid". DELETE: Cotonsport of Cameroon is in last place without points.`},
                {
                    "role": "assistant", "content": `
                Sundowns leads the group with 11 points, one point ahead of Al-Hilal in second place. Al-Ahly comes in third place with 7 points.

                Al-Hilal said in its statement that CAF had not responded to three previous letters and asked it to take a stance before a "new Burseid". ` },
                { "role": "user", "content": "NEWS: {{text}}. DELETE: {{content}}" },

            ]
        })],
    inputParameters: {
        content: "",
    },
    model: 'azure-turbo-chat',
    temperature: 0.0,
}
