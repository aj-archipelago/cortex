// writefile.test.js
// Integration tests for WriteFile tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';

let testServer;

test.before(async () => {
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;
});

test.after.always('cleanup', async () => {
    if (testServer) {
        await testServer.stop();
    }
});

// Helper to create a test context
const createTestContext = () => {
    const contextId = `test-writefile-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return contextId;
};

// Helper to extract files array from stored format (handles both old array format and new {version, files} format)
const extractFilesFromStored = (stored) => {
    if (!stored) return [];
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    // Handle new format: { version, files }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.files) {
        return Array.isArray(parsed.files) ? parsed.files : [];
    }
    // Handle old format: just an array
    if (Array.isArray(parsed)) {
        return parsed;
    }
    return [];
};

// Helper to clean up test data
const cleanup = async (contextId, contextKey = null) => {
    try {
        const { keyValueStorageClient } = await import('../../../../lib/keyValueStorageClient.js');
        // Delete the key entirely instead of setting to empty array
        await keyValueStorageClient.delete(`${contextId}-memoryFiles`);
    } catch (e) {
        // Ignore cleanup errors
    }
};

test('WriteFile: Write and upload text file', async t => {
    const contextId = createTestContext();
    
    try {
        const content = 'Hello, world!\nThis is a test file.';
        const filename = 'test.txt';
        
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename,
            userMessage: 'Writing test file'
        });
        
        const parsed = JSON.parse(result);
        
        // Skip test if file handler is not configured
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed.success, true);
        t.is(parsed.filename, filename);
        t.truthy(parsed.url);
        t.is(parsed.size, Buffer.byteLength(content, 'utf8'));
        t.true(parsed.message.includes('written and uploaded successfully'));
        
        // Verify it was added to file collection
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        t.is(collection.length, 1);
        t.is(collection[0].filename, filename);
        t.is(collection[0].url, parsed.url);
        t.truthy(collection[0].hash);
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Write JSON file with tags and notes', async t => {
    const contextId = createTestContext();
    
    try {
        const content = JSON.stringify({ name: 'Test', value: 42 }, null, 2);
        const filename = 'data.json';
        const tags = ['data', 'test'];
        const notes = 'Test JSON file';
        
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename,
            tags,
            notes,
            userMessage: 'Writing JSON file'
        });
        
        const parsed = JSON.parse(result);
        
        // Skip test if file handler is not configured
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed.success, true);
        t.is(parsed.filename, filename);
        t.truthy(parsed.url);
        t.truthy(parsed.hash);
        t.is(parsed.size, Buffer.byteLength(content, 'utf8'));
        
        // Verify it was added to file collection with metadata
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        t.is(collection.length, 1);
        t.is(collection[0].filename, filename);
        t.deepEqual(collection[0].tags, tags);
        t.is(collection[0].notes, notes);
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Write file without contextId (no collection)', async t => {
    try {
        const content = 'Standalone file content';
        const filename = 'standalone.txt';
        
        const result = await callPathway('sys_tool_writefile', {
            content,
            filename,
            userMessage: 'Writing standalone file'
        });
        
        const parsed = JSON.parse(result);
        // This test may fail if WHISPER_MEDIA_API_URL is not set
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
        } else {
            t.is(parsed.success, true);
            t.is(parsed.filename, filename);
            t.truthy(parsed.url);
            t.is(parsed.fileId, null); // Should be null since no contextId
        }
    } catch (error) {
        // This is expected if WHISPER_MEDIA_API_URL is not set in test environment
        t.log('Test skipped - file handler URL not configured');
        t.pass();
    }
});

test('WriteFile: Error handling - missing content', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            filename: 'test.txt',
            userMessage: 'Missing content'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error?.includes('content is required') || parsed.error?.includes('required'));
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Error handling - missing filename', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            content: 'Some content',
            userMessage: 'Missing filename'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error?.includes('filename is required') || parsed.error?.includes('required'));
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Different file types and MIME types', async t => {
    const contextId = createTestContext();
    
    try {
        const testCases = [
            { content: 'console.log("hello");', filename: 'script.js', expectedMime: 'application/javascript' },
            { content: 'def hello(): pass', filename: 'script.py', expectedMime: 'text/x-python' },
            { content: '# Hello', filename: 'readme.md', expectedMime: 'text/markdown' },
            { content: '<html></html>', filename: 'page.html', expectedMime: 'text/html' },
            { content: 'name,value\nTest,42', filename: 'data.csv', expectedMime: 'text/csv' }
        ];
        
        let successCount = 0;
        for (const testCase of testCases) {
            const result = await callPathway('sys_tool_writefile', {
                contextId,
                content: testCase.content,
                filename: testCase.filename,
                userMessage: `Writing ${testCase.filename}`
            });
            
            const parsed = JSON.parse(result);
            
            // Skip test if file handler is not configured
            if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
                t.log('Test skipped - file handler URL not configured');
                t.pass();
                return;
            }
            
            t.is(parsed.success, true);
            t.is(parsed.filename, testCase.filename);
            t.truthy(parsed.url);
            successCount++;
        }
        
        // Verify all files were added
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        t.is(collection.length, successCount);
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Large content', async t => {
    const contextId = createTestContext();
    
    try {
        // Create a large content string (100KB)
        const largeContent = 'A'.repeat(100 * 1024);
        const filename = 'large.txt';
        
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            content: largeContent,
            filename,
            userMessage: 'Writing large file'
        });
        
        const parsed = JSON.parse(result);
        
        // Skip test if file handler is not configured
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed.success, true);
        t.is(parsed.filename, filename);
        t.is(parsed.size, Buffer.byteLength(largeContent, 'utf8'));
        t.truthy(parsed.url);
        t.truthy(parsed.hash);
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Duplicate content (same hash)', async t => {
    const contextId = createTestContext();
    
    try {
        const content = 'Duplicate test content';
        const filename1 = 'file1.txt';
        const filename2 = 'file2.txt';
        
        // Write first file
        const result1 = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename: filename1,
            userMessage: 'Writing first file'
        });
        
        const parsed1 = JSON.parse(result1);
        
        // Skip test if file handler is not configured
        if (!parsed1.success && parsed1.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed1.success, true);
        t.truthy(parsed1.hash);
        const firstHash = parsed1.hash;
        
        // Write second file with same content (should reuse hash)
        const result2 = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename: filename2,
            userMessage: 'Writing duplicate file'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.hash, firstHash); // Should have same hash
        
        // Both files should be in collection with different filenames but same hash
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        t.is(collection.length, 2);
        t.true(collection.some(f => f.filename === filename1));
        t.true(collection.some(f => f.filename === filename2));
        t.is(collection[0].hash, collection[1].hash); // Same hash
    } finally {
        await cleanup(contextId);
    }
});

