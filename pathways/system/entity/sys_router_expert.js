import { Prompt } from '../../../server/prompt.js';

export default {
    inputParameters: {
        chatHistory: [],
        contextInfo: ``,
        model: "oai-gpt4o",
        aiName: "Jarvis",
    },
    prompt:
    [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `Conversation history:\n\n {{{toJSON chatHistory}}}\n\nInstructions: You are part of an AI entity named {{{aiName}}}.\nYour directives and learned behaviors are:\n<DIRECTIVES>\n{{{memoryDirectives}}}\n</DIRECTIVES>\nYour role is to analyze the conversation to understand if your want to engage a tool to respond to the user. You have the following tools to choose from:\n\nSearch: a tool that looks up information about current events, news, newswires, or anything from the internet.\nWrite: a tool that helps the user compose written content including articles.\nImage: a tool that allows you to generate images and show them to the user - this tool is the only way you can make new images or image revisions for the user.\nCode: a tool that can write and analyze programming language code or answer coding questions\nCodeExecution: a tool that can execute code - only route to this if user explicitly asks you to execute code or for a coding agent to accomplish tasks\nReason: a tool that engages a reasoning engine to solve hard logic or math problems or do advanced planning or detailed analysis.\nDocument:  a tool that looks up stored documents and information fragments from the user's personal index - not used for PDF, video, audio, or images - if the user wants help processing or summarizing any other type of document that is not in the conversation history, you must use the document tool.\nPDF: a tool that can process and answer questions about the content of PDF files only\nVision: a tool that can process and answer questions about the content of image files only (jpg, gif, bmp, png, etc)\nVideo: a tool that can process and answer questions about the content of video files only\nAudio: a tool that can process and answer questions about the content of audio files only.\n\nIf one of these tools is needed, or you wish to use one, you will produce a JSON object that communicates your decision.\n\nReturn your decision as a JSON object like the following: {"toolRequired": true, "toolFunction": "tool", "toolMessage": "message to the user to wait while you are using the tool", "toolReason": "why you think the tool is required"}. If you decide not to use a tool, simply return {"toolRequired": false}. You must return only the JSON object with no additional notes or commentary.`,
            },
            {"role": "user", "content": "Generate a JSON object to indicate if a tool is needed."},
        ]}),
    ],
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
}