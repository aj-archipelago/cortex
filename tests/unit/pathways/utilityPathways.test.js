import test from 'ava';
import passPathway from '../../../pathways/pass.js';
import translateJsonValues from '../../../pathways/translate_json_values.js';

test('pass pathway returns the input text template with a configured model', (t) => {
    t.is(passPathway.prompt, '{{text}}');
    t.is(passPathway.model, 'oai-gpturbo');
});

test('translate_json_values requests JSON output and disables chunking', (t) => {
    t.true(translateJsonValues.json);
    t.false(translateJsonValues.useInputChunking);
    t.true(translateJsonValues.enableCache);
    t.is(translateJsonValues.model, 'oai-gpt4o');

    const [systemMessage, userMessage] = translateJsonValues.prompt[0].messages;
    t.regex(systemMessage.content, /valid JSON object/);
    t.regex(systemMessage.content, /only values will be translated/);
    t.regex(userMessage.content, /\{\{text\}\}/);
});
