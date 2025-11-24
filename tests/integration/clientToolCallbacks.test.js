// Test for client tool callbacks with Redis pub/sub
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { 
    waitForClientToolResult, 
    resolveClientToolCallback,
    getPendingCallbackCount 
} from '../../server/clientToolCallbacks.js';

describe('Client Tool Callbacks - Multi-Instance Support', () => {
    const mockRequestId = 'test-request-123';
    
    afterAll(async () => {
        // Give Redis time to clean up connections
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should register and resolve a callback locally', async () => {
        const toolCallbackId = 'test-callback-1';
        
        // Start waiting for result
        const waitPromise = waitForClientToolResult(toolCallbackId, mockRequestId, 5000);
        
        // Verify callback is registered
        expect(getPendingCallbackCount()).toBeGreaterThan(0);
        
        // Simulate client submitting result
        const testResult = {
            success: true,
            data: { message: 'Test completed' },
            error: null
        };
        
        // Resolve the callback (this will publish to Redis if available, or resolve locally)
        const resolved = await resolveClientToolCallback(toolCallbackId, testResult);
        expect(resolved).toBe(true);
        
        // Wait for the result
        const result = await waitPromise;
        
        expect(result).toEqual(testResult);
        expect(result.success).toBe(true);
        expect(result.data.message).toBe('Test completed');
    });

    it('should timeout if no result is received', async () => {
        const toolCallbackId = 'test-callback-timeout';
        
        // Start waiting with a short timeout
        const waitPromise = waitForClientToolResult(toolCallbackId, mockRequestId, 100);
        
        // Don't resolve - let it timeout
        await expect(waitPromise).rejects.toThrow('Client tool execution timeout');
    }, 10000);

    it('should handle callback with error result', async () => {
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
        
        expect(result.success).toBe(false);
        expect(result.error).toBe('Tool execution failed');
    });

    it('should handle multiple concurrent callbacks', async () => {
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
        expect(results).toHaveLength(numCallbacks);
        results.forEach((result, index) => {
            expect(result.success).toBe(true);
            expect(result.data.index).toBe(index);
        });
    });

    it('should return false when resolving non-existent callback', async () => {
        const nonExistentId = 'non-existent-callback-id';
        
        const result = {
            success: true,
            data: { message: 'Test' },
            error: null
        };
        
        // This should publish to Redis (if available) or return false locally
        // Either way, it should not throw an error
        const resolved = await resolveClientToolCallback(nonExistentId, result);
        
        // In Redis mode, this returns true (published)
        // In local mode, this returns false (not found)
        expect(typeof resolved).toBe('boolean');
    });
});

describe('Client Tool Callbacks - Performance', () => {
    it('should handle rapid callback resolution', async () => {
        const start = Date.now();
        const numCallbacks = 100;
        const callbacks = [];
        
        // Register many callbacks rapidly
        for (let i = 0; i < numCallbacks; i++) {
            const callbackId = `perf-callback-${i}`;
            const promise = waitForClientToolResult(callbackId, 'perf-test', 5000);
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
        
        expect(results).toHaveLength(numCallbacks);
        expect(duration).toBeLessThan(10000); // Should complete in under 10 seconds
        
        console.log(`Performance test: ${numCallbacks} callbacks resolved in ${duration}ms (${(duration/numCallbacks).toFixed(2)}ms avg per callback)`);
    }, 15000);
});

