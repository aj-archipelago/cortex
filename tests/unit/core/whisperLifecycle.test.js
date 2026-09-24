import test from 'ava';
import { cleanupDeadline, settleBatch, waitForCleanup } from '../../../lib/whisperLifecycle.js';

test('a failed chunk waits for its sibling before cleanup may start', async t => {
    let finish;
    const sibling = new Promise(resolve => { finish = resolve; });
    let cleaned = false;
    const outcome = settleBatch(['bad', 'slow'], uri => uri === 'bad' ? Promise.reject(new Error('source failed')) : sibling)
        .catch(error => error.message).finally(() => { cleaned = true; });
    await new Promise(resolve => setImmediate(resolve));
    t.false(cleaned);
    finish('transcript');
    t.is(await outcome, 'source failed');
    t.true(cleaned);
});

test('successful batches preserve subtitle chunk ordering', async t => {
    t.deepEqual(await settleBatch(['first', 'second'], async uri => uri), ['first', 'second']);
});

test('lost acknowledgements retain input for the hard deadline and reaping grace', async t => {
    const deadline = cleanupDeadline(240, { status: 502 });
    t.is(deadline, 250000);
    let waited;
    await waitForCleanup(deadline, () => 10000, async ms => { waited = ms; });
    t.is(waited, 240000);
});

test('busy and acknowledged failures need no extra input retention', t => {
    t.is(cleanupDeadline(240, { status: 429 }), 0);
    t.is(cleanupDeadline(240, { status: 504, headers: { 'x-whisper-job-settled': 'true' } }), 0);
});
