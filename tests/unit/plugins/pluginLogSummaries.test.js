import test from 'ava';

import logger from '../../../lib/logger.js';
import ApptekTranslatePlugin from '../../../server/plugins/apptekTranslatePlugin.js';
import AzureFoundryAgentsPlugin from '../../../server/plugins/azureFoundryAgentsPlugin.js';
import AzureTranslatePlugin from '../../../server/plugins/azureTranslatePlugin.js';
import GoogleCsePlugin from '../../../server/plugins/googleCsePlugin.js';
import GoogleTranslatePlugin from '../../../server/plugins/googleTranslatePlugin.js';

function stubLogger() {
    const calls = [];
    const original = {
        info: logger.info,
        verbose: logger.verbose,
    };

    logger.info = (message) => calls.push({ level: 'info', message });
    logger.verbose = (message) => calls.push({ level: 'verbose', message });

    return {
        calls,
        restore() {
            logger.info = original.info;
            logger.verbose = original.verbose;
        },
    };
}

function makePlugin(PluginClass, parseResponse = data => data) {
    const plugin = Object.create(PluginClass.prototype);
    plugin.getLength = text => ({ length: String(text ?? '').length, units: 'characters' });
    plugin.parseResponse = parseResponse;
    return plugin;
}

test('translation plugins log content lengths instead of raw payloads', t => {
    const loggerStub = stubLogger();
    t.teardown(() => loggerStub.restore());

    const azurePlugin = makePlugin(AzureTranslatePlugin, () => 'translated secret output');
    azurePlugin.logRequestData(
        [{ Text: 'sensitive source text' }],
        [{ translations: [{ text: 'translated secret output' }] }],
        {},
    );

    const googlePlugin = makePlugin(GoogleTranslatePlugin, () => 'translated google output');
    googlePlugin.logRequestData(
        { q: ['google source text'] },
        { data: { translations: [{ translatedText: 'translated google output' }] } },
        {},
    );

    const apptekPlugin = makePlugin(ApptekTranslatePlugin, data => data);
    apptekPlugin.logRequestData('apptek source text', 'apptek output text', {});

    t.true(loggerStub.calls.every(call => call.level === 'info'));
    t.true(loggerStub.calls.some(call => call.message.includes('Azure Translate request sent containing')));
    t.true(loggerStub.calls.some(call => call.message.includes('Google Translate response received containing')));
    t.true(loggerStub.calls.some(call => call.message.includes('AppTek Translate request sent containing')));

    const combinedMessages = loggerStub.calls.map(call => call.message).join('\n');
    t.false(combinedMessages.includes('sensitive source text'));
    t.false(combinedMessages.includes('translated secret output'));
    t.false(combinedMessages.includes('google source text'));
    t.false(combinedMessages.includes('apptek source text'));
});

test('search and agent plugins summarize logged payload sizes', t => {
    const loggerStub = stubLogger();
    t.teardown(() => loggerStub.restore());

    const googleCsePlugin = makePlugin(GoogleCsePlugin, data => JSON.stringify(data));
    googleCsePlugin.logRequestData(
        { q: 'search query' },
        { items: [{ title: 'private result text' }] },
        {},
    );

    const foundryPlugin = makePlugin(AzureFoundryAgentsPlugin);
    foundryPlugin.logRequestData(
        {
            thread: {
                messages: [
                    { role: 'user', content: 'agent request secret' },
                    { role: 'assistant', content: 'agent context secret' },
                ],
            },
        },
        'agent response secret',
        {},
    );

    const combinedMessages = loggerStub.calls.map(call => call.message).join('\n');
    t.true(combinedMessages.includes('Google CSE response received containing'));
    t.true(combinedMessages.includes('Azure Foundry Agent request sent containing 2 messages'));
    t.true(combinedMessages.includes('Azure Foundry Agent response received containing'));
    t.false(combinedMessages.includes('private result text'));
    t.false(combinedMessages.includes('agent request secret'));
    t.false(combinedMessages.includes('agent response secret'));
    t.true(loggerStub.calls.every(call => call.level === 'info'));
});
