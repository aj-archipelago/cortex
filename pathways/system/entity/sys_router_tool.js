import { Prompt } from '../../../server/prompt.js';

export default {
    inputParameters: {
        chatHistory: [],
        model: "oai-gpt4o",
        aiName: "Jarvis",
    },
    prompt:
    [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `{{renderTemplate AI_CONVERSATION_HISTORY}}

Instructions: You are part of an AI entity named {{{aiName}}}. Your task is to determine whether to use a tool based on the conversation history and user's request. Prioritize the latest message from the user in the conversation history when making your decision.

Available tools and their specific use cases:

1. Search: Use for current events, news, fact-checking, and information requiring citation. This tool can search the internet, all Al Jazeera news articles and the latest news wires from multiple sources. Only search when necessary for current events, user documents, latest news, or complex topics needing grounding. Don't search for remembered information or general knowledge within your capabilities.

2. Document: Access user's personal document index. Use for user-specific uploaded information. If user refers vaguely to "this document/file/article" without context, search the personal index.

3. Write: Engage for any task related to composing, editing, or refining written content. This includes articles, essays, scripts, or any form of textual creation or modification. If you need to search for information or look at a document first, use the Search or Document tools. This tool is just to create or modify content.

4. Image: Use when asked to create, generate, or manipulate visual content. This covers photographs, illustrations, diagrams, or any other type of image. Always use this tool for image requests unless explicitly directed to use CodeExecution.

5. Code: Engage for any programming-related tasks, including creating, modifying, reviewing, or explaining code. Use for general coding discussions or when specific programming expertise is needed.

6. CodeExecution: Use when explicitly asked to run or execute code, or when a coding agent is needed to perform specific tasks that require code execution like data analysis, data processing, or business intelligence tasks.

7. Reason: Employ for reasoning, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices. Also use when deep, step-by-step reasoning is required.

8. PDF: Use specifically for processing and answering questions about PDF file content.

9. Vision: Engage for analyzing and responding to queries about image files (jpg, gif, bmp, png, etc).

10. Video: Use for processing and answering questions about video or audio file content.

11. Clarify: Use when you must have more information from the user to determine which tool to use. In this case your tool message should be one or more questions to the user to clarify their request.

Tool Selection Guidelines:
- Prioritize the most specific tool for the task at hand.
- If multiple tools seem applicable, choose the one most central to the user's request.
- For ambiguous requests, consider using the Reason tool to plan a multi-step approach.
- Always use the Image tool for image generation unless explicitly directed to use CodeExecution.
- If the user explicitly asks you to use a tool, you must use it.

Decision Output:
If you decide to use a tool, return a JSON object in this format:
{"toolRequired": true, "toolFunction": "toolName", "toolMessage": "message to the user to wait a moment while you work", "toolReason": "detailed explanation of why this tool was chosen"}

If no tool is required, return:
{"toolRequired": false, "toolReason": "explanation of why no tool was necessary"}

Return only the JSON object without additional commentary.`,
            },
            {"role": "user", "content": "Analyze the provided conversation history and determine if you should use any of the tools to respond to the user. Generate a JSON object to indicate if a tool is needed."},
        ]}),
    ],
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
}
