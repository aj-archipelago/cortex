import test from 'ava';
import { armRequestDeadline, clearRequestDeadline, cancelLocalRequest } from '../../../server/requestCancellation.js';

test('cancellation does not create forwarding-blocking placeholders on other instances', t => {
    const state = {};
    t.false(cancelLocalRequest('remote', state));
    t.deepEqual(state, {});
});
test('deadline aborts a registered request even if its client disappears', async t => {
    let aborted = false;
    const state = { request: { abortRequest() { aborted = true; } } };
    armRequestDeadline('request', Date.now() + 20, state);
    await new Promise(resolve => setTimeout(resolve, 40));
    t.true(aborted);
    t.true(state.request.canceled);
    clearRequestDeadline('request', state);
});
test('successful completion clears the deadline without canceling work', async t => {
    const state = { request: {} };
    armRequestDeadline('request', Date.now() + 20, state);
    clearRequestDeadline('request', state);
    await new Promise(resolve => setTimeout(resolve, 40));
    t.falsy(state.request.canceled);
    t.falsy(state.request.deadlineTimer);
});
test('expired and malformed deadlines fail before execution', t => {
    const state = {};
    for (const value of ['invalid', 0, Date.now() + 25 * 3600000, Date.now() - 1]) {
        t.throws(() => armRequestDeadline('request', value, state));
    }
    t.true(state.request.canceled);
});
