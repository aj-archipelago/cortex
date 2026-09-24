import test from 'ava';
import { assertCheckpointSizeSafe, publishWorkspaceCheckpoint, workspaceCheckpointReviewInstructions } from '../../../pathways/system/entity/tools/shared/workspace_checkpoint_safety.js';
import { encodeCheckpointInventory } from '../../../helper-apps/cortex-workspace/lib/checkpoint_inventory.js';

const currentPath = 'workspace-checkpoints/entity/workspace.tar.gz';
const previousPath = 'workspace-checkpoints/entity/workspace.prev.tar.gz';
const archive = (bytes, etag, owner = 'entity') => ({ contentLength: bytes, etag, metadata: { owner } });

function fixture({ current = archive(1000000, 'good'), previous = archive(900000, 'previous'), bytes = 800000, uploadError, afterUpload, candidateOwner = 'entity', candidateInventory, reportedBytes = bytes } = {}) {
    const blobs = new Map();
    if (current) blobs.set(currentPath, current);
    if (previous) blobs.set(previousPath, previous);
    const snapshots = [], uploads = [], copies = [];
    const condition = (value, options = {}) => {
        if ((options.ifMatch && value?.etag !== options.ifMatch) || (options.ifNoneMatch === '*' && value)) {
            throw Object.assign(new Error('condition failed'), { statusCode: 412 });
        }
    };
    const container = { getBlockBlobClient: path => ({
        getProperties: async () => {
            if (!blobs.has(path)) throw Object.assign(new Error('missing'), { statusCode: 404 });
            return structuredClone(blobs.get(path));
        },
        createSnapshot: async options => {
            condition(blobs.get(path), options.conditions);
            snapshots.push(structuredClone(blobs.get(path)));
            return { snapshot: String(snapshots.length) };
        },
        syncUploadFromURL: async (url, options) => {
            const sourcePath = new URL(url).pathname.slice(1);
            const source = blobs.get(sourcePath);
            condition(blobs.get(path), options.conditions);
            condition(source, options.sourceConditions);
            copies.push({ sourcePath, destination: path });
            const next = { ...structuredClone(source), metadata: options.metadata, etag: `copy-${copies.length}` };
            blobs.set(path, next);
            return { etag: next.etag };
        },
        deleteIfExists: async () => ({ succeeded: blobs.delete(path) }),
    }) };
    const run = (options = {}) => publishWorkspaceCheckpoint({ currentPath, previousPath, container,
        readUrl: async path => `https://storage.test/${path}`,
        validateMetadata: metadata => { if (metadata.owner !== 'entity') throw new Error('wrong owner'); },
        upload: async path => {
            uploads.push(path);
            blobs.set(path, archive(bytes, 'candidate', candidateOwner));
            if (candidateInventory) blobs.get(path).metadata.checkpointInventory = encodeCheckpointInventory(candidateInventory);
            if (afterUpload) await afterUpload(blobs);
            if (uploadError) throw new Error(uploadError);
            return { sizeBytes: reportedBytes, timestamp: 'checkpoint-time' };
        },
        ...options,
    });
    return { run, blobs, snapshots, uploads, copies, original: structuredClone(current), prior: structuredClone(previous) };
}

test('an empty restarted runtime cannot overwrite a large current or previous backup', async t => {
    const f = fixture({ bytes: 89 });
    await t.throwsAsync(f.run, { message: /unexpectedly shrank/ });
    t.deepEqual(f.blobs.get(currentPath), f.original);
    t.deepEqual(f.blobs.get(previousPath), f.prior);
    t.is(f.snapshots.length, 0);
    t.is(f.copies.length, 0);
    t.true(f.blobs.has(f.uploads[0]), 'rejected candidate retained for investigation');
});

const inventory = (fileCount, fileBytes) => ({ version: 1, fileCount, fileBytes, entryCount: fileCount,
    topLevelPaths: ['project'], structureHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64) });
const inventoried = (bytes, etag, value) => ({ ...archive(bytes, etag), metadata: { owner: 'entity', checkpointInventory: encodeCheckpointInventory(value) } });

test('a drastic file reduction asks the owning agent even when compressed size stays large', async t => {
    const f = fixture({ current: inventoried(1000000, 'good', inventory(100, 1000000)), candidateInventory: inventory(20, 900000) });
    let review;
    const result = await f.run({ onReduction: value => { review = value; } });
    t.is(result.pendingReview.id, review.id);
    t.is(review.status, 'pending');
    t.deepEqual(f.blobs.get(currentPath), f.original);
    t.deepEqual(f.blobs.get(previousPath), f.prior);
    t.is(f.copies.length, 0);
    t.true(f.blobs.has(review.candidatePath));
    t.regex(workspaceCheckpointReviewInstructions({ workspace: { checkpointReview: review } }), /owning agent/);
    t.is(workspaceCheckpointReviewInstructions({ kind: 'colleague', workspace: { checkpointReview: review } }), '');
});

