// pendingUserMessages.test.js
// Tests for the pending user message queue used by agent message injection.
// Uses queueLocalMessage (bypasses Redis pub/sub) for deterministic unit tests.

import test from 'ava';
import { queueLocalMessage, drainPendingMessages, hasPendingMessages, clearPendingMessages } from '../../../server/pendingUserMessages.js';

// Clean up between tests to avoid cross-contamination
test.beforeEach(() => {
    clearPendingMessages('test-req-1');
    clearPendingMessages('test-req-2');
    clearPendingMessages('test-req-3');
});

test.serial('queueLocalMessage adds a message to the queue', t => {
    const result = queueLocalMessage('test-req-1', 'hello');
    t.true(result);
    t.true(hasPendingMessages('test-req-1'));
});

test.serial('queueLocalMessage returns false for empty requestId', t => {
    t.false(queueLocalMessage('', 'hello'));
    t.false(queueLocalMessage(null, 'hello'));
    t.false(queueLocalMessage(undefined, 'hello'));
});

test.serial('queueLocalMessage returns false for empty message', t => {
    t.false(queueLocalMessage('test-req-1', ''));
    t.false(queueLocalMessage('test-req-1', null));
    t.false(queueLocalMessage('test-req-1', undefined));
});

test.serial('drainPendingMessages returns and removes all messages', t => {
    queueLocalMessage('test-req-1', 'msg1');
    queueLocalMessage('test-req-1', 'msg2');
    queueLocalMessage('test-req-1', 'msg3');

    const messages = drainPendingMessages('test-req-1');
    t.is(messages.length, 3);
    t.is(messages[0].message, 'msg1');
    t.is(messages[1].message, 'msg2');
    t.is(messages[2].message, 'msg3');

    // Queue should be empty after drain
    t.false(hasPendingMessages('test-req-1'));
    t.deepEqual(drainPendingMessages('test-req-1'), []);
});

test.serial('drainPendingMessages returns empty array for unknown requestId', t => {
    const messages = drainPendingMessages('nonexistent');
    t.deepEqual(messages, []);
});

test.serial('drainPendingMessages returns empty array for null requestId', t => {
    t.deepEqual(drainPendingMessages(null), []);
    t.deepEqual(drainPendingMessages(undefined), []);
    t.deepEqual(drainPendingMessages(''), []);
});

test.serial('hasPendingMessages returns false for empty/unknown requestId', t => {
    t.false(hasPendingMessages(''));
    t.false(hasPendingMessages(null));
    t.false(hasPendingMessages(undefined));
    t.false(hasPendingMessages('nonexistent'));
});

test.serial('hasPendingMessages returns true only when messages exist', t => {
    t.false(hasPendingMessages('test-req-1'));
    queueLocalMessage('test-req-1', 'hello');
    t.true(hasPendingMessages('test-req-1'));
    drainPendingMessages('test-req-1');
    t.false(hasPendingMessages('test-req-1'));
});

test.serial('clearPendingMessages removes the queue', t => {
    queueLocalMessage('test-req-1', 'msg1');
    queueLocalMessage('test-req-1', 'msg2');
    t.true(hasPendingMessages('test-req-1'));

    clearPendingMessages('test-req-1');
    t.false(hasPendingMessages('test-req-1'));
    t.deepEqual(drainPendingMessages('test-req-1'), []);
});

test.serial('clearPendingMessages is safe to call on nonexistent requestId', t => {
    t.notThrows(() => clearPendingMessages('nonexistent'));
    t.notThrows(() => clearPendingMessages(null));
});

test.serial('queues are independent per requestId', t => {
    queueLocalMessage('test-req-1', 'for-req-1');
    queueLocalMessage('test-req-2', 'for-req-2');

    t.true(hasPendingMessages('test-req-1'));
    t.true(hasPendingMessages('test-req-2'));
    t.false(hasPendingMessages('test-req-3'));

    const msgs1 = drainPendingMessages('test-req-1');
    t.is(msgs1.length, 1);
    t.is(msgs1[0].message, 'for-req-1');

    // req-2 should still have its message
    t.true(hasPendingMessages('test-req-2'));
    const msgs2 = drainPendingMessages('test-req-2');
    t.is(msgs2.length, 1);
    t.is(msgs2[0].message, 'for-req-2');
});

test.serial('messages include timestamps', t => {
    const before = Date.now();
    queueLocalMessage('test-req-1', 'hello');
    const after = Date.now();

    const messages = drainPendingMessages('test-req-1');
    t.is(messages.length, 1);
    t.true(messages[0].timestamp >= before);
    t.true(messages[0].timestamp <= after);
});

test.serial('messages are returned in insertion order', t => {
    queueLocalMessage('test-req-1', 'first');
    queueLocalMessage('test-req-1', 'second');
    queueLocalMessage('test-req-1', 'third');

    const messages = drainPendingMessages('test-req-1');
    t.deepEqual(messages.map(m => m.message), ['first', 'second', 'third']);
});
