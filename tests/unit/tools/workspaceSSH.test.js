import test from 'ava';
import { resetDestroyTimeoutMs, tokenize, toAbsWorkspacePath } from '../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js';

// ============================================================================
// Tokenizer tests
// ============================================================================

test('tokenize › should split simple command', (t) => {
    const tokens = tokenize('ls -la');
    t.deepEqual(tokens, ['ls', '-la']);
});

test('tokenize › should handle double quotes', (t) => {
    const tokens = tokenize('echo "hello world"');
    t.deepEqual(tokens, ['echo', 'hello world']);
});

test('tokenize › should handle single quotes', (t) => {
    const tokens = tokenize("echo 'hello world'");
    t.deepEqual(tokens, ['echo', 'hello world']);
});

test('tokenize › should handle mixed quotes', (t) => {
    const tokens = tokenize('cp "my file.txt" \'another file.pdf\'');
    t.deepEqual(tokens, ['cp', 'my file.txt', 'another file.pdf']);
});

test('tokenize › should handle empty input', (t) => {
    const tokens = tokenize('');
    t.deepEqual(tokens, []);
});

test('tokenize › should handle multiple spaces', (t) => {
    const tokens = tokenize('ls   -la    /workspace');
    t.deepEqual(tokens, ['ls', '-la', '/workspace']);
});

// ============================================================================
// Path normalization tests
// ============================================================================

test('toAbsWorkspacePath › should preserve absolute paths', (t) => {
    t.is(toAbsWorkspacePath('/workspace/foo.txt'), '/workspace/foo.txt');
    t.is(toAbsWorkspacePath('/tmp/file.txt'), '/tmp/file.txt');
});

test('toAbsWorkspacePath › should normalize relative paths', (t) => {
    t.is(toAbsWorkspacePath('foo.txt'), '/workspace/foo.txt');
    t.is(toAbsWorkspacePath('subdir/bar.txt'), '/workspace/subdir/bar.txt');
});

test('resetDestroyTimeoutMs › should use a 15 minute minimum for reprovision', (t) => {
    t.is(resetDestroyTimeoutMs(undefined), 900000);
    t.is(resetDestroyTimeoutMs(60), 900000);
    t.is(resetDestroyTimeoutMs(1200), 1200000);
});
