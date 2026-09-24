import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectCheckpointInventory, CHECKPOINT_EXCLUDES, assertCheckpointInventory, encodeCheckpointInventory, inventoryFromMetadata } from '../lib/checkpoint_inventory.js';
const unicodeName = 'résumé.txt'.normalize('NFD'); // macOS tar returns decomposed file names.

async function fixture(t) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-inventory-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'workspace');
    await fs.mkdir(path.join(root, 'project', 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(root, 'empty'));
    await fs.writeFile(path.join(root, '.env'), 'excluded');
    await fs.writeFile(path.join(root, 'project', 'node_modules', 'dependency'), 'excluded');
    await fs.writeFile(path.join(root, 'README.md'), 'hello');
    await fs.writeFile(path.join(root, 'project', unicodeName), 'saved');
    await fs.symlink(base, path.join(root, 'files'));
    await fs.symlink('README.md', path.join(root, 'readme-link'));
    return { base, root };
}

test('inventory shares tar exclusions, preserves empty directories and never follows links', async t => {
    const { root } = await fixture(t);
    const before = await collectCheckpointInventory(root);
    assert.equal(before.fileCount, 3);
    assert.equal(before.fileBytes, 10);
    assert.deepEqual(before.topLevelPaths, ['README.md', 'empty', 'project', 'readme-link']);
    await fs.writeFile(path.join(root, '.env'), 'different settings');
    await fs.writeFile(path.join(root, 'project', 'node_modules', 'new'), 'installed later');
    assert.deepEqual(await collectCheckpointInventory(root), before);
    assert.deepEqual(inventoryFromMetadata({ checkpointinventory: encodeCheckpointInventory(before) }), before);
});

test('inventory detects edits, removals and mode changes without reading file contents', async t => {
    const { root } = await fixture(t);
    const before = await collectCheckpointInventory(root);
    await fs.writeFile(path.join(root, 'README.md'), 'changed content');
    const edited = await collectCheckpointInventory(root);
    assert.notEqual(edited.fingerprint, before.fingerprint);
    await fs.chmod(path.join(root, 'README.md'), 0o600);
    assert.notEqual((await collectCheckpointInventory(root)).structureHash, edited.structureHash);
    await fs.unlink(path.join(root, 'project', unicodeName));
    assert.equal((await collectCheckpointInventory(root)).fileCount, 2);
});

test('a real tar round trip verifies independently of extraction timestamps', async t => {
    const { base, root } = await fixture(t);
    const before = await collectCheckpointInventory(root);
    const archive = path.join(base, 'archive.tar');
    const destination = path.join(base, 'restored');
    await fs.mkdir(destination);
    execFileSync('tar', ['-cf', archive, ...CHECKPOINT_EXCLUDES.map(value => `--exclude=${value}`), '-C', root, '.']);
    execFileSync('tar', ['-xf', archive, '-C', destination]);
    const restored = await collectCheckpointInventory(destination);
    assertCheckpointInventory(before, restored);
    assert.notEqual(before.fingerprint, restored.fingerprint);
    await fs.rename(path.join(destination, 'README.md'), path.join(destination, 'different.md'));
    assert.throws(() => inventoryFromMetadata({ checkpointInventory: 'bad' }), /Invalid/);
    const changed = await collectCheckpointInventory(destination);
    assert.equal(changed.fileCount, before.fileCount);
    assert.throws(() => assertCheckpointInventory(before, changed), /does not match/);
});
