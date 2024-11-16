// sys_openai_completion.js
// default handler for openAI completion endpoints when REST endpoints are enabled

export default {
    prompt: `{{text}}`,
    model: 'oai-gpturbo',
    useInputChunking: false,
    emulateOpenAICompletionModel: '*',
}