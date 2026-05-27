import test from 'ava';
import {
    buildToolResultContent,
    compactHistoricalToolResults,
} from '../../../pathways/system/entity/sys_entity_agent.js';

const messageFootprint = (messages) => messages.reduce((sum, msg) => {
    let total = sum + (msg.role?.length || 0) + (msg.name?.length || 0) + (msg.tool_call_id?.length || 0);
    if (typeof msg.content === 'string') {
        total += msg.content.length;
    } else if (msg.content != null) {
        total += JSON.stringify(msg.content).length;
    }
    if (msg.tool_calls) {
        total += JSON.stringify(msg.tool_calls).length;
    }
    return total;
}, 0);

test('buildToolResultContent keeps large workspace output detailed before context pressure', (t) => {
    const resolver = {};
    const workspacePayload = JSON.stringify({
        success: true,
        stdout: 'a'.repeat(6000),
        stderr: '',
        exitCode: 0,
        durationMs: 42,
    });

    const content = buildToolResultContent(workspacePayload, resolver, 'workspacessh');
    const parsed = JSON.parse(content);

    t.true(parsed._toolResultEnvelope);
    t.is(parsed.kind, 'workspace-shell');
    t.is(parsed.compacted, false);
    t.truthy(parsed.resultRef);
    t.falsy(parsed.stdoutArtifactRef);
    t.is(parsed.stdoutPreview.length, 6000);
    const snapshot = JSON.parse(resolver._toolResultSnapshots.get(parsed.resultRef).content);
    t.is(snapshot.compacted, false);
    t.is(snapshot.stdoutPreview.length, 6000);
});

test('buildToolResultContent artifacts near-limit workspace output before hard truncation', (t) => {
    const resolver = {};
    const workspacePayload = JSON.stringify({
        success: true,
        stdout: 'a'.repeat(49000),
        stderr: '',
        exitCode: 0,
    });

    const content = buildToolResultContent(workspacePayload, resolver, 'workspacessh');
    const parsed = JSON.parse(content);

    t.true(parsed._toolResultEnvelope);
    t.true(parsed.compacted);
    t.true(content.length < 50000);
    t.truthy(parsed.stdoutArtifactRef);
    t.is(resolver._toolResultArtifacts.get(parsed.stdoutArtifactRef).content.length, 49000);
    const snapshot = JSON.parse(resolver._toolResultSnapshots.get(parsed.resultRef).content);
    t.is(snapshot.stdoutPreview.length, 49000);
});

test('buildToolResultContent artifacts escaped workspace output before serialized envelope truncation', (t) => {
    const resolver = {};
    const escapedHeavyOutput = '\n'.repeat(30000);
    const workspacePayload = JSON.stringify({
        success: true,
        stdout: escapedHeavyOutput,
        stderr: '',
        exitCode: 0,
    });

    const content = buildToolResultContent(workspacePayload, resolver, 'workspacessh');
    const parsed = JSON.parse(content);

    t.true(parsed._toolResultEnvelope);
    t.true(parsed.compacted);
    t.true(content.length < 50000);
    t.truthy(parsed.stdoutArtifactRef);
    t.true(parsed.stdoutPreview.length < escapedHeavyOutput.length);
    t.is(resolver._toolResultArtifacts.get(parsed.stdoutArtifactRef).content.length, escapedHeavyOutput.length);
    const snapshot = JSON.parse(resolver._toolResultSnapshots.get(parsed.resultRef).content);
    t.is(snapshot.stdoutPreview.length, escapedHeavyOutput.length);
});

test('buildToolResultContent leaves output uncompacted when allowResultCompaction is false', (t) => {
    const resolver = {};
    const toolContent = `# Tool Output\n\n${'Detailed instructions.\n'.repeat(300)}`;

    const content = buildToolResultContent(toolContent, resolver, 'customtool', {
        allowResultCompaction: false,
    });

    t.is(content, toolContent);
    t.is(resolver._toolResultArtifacts, undefined);
    t.is(resolver._toolResultSnapshots, undefined);
});

