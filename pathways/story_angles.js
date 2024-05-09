import { Prompt } from "../server/prompt.js";

export default {
    prompt: [new Prompt({
        messages: [
            { "role": "system", "content": "Assistant is highly skilled news editor at a prestigious international news agency. Assistant's task is to identify angles of emphasis in a news story." },
            { "role": "user", "content": "Give me a numbered list of angles that can be emphasized in the following news excerpt. Don't need explanations, just a short phrase (< 5 words) describing the angle. Sort them by decreasing order of relevance.\n\nNews excerpt\n{{text}}" },
        ]
    })],
    model: 'azure-turbo-chat',
    list: true,
    useInputChunking: false,
}