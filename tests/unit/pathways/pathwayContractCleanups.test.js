import test from 'ava';

import selectServices from '../../../pathways/select_services.js';
import tags from '../../../pathways/tags.js';
import topics from '../../../pathways/topics.js';

test('taxonomy wrapper pathways expose taxonomy configuration inputs', (t) => {
    for (const pathway of [tags, topics]) {
        t.is(pathway.inputParameters.initialFilterPrompt, '');
        t.is(pathway.inputParameters.singleSelectPrompt, '');
        t.is(pathway.inputParameters.rankingPrompt, '');
        t.is(pathway.inputParameters.model, 'oai-gpt4o');
    }
});

test('select_services declares JSON output', (t) => {
    t.true(selectServices.json);
});
