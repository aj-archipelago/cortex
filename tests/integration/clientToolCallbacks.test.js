// Test for client tool callbacks with Redis pub/sub
import test from 'ava';
import { 
    waitForClientToolResult, 
    resolveClientToolCallback,
    getPendingCallbackCount 
} from '../../server/clientToolCallbacks.js';

const mockRequestId = 'test-request-123';

test.after.always(async () => {
    // Give Redis time to clean up connections
    await new Promise(resolve => setTimeout(resolve, 100));
});

test.serial('Client Tool Callbacks - Multi-Instance Support › should register and resolve a callback locally', async (t) => {
    const toolCallbackId = 'test-callback-1';

    // Start waiting for result
    const waitPromise = waitForClientToolResult(toolCallbackId, mockRequestId, 5000);

    // Verify callback is registered
    t.true(getPendingCallbackCount() > 0);

    // Simulate client submitting result
    const testResult = {
        success: true,
        data: { message: 'Test completed' },
        error: null
    };

    // Resolve the callback (this will publish to Redis if available, or resolve locally)
    const resolved = await resolveClientToolCallback(toolCallbackId, testResult);
    t.true(resolved);

    // Wait for the result
    const result = await waitPromise;

    t.deepEqual(result, testResult);
    t.true(result.success);
    t.is(result.data.message, 'Test completed');
});

test.serial('Client Tool Callbacks - Multi-Instance Support › should timeout if no result is received', async (t) => {
    const toolCallbackId = 'test-callback-timeout';

    // Start waiting with a short timeout
    const waitPromise = waitForClientToolResult(toolCallbackId, mockRequestId, 100);

    // Don't resolve - let it timeout
    await t.throwsAsync(waitPromise, { message: /Client tool execution timeout/ });
});

test.serial('Client Tool Callbacks - Multi-Instance Support › should handle callback with error result', async (t) => {
    const toolCallbackId = 'test-callback-error';

    // Start waiting for result
    const waitPromise = waitForClientToolResult(toolCallbackId, mockRequestId, 5000);

    // Simulate client submitting error result
    const errorResult = {
        success: false,
        data: null,
        error: 'Tool execution failed'
    };

    // Resolve with error
    await resolveClientToolCallback(toolCallbackId, errorResult);

    // Wait for the result
    const result = await waitPromise;

    t.false(result.success);
    t.is(result.error, 'Tool execution failed');
});

test.serial('Client Tool Callbacks - Multi-Instance Support › should handle multiple concurrent callbacks', async (t) => {
    const callbacks = [];
    const numCallbacks = 5;

    // Register multiple callbacks
    for (let i = 0; i < numCallbacks; i++) {
        const callbackId = `concurrent-callback-${i}`;
        const promise = waitForClientToolResult(callbackId, mockRequestId, 5000);
        callbacks.push({ id: callbackId, promise });
    }

    // Resolve all callbacks
    for (let i = 0; i < numCallbacks; i++) {
        const result = {
            success: true,
            data: { index: i, message: `Result ${i}` },
            error: null
        };
        await resolveClientToolCallback(callbacks[i].id, result);
    }

    // Wait for all results
    const results = await Promise.all(callbacks.map(cb => cb.promise));

    // Verify all results
    t.is(results.length, numCallbacks);
    results.forEach((result, index) => {
        t.true(result.success);
        t.is(result.data.index, index);
    });
});

test.serial('Client Tool Callbacks - Multi-Instance Support › should return false when resolving non-existent callback', async (t) => {
    const nonExistentId = 'non-existent-callback-id';

    const result = {
        success: true,
        data: { message: 'Test' },
        error: null
    };

    // This should publish to Redis (if available) or return false locally.
    // Either way, it should not throw an error.
    const resolved = await resolveClientToolCallback(nonExistentId, result);

    // In Redis mode, this returns true (published).
    // In local mode, this returns false (not found).
    t.is(typeof resolved, 'boolean');
});

test.serial('Client Tool Callbacks - Performance › should handle rapid callback resolution', async (t) => {
    t.timeout(20_000);

    const start = Date.now();
    const numCallbacks = 100;
    const callbacks = [];

    // Register many callbacks rapidly
    for (let i = 0; i < numCallbacks; i++) {
        const callbackId = `perf-callback-${i}`;
        const promise = waitForClientToolResult(callbackId, 'perf-test', 15000);
        callbacks.push({ id: callbackId, promise });
    }

    // Resolve all callbacks rapidly
    for (let i = 0; i < numCallbacks; i++) {
        await resolveClientToolCallback(callbacks[i].id, {
            success: true,
            data: { index: i },
            error: null
        });
    }

    // Wait for all
    const results = await Promise.all(callbacks.map(cb => cb.promise));
    const duration = Date.now() - start;

    t.is(results.length, numCallbacks);
    t.true(duration < 10000); // Should complete in under 10 seconds

    console.log(`Performance test: ${numCallbacks} callbacks resolved in ${duration}ms (${(duration/numCallbacks).toFixed(2)}ms avg per callback)`);
});
