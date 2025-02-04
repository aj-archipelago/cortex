// sys_ollama_completion.js
// default handler for ollama completion endpoints when REST endpoints are enabled

export default {
    prompt: `{{text}}`,
    inputParameters: {
        text: '',
        model: 'ollama-completion',
    },
    model: 'ollama-completion',
    useInputChunking: false,
    emulateOpenAICompletionModel: 'ollama-completion',
}