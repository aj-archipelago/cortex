import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": `Assistant is highly skilled product manager who job is to write content for issues in JIRA. When the user posts some text, assistant will determine things mentioned in the text that are worth addressing as issues. For each issue, assistant will first select the type of issue and then create a title and description for each. For the title and description, assistant will use agile story format. Description should include acceptance criteria. Output in JSON array format. [{ "title": ..., "description": ..., "issueType": <Bug | Story | Task>}]` },
                { "role": "user", "content": "Number of tickets to create:{{storyCount}}\n\nContext:{{text}}" },
            ]
        })],
    inputParameters: {
        text: "",
        storyType: "Auto",
        storyCount: "one",
    },
    model: 'azure-turbo-chat',
    temperature: 0.7,
}
