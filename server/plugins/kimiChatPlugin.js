// Kimi K2.x — OpenAI-compatible chat completions, but the Foundry/sglang
// deployment differs from real OpenAI in three ways:
//   1. Roles: only system | user | assistant | tool (no `developer`)
//   2. reasoning_effort: enum varies between deployments — we only emit a value
//      when it maps cleanly via the model's reasoningEffortMap.
//   3. Images: sglang fetches image_url URLs server-side with no retry, and that
//      single attempt frequently fails on transient TLS errors against Azure
//      Blob SAS URLs. Inline as base64 data URLs before posting.
import OpenAIVisionPlugin from './openAiVisionPlugin.js';
import axios from 'axios';
import logger from '../../lib/logger.js';

async function fetchImageAsDataURL(imageUrl) {
    const dataResponse = await axios.get(imageUrl, {
        timeout: 30000,
        responseType: 'arraybuffer',
        maxRedirects: 5,
    });
    const contentType = dataResponse.headers['content-type'] || 'image/jpeg';
    const base64Image = Buffer.from(dataResponse.data).toString('base64');
    return `data:${contentType};base64,${base64Image}`;
}

// Walk an OpenAI-format messages array and inline any non-data image URLs.
// Failures leave the original URL in place so Kimi can surface the real error.
async function inlineImageUrls(messages) {
    if (!Array.isArray(messages)) return;
    const fetches = [];
    for (const message of messages) {
        if (!Array.isArray(message?.content)) continue;
        for (const part of message.content) {
            const url = part?.image_url?.url;
            if (!url || url.startsWith('data:')) continue;
            fetches.push(
                fetchImageAsDataURL(url)
                    .then((dataUrl) => { part.image_url.url = dataUrl; })
                    .catch((err) => {
                        logger.warn(`KimiChatPlugin: failed to inline image ${url}: ${err.message}`);
                    })
            );
        }
    }
    await Promise.all(fetches);
}

class KimiChatPlugin extends OpenAIVisionPlugin {

    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = await super.getRequestParameters(text, parameters, prompt);

        const parseTokenLimit = (value) => {
            if (value === undefined || value === null || value === '') return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        };

        const modelMaxReturnTokens = this.getModelMaxReturnTokens();
        const maxTokensRequest = parseTokenLimit(
            parameters.max_completion_tokens
            ?? parameters.max_tokens
            ?? parameters.max_output_tokens,
        );
        const maxTokensPrompt = this.promptParameters.max_tokens;
        const maxTokensModel = this.getModelMaxTokenLength() * (1 - this.getPromptTokenRatio());
        const maxTokens = maxTokensRequest || maxTokensPrompt || maxTokensModel;

        delete requestParameters.max_tokens;
        requestParameters.max_completion_tokens = maxTokens
            ? Math.min(maxTokens, modelMaxReturnTokens)
            : modelMaxReturnTokens;

        const reasoningEffort = parameters.reasoningEffort || this.promptParameters.reasoningEffort;
        if (reasoningEffort) {
            const effort = reasoningEffort.toLowerCase();
            const effortMap = this.model.reasoningEffortMap;
            if (effortMap && effortMap[effort]) {
                requestParameters.reasoning_effort = effortMap[effort];
            }
        }

        if (this.promptParameters.responseFormat) {
            requestParameters.response_format = this.promptParameters.responseFormat;
        }

        await inlineImageUrls(requestParameters.messages);

        return requestParameters;
    }
}

export default KimiChatPlugin;
