import test from 'ava';

import locations from '../../../pathways/locations.js';
import selectExtension from '../../../pathways/select_extension.js';

test('locations exposes prompt and model override inputs', (t) => {
    t.is(locations.inputParameters.locationPrompt, '');
    t.is(locations.inputParameters.model, 'oai-gpt4o');
});

test('select_extension declares JSON output', (t) => {
    t.true(selectExtension.json);
});