test('explicit approval publishes the exact empty candidate and accepts the smaller baseline', async t => {
    const f = fixture({ current: inventoried(1000000, 'good', inventory(100, 1000000)), candidateInventory: inventory(0, 0), bytes: 89 });
    let review;
    await f.run({ onReduction: value => { review = value; } });
    const accepted = await f.run({ approvedReview: review });
    t.is(accepted.sizeBytes, 89);
    t.is(f.uploads.length, 1, 'approval reuses the inspected candidate');
    t.deepEqual(f.blobs.get(previousPath).metadata, f.original.metadata);
    const next = await f.run();
    t.is(next.sizeBytes, 89, 'the old large recovery copy is not a permanent size floor');
});

for (const target of ['candidate', 'current', 'previous']) {
    test(`approval cannot publish after the ${target} changes`, async t => {
        const f = fixture({ current: inventoried(1000000, 'good', inventory(100, 1000000)), candidateInventory: inventory(0, 0), bytes: 89 });
        let review;
        await f.run({ onReduction: value => { review = value; } });
        const targetPath = target === 'candidate' ? review.candidatePath : target === 'current' ? currentPath : previousPath;
        f.blobs.get(targetPath).etag = 'changed';
        await t.throwsAsync(f.run({ approvedReview: review }), { message: /changed since review/ });
        t.is(f.copies.length, 0);
    });
}

test('an inventory cannot silently disappear from a newer checkpoint', async t => {
    const f = fixture({ current: inventoried(1000000, 'good', inventory(100, 1000000)) });
    await t.throwsAsync(f.run(), { message: /lost its inventory/ });
    t.is(f.copies.length, 0);
});

test('a good previous backup remains protected when current was already emptied', async t => {
    const f = fixture({ current: archive(89, 'empty'), bytes: 9000 });
    await t.throwsAsync(f.run, { message: /unexpectedly shrank/ });
    t.deepEqual(f.blobs.get(previousPath), f.prior);
    t.is(f.copies.length, 0);
});

test('successful publication validates a separate candidate and preserves independent history', async t => {
    const f = fixture();
    const result = await f.run();
    t.regex(f.uploads[0], /\/candidates\/[a-f0-9-]+\.tar\.gz$/);
    t.not(f.uploads[0], currentPath);
    t.deepEqual(f.snapshots, [f.original]);
    t.is(f.blobs.get(previousPath).contentLength, f.original.contentLength);
    t.is(f.blobs.get(currentPath).contentLength, 800000);
    t.is(result.blobPath, currentPath);
    t.is(result.etag, f.blobs.get(currentPath).etag);
    t.false(f.blobs.has(f.uploads[0]));
});

for (const [label, options, message] of [
    ['interrupted upload', { uploadError: 'connection lost' }, /connection lost/],
    ['wrong candidate ownership', { candidateOwner: 'someone-else' }, /wrong owner/],
    ['misreported upload size', { reportedBytes: 5 }, /size does not match/],
]) {
    test(`${label} leaves both saved backups unchanged`, async t => {
        const f = fixture(options);
        await t.throwsAsync(f.run, { message });
        t.deepEqual(f.blobs.get(currentPath), f.original);
        t.deepEqual(f.blobs.get(previousPath), f.prior);
        t.is(f.copies.length, 0);
    });
}

test('a concurrent publisher cannot be overwritten using a stale baseline', async t => {
    const winner = archive(950000, 'concurrent-winner');
    const f = fixture({ afterUpload: blobs => blobs.set(currentPath, winner) });
    await t.throwsAsync(f.run, { message: /condition failed/ });
    t.deepEqual(f.blobs.get(currentPath), winner);
    t.deepEqual(f.blobs.get(previousPath), f.prior);
    t.is(f.copies.length, 0);
});

test('concurrent first publication uses create-only conditions', async t => {
    const winner = archive(1234, 'concurrent-winner');
    const f = fixture({ current: null, previous: null, afterUpload: blobs => blobs.set(currentPath, winner) });
    await t.throwsAsync(f.run, { message: /condition failed/ });
    t.deepEqual(f.blobs.get(currentPath), winner);
});

test('a genuinely new empty workspace can save its first checkpoint', async t => {
    const f = fixture({ current: null, previous: null, bytes: 89 });
    const result = await f.run();
    t.is(result.sizeBytes, 89);
    t.is(result.previousBlobPath, null);
    t.is(f.snapshots.length, 0);
});

test('small workspaces also reject a reset to an empty archive', t => {
    t.throws(() => assertCheckpointSizeSafe(8000, 89), { message: /unexpectedly shrank/ });
    t.notThrows(() => assertCheckpointSizeSafe(100000, 50000));
    t.throws(() => assertCheckpointSizeSafe(100000, 0), { message: /verified archive size/ });
});
