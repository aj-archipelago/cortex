import test from 'ava';
import media from '../../../pathways/media_generate.js';
import mermaid from '../../../pathways/system/entity/tools/sys_tool_mermaid.js';
import { config } from '../../../config.js';

function configure(t, rootResolver) {
    const oldModels = config.get('models');
    const oldPathways = config.get('pathways');
    config.set('models', { ...oldModels, 'hotfix-test': { metadata: { pathwayName: 'image_gemini_3' } } });
    config.set('pathways', { ...oldPathways, image_gemini_3: { rootResolver } });
    t.teardown(() => { config.set('models', oldModels); config.set('pathways', oldPathways); });
}

test.serial('generated media rejects a missing storage context before generation', async t => {
    let calls = 0;
    configure(t, async () => { calls++; return { result: 'generated' }; });
    await t.throwsAsync(() => media.executePathway({ args: { model: 'hotfix-test', text: 'test' }, resolver: {} }), { code: 'MEDIA_STORAGE_CONTEXT_REQUIRED' });
    t.is(calls, 0);
});

test.serial('normalization failure after generation never regenerates the artifact', async t => {
    let calls = 0;
    configure(t, async () => { calls++; return { result: 'generated' }; });
    const resolver = { pathwayResultData: { get artifacts() { throw new Error('Artifact storage unavailable'); } } };
    await t.throwsAsync(() => media.executePathway({ args: { model: 'hotfix-test', text: 'test', contextId: 'owner-context' }, resolver }), { message: 'Artifact storage unavailable' });
    t.is(calls, 1);
});

for (const status of [400, 401, 403]) {
    test(`chart stops after terminal provider ${status}`, async t => {
        let calls = 0;
        const result = await mermaid.executePathway({ args: { chatHistory: [] }, resolver: { pathwayResultData: {} }, runAllPrompts: async () => { calls++; throw Object.assign(new Error('Provider rejected request'), { status }); } });
        t.is(calls, 1);
        t.regex(result, /after 1 attempts.*Provider rejected request/);
    });
}

test('chart preserves resolver failure instead of retrying missing Mermaid', async t => {
    let calls = 0;
    const resolver = { errors: ['Invalid provider parameter'], pathwayResultData: {} };
    const result = await mermaid.executePathway({ args: { chatHistory: [] }, resolver, runAllPrompts: async () => { calls++; return null; } });
    t.is(calls, 1);
    t.regex(result, /Invalid provider parameter/);
});
