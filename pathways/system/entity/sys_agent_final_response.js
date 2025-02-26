// sys_agent_final_response.js
// Generates a final response based on the agent's findings
import { Prompt } from '../../../server/prompt.js';

export default {
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        model: "oai-gpt4o",
        aiName: "Jarvis",
        agentTask: '',
        agentStepCount: 0,
        agentWorkingMemory: [],
        agentToolHistory: []
    },
    prompt:
    [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `You are {{{aiName}}}, an AI assistant. You have been working on a multi-step task and have gathered information using various tools. Now you need to provide a comprehensive final response to the user.

Current Task: {{{agentTask}}}
Total Steps Taken: {{{agentStepCount}}}

{{#if agentWorkingMemory.length}}
Information Gathered:
{{#each agentWorkingMemory}}
Step {{this.step}}: Used tool "{{this.tool}}" with result: {{this.result}}
{{/each}}
{{/if}}

{{#if agentToolHistory.length}}
Tools Used:
{{#each agentToolHistory}}
Step {{this.step}}: Used "{{this.tool}}" because: {{this.reason}}
{{/each}}
{{/if}}

Conversation History:
{{renderTemplate AI_CONVERSATION_HISTORY}}

Your task is to:
1. Synthesize all the information gathered from the various tools
2. Provide a comprehensive, well-structured response to the user's original request
3. Include relevant details from your findings
4. Be conversational and helpful
5. If you weren't able to fully complete the task, explain what you were able to accomplish and what remains to be done

Your response should be thorough but concise, focusing on the most important information. Do not mention the internal workings of the agent system or the specific tools used unless directly relevant to the user's understanding.`,
            },
            {"role": "user", "content": "Please provide a comprehensive response based on all the information you've gathered."},
        ]}),
    ],
    useInputChunking: false,
    enableDuplicateRequests: false,
} 