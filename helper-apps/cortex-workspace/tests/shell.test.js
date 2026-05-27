import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execSync, execBackground, getResult, listBackgroundJobs } from '../lib/shell.js';

const TEST_DIR = '/tmp/workspace-test-shell';

describe('shell', () => {
    before(async () => {
        await fs.mkdir(TEST_DIR, { recursive: true });
    });

    after(async () => {
        await fs.rm(TEST_DIR, { recursive: true, force: true });
    });

    describe('execSync', () => {
        it('runs a simple command', async () => {
            const result = await execSync('echo hello', { cwd: TEST_DIR });
            assert.equal(result.success, true);
            assert.equal(result.stdout.trim(), 'hello');
            assert.equal(result.exitCode, 0);
            assert.equal(typeof result.durationMs, 'number');
        });

        it('captures stderr', async () => {
            const result = await execSync('echo err >&2', { cwd: TEST_DIR });
            assert.equal(result.stderr.trim(), 'err');
        });

        it('returns failure for bad command', async () => {
            const result = await execSync('exit 42', { cwd: TEST_DIR });
            assert.equal(result.success, false);
            assert.equal(result.exitCode, 42);
        });

        it('handles timeout', async () => {
            const result = await execSync('sleep 60', { cwd: TEST_DIR, timeout: 500 });
            assert.equal(result.success, false);
            assert.equal(result.killed, true);
        });

        it('handles pipelines', async () => {
            const result = await execSync('echo "a b c" | tr " " "\\n" | wc -l', { cwd: TEST_DIR });
            assert.equal(result.success, true);
            assert.equal(result.stdout.trim(), '3');
        });

        it('respects cwd', async () => {
            const result = await execSync('pwd', { cwd: TEST_DIR });
            assert.equal(result.success, true);
            // macOS resolves /tmp -> /private/tmp, so normalize
            assert.ok(result.stdout.trim().endsWith(TEST_DIR.replace('/tmp/', '')));
        });
    });

    describe('execBackground', () => {
        it('returns processId immediately', () => {
            const result = execBackground('sleep 0.1', { cwd: TEST_DIR });
            assert.ok(result.processId);
            assert.equal(typeof result.processId, 'string');
        });

        it('result is eventually available', async () => {
            const { processId } = execBackground('echo bg-done', { cwd: TEST_DIR });
            // Wait for completion
            await new Promise(r => setTimeout(r, 500));
            const result = getResult(processId);
            assert.equal(result.status, 'completed');
            assert.equal(result.stdout.trim(), 'bg-done');
        });

        it('shows running status for active process', () => {
            const { processId } = execBackground('sleep 1', { cwd: TEST_DIR });
            const result = getResult(processId);
            assert.equal(result.status, 'running');
            // Kill the process to clean up
            const entry = getResult(processId);
            assert.ok(entry);
        });
    });

    describe('getResult', () => {
        it('returns error for unknown processId', () => {
            const result = getResult('nonexistent');
            assert.ok(result.error);
        });
    });

    describe('listBackgroundJobs', () => {
        it('returns array of jobs', () => {
            const jobs = listBackgroundJobs();
            assert.ok(Array.isArray(jobs));
        });
    });
});
