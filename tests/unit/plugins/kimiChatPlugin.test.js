import test from 'ava';
import KimiChatPlugin from '../../../server/plugins/kimiChatPlugin.js';
import { Prompt } from '../../../server/prompt.js';

const createPlugin = () => new KimiChatPlugin({
    name: 'kimi-test',
    prompt: [new Prompt({ messages: [{ role: 'user', content: '{{text}}' }] })],
}, {
    name: 'kimi-k2-6',
    maxTokenLength: 262144,
    maxReturnTokens: 84000,
});

test('KimiChatPlugin honors explicit sampler token caps', async (t) => {
    const plugin = createPlugin();

    const requestParameters = await plugin.getRequestParameters('ping', {
        stream: true,
        max_tokens: 16,
        max_output_tokens: 16,
        max_completion_tokens: 16,
    }, plugin.pathwayPrompt[0]);

    t.deepEqual(requestParameters.messages, [{ role: 'user', content: 'ping' }]);
    t.is(requestParameters.max_tokens, undefined);
    t.is(requestParameters.max_completion_tokens, 16);
});
