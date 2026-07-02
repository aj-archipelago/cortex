import test from 'ava';
import workspaceSSH, {
    resetDestroyTimeoutMs,
    shouldBlockExpensiveCloudFileScan,
    tokenize,
    toAbsWorkspacePath,
} from '../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js';

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

test('tool description › should point user-file discovery at FileCollection', (t) => {
    const description = workspaceSSH.toolDefinition.function.description;
    t.true(description.includes('FileCollection'));
    t.true(description.includes('operation "search"'));
    t.false(description.includes('cloud-files find-name'));
});

// ============================================================================
// Expensive cloud file scan guard
// ============================================================================

test('shouldBlockExpensiveCloudFileScan › should allow broad workspace scans that do not follow symlinks', (t) => {
    t.is(shouldBlockExpensiveCloudFileScan('find /workspace -name "*.py"'), null);
    t.is(shouldBlockExpensiveCloudFileScan('rg "needle" /workspace'), null);
    t.is(shouldBlockExpensiveCloudFileScan('grep -r "needle" .'), null);
    t.is(shouldBlockExpensiveCloudFileScan('ls -R /workspace'), null);
    t.is(shouldBlockExpensiveCloudFileScan('tree /workspace'), null);
});

test('shouldBlockExpensiveCloudFileScan › should block direct cloud file scans', (t) => {
    const blocked = shouldBlockExpensiveCloudFileScan('find /cloud-files -name "*.pdf"');
    t.true(blocked?.blocked);
    t.true(blocked.alternatives.some((alternative) => alternative.includes('FileCollection')));
    t.false(blocked.alternatives.some((alternative) => alternative.includes('cloud-files')));
    t.true(shouldBlockExpensiveCloudFileScan('rg "needle" /workspace/files')?.blocked);
    t.true(shouldBlockExpensiveCloudFileScan('grep -R "needle" files')?.blocked);
    t.true(shouldBlockExpensiveCloudFileScan('cd files && rg "needle" .')?.blocked);
});

test('shouldBlockExpensiveCloudFileScan › should block symlink-following workspace scans', (t) => {
    t.true(shouldBlockExpensiveCloudFileScan('find -L /workspace -name "*.py"')?.blocked);
    t.true(shouldBlockExpensiveCloudFileScan('rg --follow "needle" /workspace')?.blocked);
    t.true(shouldBlockExpensiveCloudFileScan('grep -R "needle" /workspace')?.blocked);
    t.true(shouldBlockExpensiveCloudFileScan('ls -RL /workspace')?.blocked);
    t.true(shouldBlockExpensiveCloudFileScan('tree -l /workspace')?.blocked);
});

test('shouldBlockExpensiveCloudFileScan › should allow targeted local paths and shallow listings', (t) => {
    t.is(shouldBlockExpensiveCloudFileScan('rg "needle" src'), null);
    t.is(shouldBlockExpensiveCloudFileScan('find -L src -name "*.js"'), null);
    t.is(shouldBlockExpensiveCloudFileScan('find /workspace -maxdepth 1 -type f'), null);
    t.is(shouldBlockExpensiveCloudFileScan('ls /workspace'), null);
    t.is(shouldBlockExpensiveCloudFileScan('cd src && rg "needle" .'), null);
});
