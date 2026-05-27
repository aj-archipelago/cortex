import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFile, writeFile, editFile, browseDir } from '../lib/files.js';

const TEST_DIR = '/tmp/workspace-test-files';

describe('files', () => {
    before(async () => {
        await fs.mkdir(TEST_DIR, { recursive: true });
    });

    after(async () => {
        await fs.rm(TEST_DIR, { recursive: true, force: true });
    });

    describe('writeFile', () => {
        it('writes a text file', async () => {
            const result = await writeFile(path.join(TEST_DIR, 'test.txt'), 'hello world');
            assert.ok(!result.error);
            assert.equal(result.bytesWritten, 11);
            const content = await fs.readFile(path.join(TEST_DIR, 'test.txt'), 'utf8');
            assert.equal(content, 'hello world');
        });

        it('creates parent directories', async () => {
            const result = await writeFile(path.join(TEST_DIR, 'sub/dir/file.txt'), 'nested');
            assert.ok(!result.error);
            const content = await fs.readFile(path.join(TEST_DIR, 'sub/dir/file.txt'), 'utf8');
            assert.equal(content, 'nested');
        });

        it('writes base64 content', async () => {
            const b64 = Buffer.from('binary data').toString('base64');
            const result = await writeFile(path.join(TEST_DIR, 'binary.bin'), b64, { encoding: 'base64' });
            assert.ok(!result.error);
            const content = await fs.readFile(path.join(TEST_DIR, 'binary.bin'));
            assert.equal(content.toString(), 'binary data');
        });
    });

    describe('readFile', () => {
        before(async () => {
            const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
            await fs.writeFile(path.join(TEST_DIR, 'multiline.txt'), lines);
        });

        it('reads entire file', async () => {
            const result = await readFile(path.join(TEST_DIR, 'test.txt'));
            assert.ok(!result.error);
            assert.equal(result.content, 'hello world');
            assert.equal(result.truncated, false);
        });

        it('reads line range', async () => {
            const result = await readFile(path.join(TEST_DIR, 'multiline.txt'), { startLine: 5, endLine: 10 });
            assert.ok(!result.error);
            assert.equal(result.startLine, 5);
            assert.equal(result.endLine, 10);
            assert.equal(result.returnedLines, 6);
            assert.ok(result.content.startsWith('line 5'));
        });

        it('reads as base64', async () => {
            const result = await readFile(path.join(TEST_DIR, 'test.txt'), { encoding: 'base64' });
            assert.ok(!result.error);
            assert.equal(result.encoding, 'base64');
            assert.equal(Buffer.from(result.content, 'base64').toString(), 'hello world');
        });

        it('returns error for missing file', async () => {
            const result = await readFile(path.join(TEST_DIR, 'nope.txt'));
            assert.ok(result.error);
            assert.ok(result.error.includes('not found'));
        });
    });

    describe('editFile', () => {
        before(async () => {
            await fs.writeFile(path.join(TEST_DIR, 'edit.txt'), 'foo bar foo baz');
        });

        it('replaces first occurrence', async () => {
            await fs.writeFile(path.join(TEST_DIR, 'edit-single.txt'), 'foo bar foo baz');
            const result = await editFile(path.join(TEST_DIR, 'edit-single.txt'), 'foo', 'qux');
            assert.ok(!result.error);
            assert.equal(result.replacements, 1);
            const content = await fs.readFile(path.join(TEST_DIR, 'edit-single.txt'), 'utf8');
            assert.equal(content, 'qux bar foo baz');
        });

        it('replaces all occurrences', async () => {
            await fs.writeFile(path.join(TEST_DIR, 'edit-all.txt'), 'foo bar foo baz');
            const result = await editFile(path.join(TEST_DIR, 'edit-all.txt'), 'foo', 'qux', { replaceAll: true });
            assert.ok(!result.error);
            assert.equal(result.replacements, 2);
            const content = await fs.readFile(path.join(TEST_DIR, 'edit-all.txt'), 'utf8');
            assert.equal(content, 'qux bar qux baz');
        });

        it('returns error when string not found', async () => {
            const result = await editFile(path.join(TEST_DIR, 'edit.txt'), 'zzz', 'aaa');
            assert.ok(result.error);
            assert.ok(result.error.includes('not found'));
        });
    });

    describe('browseDir', () => {
        before(async () => {
            await fs.mkdir(path.join(TEST_DIR, 'browse/inner'), { recursive: true });
            await fs.writeFile(path.join(TEST_DIR, 'browse/a.txt'), 'a');
            await fs.writeFile(path.join(TEST_DIR, 'browse/inner/b.txt'), 'b');
        });

        it('lists directory entries', async () => {
            const result = await browseDir(path.join(TEST_DIR, 'browse'));
            assert.ok(!result.error);
            assert.ok(Array.isArray(result.entries));
            const names = result.entries.map(e => e.name);
            assert.ok(names.includes('a.txt'));
            assert.ok(names.includes('inner'));
        });

        it('supports recursive listing', async () => {
            const result = await browseDir(path.join(TEST_DIR, 'browse'), { recursive: true });
            assert.ok(!result.error);
            const innerDir = result.entries.find(e => e.name === 'inner');
            assert.ok(innerDir.children);
            assert.ok(innerDir.children.some(c => c.name === 'b.txt'));
        });

        it('returns error for missing dir', async () => {
            const result = await browseDir(path.join(TEST_DIR, 'nope'));
            assert.ok(result.error);
        });
    });
});