test('compactHistoricalToolResults waits until estimated context pressure', (t) => {
    const makeEnvelope = ({ resultRef }) => JSON.stringify({
        _toolResultEnvelope: true,
        resultRef,
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: 'success',
        stdoutPreview: 'x'.repeat(1200),
    });

    const messages = [
        { role: 'tool', content: makeEnvelope({ resultRef: 'tr_1' }) },
        { role: 'tool', content: makeEnvelope({ resultRef: 'tr_2' }) },
    ];

    const compacted = compactHistoricalToolResults(messages, {}, {
        maxPromptTokens: 1000000,
    });

    t.is(compacted[0], messages[0]);
    t.is(compacted[1], messages[1]);
});

test('compactHistoricalToolResults estimates dense non-ASCII text conservatively', (t) => {
    const arabicOutput = 'مرحبا بالعالم '.repeat(100);
    const makeEnvelope = (resultRef) => JSON.stringify({
        _toolResultEnvelope: true,
        resultRef,
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: 'arabic output',
        stdoutPreview: arabicOutput,
    });

    const messages = Array.from({ length: 9 }, (_, index) => ({
        role: 'tool',
        content: makeEnvelope(`tr_${index}`),
    }));

    const compacted = compactHistoricalToolResults(messages, {}, { maxPromptTokens: 14000 });

    t.true(JSON.parse(compacted[0].content).compacted);
    t.is(JSON.parse(compacted[8].content).compacted, false);
});

test('compactHistoricalToolResults uses actual prior prompt usage as the estimate anchor', (t) => {
    const makeEnvelope = (resultRef) => JSON.stringify({
        _toolResultEnvelope: true,
        resultRef,
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: resultRef,
        stdoutPreview: 'x'.repeat(700),
    });
    const messages = Array.from({ length: 10 }, (_, index) => ({
        role: 'tool',
        content: makeEnvelope(`tr_${index}`),
    }));
    const resolver = {
        _toolResultPromptTokenAnchor: {
            inputTokens: 10000,
            messageCount: 9,
            messageFootprint: messageFootprint(messages.slice(0, 9)),
            toolSchemaSignature: 'none',
            modelName: null,
        },
    };

    const compacted = compactHistoricalToolResults(messages, resolver, { maxPromptTokens: 14000 });

    t.true(JSON.parse(compacted[0].content).compacted);
    t.true(JSON.parse(compacted[1].content).compacted);
    t.false(JSON.parse(compacted[2].content).compacted);
});

test('compactHistoricalToolResults invalidates prompt usage anchor when prompt inputs grow', (t) => {
    const makeEnvelope = (resultRef) => JSON.stringify({
        _toolResultEnvelope: true,
        resultRef,
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: resultRef,
        stdoutPreview: 'x'.repeat(700),
    });
    const messages = Array.from({ length: 10 }, (_, index) => ({
        role: 'tool',
        content: makeEnvelope(`tr_${index}`),
    }));
    const resolver = {
        _toolResultPromptTokenAnchor: {
            inputTokens: 100,
            messageCount: messages.length,
            messageFootprint: messageFootprint(messages),
            toolSchemaSignature: 'none',
            modelName: null,
        },
    };

    const compacted = compactHistoricalToolResults(messages, resolver, {
        maxPromptTokens: 2000,
        entityInstructions: 'extra prompt context\n'.repeat(5000),
    });

    t.true(JSON.parse(compacted[0].content).compacted);
});

