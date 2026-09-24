import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('encrypted checkpoint carries an inventory, restores exact files and rejects writes during backup', { skip: process.platform !== 'linux' && 'Workspace helper uses GNU tar on Linux' }, async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-roundtrip-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'workspace');
    await fs.mkdir(path.join(root, 'project'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'verified recovery');
    await fs.writeFile(path.join(root, 'project', 'state.json'), '{"saved":true}');
    const systemUrl = new URL('../lib/system.js', import.meta.url).href;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { uploadStreamingBackupToUrl, restoreBackupFromUrlEncrypted, __testables } from ${JSON.stringify(systemUrl)};
        const chunks = []; let metadata;
        __testables.setBlockUploadRunnerForTest(async event => {
            if (event.type === 'block') chunks.push(Buffer.from(event.chunk));
            else metadata = event.metadata;
        });
        const keyBase64 = Buffer.alloc(32, 7).toString('base64');
        const checkpoint = await uploadStreamingBackupToUrl('https://storage.test/archive', {}, { algorithm: 'aes-256-gcm', keyBase64 });
        assert.equal(checkpoint.error, undefined);
        assert.equal(checkpoint.inventory.fileCount, 2);
        assert.deepEqual(JSON.parse(Buffer.from(metadata.checkpointInventory, 'base64').toString()), checkpoint.inventory);
        await fs.rm(process.env.WORKSPACE_DIR, { recursive: true });
        await fs.mkdir(process.env.WORKSPACE_DIR);
        global.fetch = async () => new Response(Buffer.concat(chunks));
        const encryption = { ...checkpoint.encryption, keyBase64 };
        const restored = await restoreBackupFromUrlEncrypted('https://storage.test/archive', encryption, checkpoint.inventory);
        assert.equal(restored.error, undefined);
        assert.equal(await fs.readFile(process.env.WORKSPACE_DIR + '/README.md', 'utf8'), 'verified recovery');
        const rejected = await restoreBackupFromUrlEncrypted('https://storage.test/archive', encryption, { ...checkpoint.inventory, structureHash: '0'.repeat(64) });
        assert.match(rejected.error, /inventory does not match/);
        let committed = false;
        __testables.setBlockUploadRunnerForTest(async event => {
            if (event.type === 'block') await fs.writeFile(process.env.WORKSPACE_DIR + '/changed-during-backup', 'new');
            else committed = true;
        });
        const unstable = await uploadStreamingBackupToUrl('https://storage.test/archive', {}, { algorithm: 'aes-256-gcm', keyBase64 });
        assert.match(unstable.error, /changed during backup/);
        assert.equal(committed, false);
        console.log('roundtrip verified');
    `], { encoding: 'utf8', env: { ...process.env, WORKSPACE_DIR: root, WORKSPACE_PERSIST_DIR: path.join(base, 'persist'), WORKSPACE_CHECKPOINT_COMPRESSION: 'gzip', COPYFILE_DISABLE: '1' }, timeout: 30000 });
    assert.match(result, /roundtrip verified/);
});
