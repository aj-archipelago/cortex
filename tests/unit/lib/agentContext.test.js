import test from 'ava';
import {
    appendAgentContextFileAccessPlan,
    appendAgentContextInstructions,
    loadAgentContext,
    parseAgentContext,
} from '../../../lib/agentContext.js';

test('omitted agentContext performs no file lookup', async (t) => {
    let listed = false;
    const result = await loadAgentContext('', {
        listFiles: async () => {
            listed = true;
            return [];
        },
    });
    t.is(result, null);
    t.false(listed);
});

test('parses only the supported single-string context format', (t) => {
    t.deepEqual(parseAgentContext('applet-shared:507f191e810c19729de860ea'), {
        id: 'applet-shared:507f191e810c19729de860ea',
        contextId: '507f191e810c19729de860ea',
        root: 'applet-shared',
    });
    t.is(parseAgentContext('applet-shared:abc-123'), null);
    t.is(parseAgentContext('https://example.com/files'), null);
    t.is(parseAgentContext('applet-shared:../other'), null);
});

test('loads instructions and attaches one generic full-folder target', async (t) => {
    const result = await loadAgentContext('applet-shared:507f191e810c19729de860ea', {
        listFiles: async () => [
            {
                blobPath: 'AGENTS.md',
                url: 'https://files.test/agents',
            },
            {
                blobPath: 'skills/answer/SKILL.md',
                url: 'https://files.test/skill',
            },
            {
                blobPath: 'projects/acme/brief.md',
                url: 'https://files.test/brief',
            },
        ],
        fetchImpl: async (url) => ({
            ok: true,
            text: async () => url.endsWith('agents') ? 'Agent rules' : 'Answer skill',
        }),
    });

    const [{ files, ...target }] = result.fileAccessPlan;
    t.deepEqual(target, {
        kind: 'app-shared',
        appletId: '507f191e810c19729de860ea',
        write: false,
    });
    t.is(files.length, 3);
    t.true(result.hasAgentsMd);
    t.is(result.skillCount, 1);
    t.true(result.instructions.includes('Agent rules'));
    t.true(result.instructions.includes('Answer skill'));
    t.true(result.instructions.includes('projects/acme/brief.md'));
    const appended = appendAgentContextInstructions('Base', result);
    t.true(appended.includes('additional context'));
    t.true(appended.includes('Follow its AGENTS.md'));
    t.true(appended.includes('Use its skills when relevant'));
});

test('attaches a data-only context without inventing instruction files', async (t) => {
    const result = await loadAgentContext('applet-shared:507f191e810c19729de860ea', {
        listFiles: async () => [{
            blobPath: 'facts.md',
            url: 'https://files.test/facts',
        }],
    });

    t.false(result.hasAgentsMd);
    t.is(result.skillCount, 0);
    t.true(result.instructions.includes('facts.md'));
    const appended = appendAgentContextInstructions('Base', result);
    t.false(appended.includes('Follow its AGENTS.md'));
    t.false(appended.includes('Use its skills'));
    t.true(appended.includes('scoped fileRef'));
    t.true(appended.includes('Do not use WorkspaceSSH'));
});

test('loads skills without requiring AGENTS.md', async (t) => {
    const result = await loadAgentContext('applet-shared:507f191e810c19729de860ea', {
        listFiles: async () => [{
            blobPath: 'skills/answer/SKILL.md',
            url: 'https://files.test/skill',
        }],
        fetchImpl: async () => ({ ok: true, text: async () => 'Answer skill' }),
    });

    t.false(result.hasAgentsMd);
    t.is(result.skillCount, 1);
    const appended = appendAgentContextInstructions('Base', result);
    t.false(appended.includes('Follow its AGENTS.md'));
    t.true(appended.includes('Use its skills when relevant'));
});

test('recognizes root instructions by their preserved display filename', async (t) => {
    const result = await loadAgentContext('applet-shared:507f191e810c19729de860ea', {
        listFiles: async () => [{
            blobPath: 'mrx14bht-pgt.md',
            displayFilename: 'AGENTS.md',
            url: 'https://files.test/agents',
        }],
        fetchImpl: async () => ({ ok: true, text: async () => 'Live agent rules' }),
    });

    t.true(result.hasAgentsMd);
    t.true(result.instructions.includes('# AGENTS.md'));
    t.true(result.instructions.includes('Live agent rules'));
});

test('default entity context preserves common instructions and expertise', (t) => {
    const appended = appendAgentContextInstructions('', {
        id: 'applet-shared:507f191e810c19729de860ea',
    });

    t.true(appended.includes('{{renderTemplate AI_COMMON_INSTRUCTIONS}}'));
    t.true(appended.includes('{{renderTemplate AI_EXPERTISE}}'));
    t.true(appended.includes('additional context'));
});

test('fails when a discovered instruction file cannot be read', async (t) => {
    await t.throwsAsync(
        () => loadAgentContext('applet-shared:507f191e810c19729de860ea', {
            listFiles: async () => [{
                blobPath: 'AGENTS.md',
                url: 'https://files.test/agents',
            }],
            fetchImpl: async () => ({ ok: false, status: 503 }),
        }),
        { message: /Failed to read instruction file/ },
    );
});

test('truncates a large optional file index without rejecting the context', async (t) => {
    const longFiles = Array.from({ length: 1000 }, (_, index) => ({
        blobPath: `data/${String(index).padStart(4, '0')}-${'x'.repeat(240)}.md`,
    }));
    const result = await loadAgentContext('applet-shared:507f191e810c19729de860ea', {
        listFiles: async () => [{
            blobPath: 'AGENTS.md',
            url: 'https://files.test/agents',
        }, ...longFiles],
        fetchImpl: async () => ({
            ok: true,
            text: async () => 'Agent rules',
        }),
    });

    t.true(Buffer.byteLength(result.instructions, 'utf8') <= 200000);
    t.true(result.instructions.includes(longFiles[0].blobPath));
    t.false(result.instructions.includes(longFiles.at(-1).blobPath));
});

test('attaches context without replacing caller files', (t) => {
    const callerTarget = { kind: 'chat', contextId: 'chat-123' };
    const contextTarget = { kind: 'app-shared', appletId: '507f191e810c19729de860ea' };

    t.deepEqual(
        appendAgentContextFileAccessPlan(
            [callerTarget],
            { fileAccessPlan: [contextTarget] },
        ),
        [callerTarget, contextTarget],
    );
});

test('does not append a duplicate context target', (t) => {
    const target = { kind: 'app-shared', appletId: '507f191e810c19729de860ea', write: false };
    t.deepEqual(
        appendAgentContextFileAccessPlan(
            [target],
            { fileAccessPlan: [{ ...target }] },
        ),
        [target],
    );
});