test('compactHistoricalToolResults compacts older results under context pressure and leaves the newest working set intact', (t) => {
    const resolver = {};
    const makeEnvelope = ({ summary, resultRef, success = true, artifactRef = null, previewText = 'x'.repeat(900) }) => JSON.stringify({
        _toolResultEnvelope: true,
        resultRef,
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success,
        exitCode: success ? 0 : 1,
        summary,
        command: `sed -n '1,20p' /workspace/files/${resultRef}.js`,
        paths: [`/workspace/files/${resultRef}.js`],
        stdoutPreview: previewText,
        ...(artifactRef ? { stdoutArtifactRef: artifactRef, stdoutTotalChars: previewText.length + 100 } : {}),
    });

    const compacted = compactHistoricalToolResults([
        { role: 'tool', content: makeEnvelope({ summary: 'success-0', resultRef: 'tr_0' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'failure-1', resultRef: 'tr_1', success: false }) },
        { role: 'tool', content: makeEnvelope({ summary: 'success-2', resultRef: 'tr_2', artifactRef: 'tra_2' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'success-3', resultRef: 'tr_3', artifactRef: 'tra_3' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'success-4', resultRef: 'tr_4', artifactRef: 'tra_4' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'failure-5', resultRef: 'tr_5', success: false }) },
        { role: 'tool', content: makeEnvelope({ summary: 'recent-6', resultRef: 'tr_6', artifactRef: 'tra_6' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'recent-7', resultRef: 'tr_7', artifactRef: 'tra_7' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'recent-8', resultRef: 'tr_8', artifactRef: 'tra_8' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'recent-9', resultRef: 'tr_9', artifactRef: 'tra_9' }) },
        { role: 'tool', content: makeEnvelope({ summary: 'recent-10', resultRef: 'tr_10', artifactRef: 'tra_10' }) },
    ], resolver, { maxPromptTokens: 1000 });

    // Older non-failure results outside the pressure working set are compacted.
    for (const i of [0, 2]) {
        const parsed = JSON.parse(compacted[i].content);
        t.is(parsed.compacted, true);
        t.is(parsed.stdoutPreview, undefined);
        t.true(parsed.artifactRefs.length >= 1);
        t.is(typeof parsed.stdoutTotalChars, 'number');
        t.true(parsed.command.includes('/workspace/files/'));
        t.true(parsed.preview.length > 0);
        t.is(parsed.note, undefined);
    }

    // Last two failures stay full (tr_1 is older but still kept as a recent failure)
    t.is(compacted[1].content, makeEnvelope({ summary: 'failure-1', resultRef: 'tr_1', success: false }));
    t.is(compacted[5].content, makeEnvelope({ summary: 'failure-5', resultRef: 'tr_5', success: false }));

    // Newest tool results stay full while under pressure.
    t.is(compacted[3].content, makeEnvelope({ summary: 'success-3', resultRef: 'tr_3', artifactRef: 'tra_3' }));
    t.is(compacted[6].content, makeEnvelope({ summary: 'recent-6', resultRef: 'tr_6', artifactRef: 'tra_6' }));
    t.is(compacted[9].content, makeEnvelope({ summary: 'recent-9', resultRef: 'tr_9', artifactRef: 'tra_9' }));
    t.true(resolver._toolResultArtifacts instanceof Map);
    t.truthy(resolver._toolResultCompactionState);
});

test('compactHistoricalToolResults skips messages below the minimum compact size', (t) => {
    const tinyEnvelope = JSON.stringify({
        _toolResultEnvelope: true,
        resultRef: 'tr_tiny',
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: 'tiny',
    });
    t.true(tinyEnvelope.length < 600);

    const compacted = compactHistoricalToolResults([
        { role: 'tool', content: tinyEnvelope },
        { role: 'tool', content: tinyEnvelope },
        { role: 'tool', content: tinyEnvelope },
        { role: 'tool', content: tinyEnvelope },
    ], {}, { maxPromptTokens: 1000 });

    for (const msg of compacted) {
        t.is(msg.content, tinyEnvelope);
    }
});

test('compactHistoricalToolResults keeps compaction sticky until history grows materially', (t) => {
    const resolver = {};
    const makeEnvelope = (resultRef) => JSON.stringify({
        _toolResultEnvelope: true,
        resultRef,
        tool: 'workspacessh',
        kind: 'workspace-shell',
        compacted: false,
        success: true,
        summary: resultRef,
        stdoutPreview: 'x'.repeat(1600),
    });

    const messages = Array.from({ length: 12 }, (_, index) => ({
        role: 'tool',
        content: makeEnvelope(`tr_${index}`),
    }));

    const first = compactHistoricalToolResults(messages, resolver, { maxPromptTokens: 1000 });
    t.true(JSON.parse(first[0].content).compacted);

    const second = compactHistoricalToolResults([
        ...first,
        { role: 'tool', content: makeEnvelope('tr_new') },
    ], resolver, { maxPromptTokens: 1000 });

    t.is(second[4].content, first[4].content);
    t.is(JSON.parse(second[4].content).compacted, false);
});
