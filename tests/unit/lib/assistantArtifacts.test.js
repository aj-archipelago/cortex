import test from 'ava';
import { writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readAssistantArtifact, MAX_TEAM_ARTIFACT_BYTES } from '../../../lib/assistantArtifacts.js';
const content = Buffer.from('reviewed artifact');
const args = { userId: 'owner', entityId: 'personal', path: '/workspace/teams/demo/index.html', sha256: createHash('sha256').update(content).digest('hex') };
const store = { getEntity: async () => ({ id: 'personal', personalOwnerId: 'owner', assocUserIds: ['owner'] }) };
test('artifact delivery checks the exact reviewed hash and removes temporary files', async t => {
    let local;
    const result = await readAssistantArtifact(store, args, async (entity, remote, destination, options) => {
        t.is(entity, 'personal'); t.is(remote, args.path); t.is(options.maxBytes, MAX_TEAM_ARTIFACT_BYTES);
        local = destination; await writeFile(local, content); return { success: true };
    });
    t.is(result.base64, content.toString('base64'));
    t.is(result.filename, 'index.html');
    await t.throwsAsync(access(local));
});
test('artifact delivery rejects ownership changes and traversal before fetching', async t => {
    const download = async () => { t.fail('must not fetch'); };
    await t.throwsAsync(readAssistantArtifact(store, { ...args, userId: 'other' }, download), { message: /not owned/ });
    await t.throwsAsync(readAssistantArtifact(store, { ...args, path: '/workspace/../secret' }, download), { message: /Invalid artifact path/ });
});
test('artifact delivery fails closed for changed bytes and cleans up after failure', async t => {
    let local;
    await t.throwsAsync(readAssistantArtifact(store, args, async (entity, remote, destination) => {
        local = destination; await writeFile(local, 'unreviewed'); return { success: true };
    }), { message: /changed since review/ });
    await t.throwsAsync(access(local));
});
