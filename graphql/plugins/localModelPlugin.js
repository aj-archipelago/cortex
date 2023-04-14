// localModelPlugin.js
import ModelPlugin from './modelPlugin.js';
import { execFileSync } from 'child_process';
import { encode } from 'gpt-3-encoder';

class LocalModelPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // if the input starts with a chatML response, just return that
    filterFirstResponse(inputString) {
        const regex = /^(.*?)(?=\n<\|im_end\|>|$)/;
        const match = inputString.match(regex);

        if (match) {
            const firstAssistantResponse = match[1];
            return firstAssistantResponse;
        } else {
            return inputString;
        }
    }

    getRequestParameters(text, parameters, prompt) {
        let { modelPromptMessages, modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
        
        if (modelPromptMessages) {
            const minMsg = [{ role: "system", content: "" }];
            const addAssistantTokens = encode(this.messagesToChatML(minMsg, true).replace(this.messagesToChatML(minMsg, false), '')).length;
            const requestMessages = this.truncateMessagesToTargetLength(modelPromptMessages, (modelTargetTokenLength - addAssistantTokens));
            modelPromptText = this.messagesToChatML(requestMessages);
            tokenLength = encode(modelPromptText).length;
        }

        if (tokenLength > modelTargetTokenLength) {
            throw new Error(`Input is too long at ${tokenLength} tokens. The target token length for this pathway is ${modelTargetTokenLength} tokens because the response is expected to take up the rest of the ${this.getModelMaxTokenLength()} tokens that the model can handle. You must reduce the size of the prompt to continue.`);
        }

        const max_tokens = this.getModelMaxTokenLength() - tokenLength;

        return {
            prompt: modelPromptText,
            max_tokens: max_tokens,
            temperature: this.temperature ?? 0.7,
        };
    }

    async execute(text, parameters, prompt, _pathwayResolver) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { executablePath, args } = this.model;
        args.push("--prompt", requestParameters.prompt);
        //args.push("--max-tokens", requestParameters.max_tokens);
        //args.push("--temperature", requestParameters.temperature);

        try {
            console.log(`\x1b[36mRunning local model:\x1b[0m`, executablePath, args);
            const result = execFileSync(executablePath, args, { encoding: 'utf8' });
            // Remove only the first occurrence of requestParameters.prompt from the result
            // Could have used regex here but then would need to escape the prompt
            const parts = result.split(requestParameters.prompt, 2);
            const modifiedResult = parts[0] + parts[1];
            console.log(`\x1b[36mResult:\x1b[0m`, modifiedResult);
            return this.filterFirstResponse(modifiedResult);
        } catch (error) {
            console.error(`\x1b[31mError running local model:\x1b[0m`, error);
            throw error;
        }
    }
}

export default LocalModelPlugin;
