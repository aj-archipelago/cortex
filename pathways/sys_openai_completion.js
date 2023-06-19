// sys_openai_completion.js
// default handler for openAI completion endpoints when REST endpoints are enabled

import { Prompt } from '../server/prompt.js';

export default {
    prompt: `{{text}}`,
    model: 'oai-gpturbo',
    useInputChunking: false,
    emulateOpenAICompletionModel: '*',
}