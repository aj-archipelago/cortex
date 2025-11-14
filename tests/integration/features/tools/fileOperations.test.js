// fileOperations.test.js
// Integration tests for ReadFile, WriteFile, and ModifyFile tools

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
    const contextId = `test-fileops-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return contextId;
};

// Helper to clean up test data
const cleanup = async (contextId, contextKey = null) => {
    try {
        const { keyValueStorageClient } = await import('../../../../lib/keyValueStorageClient.js');
        await keyValueStorageClient.delete(`${contextId}-memoryFiles`);
    } catch (e) {
        // Ignore cleanup errors
    }
};

// ========== WriteFile Tests ==========

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
    } finally {
        await cleanup(contextId);
    }
});

test('WriteFile: Write JSON file', async t => {
    const contextId = createTestContext();
    
    try {
        const content = JSON.stringify({ name: 'Test', value: 42 }, null, 2);
        const filename = 'data.json';
        
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename,
            userMessage: 'Writing JSON file'
        });
        
        const parsed = JSON.parse(result);
        
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed.success, true);
        t.is(parsed.filename, filename);
        t.truthy(parsed.url);
        t.truthy(parsed.hash);
    } finally {
        await cleanup(contextId);
    }
});

// ========== ReadFile Tests ==========

test('ReadFile: Read entire file', async t => {
    const contextId = createTestContext();
    
    try {
        // First write a file
        const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename: 'readtest.txt',
            userMessage: 'Writing file for read test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        // Wait a moment for file to be available
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Now read it
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: writeParsed.fileId || 'readtest.txt',
            userMessage: 'Reading entire file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 5);
        t.is(readParsed.content, content);
        t.is(readParsed.returnedLines, 5);
    } finally {
        await cleanup(contextId);
    }
});

test('ReadFile: Read line range', async t => {
    const contextId = createTestContext();
    
    try {
        // First write a file
        const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename: 'rangetest.txt',
            userMessage: 'Writing file for range read test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Read lines 2-4
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: writeParsed.fileId || 'rangetest.txt',
            startLine: 2,
            endLine: 4,
            userMessage: 'Reading line range'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 5);
        t.is(readParsed.startLine, 2);
        t.is(readParsed.endLine, 4);
        t.is(readParsed.returnedLines, 3);
        t.is(readParsed.content, 'Line 2\nLine 3\nLine 4');
    } finally {
        await cleanup(contextId);
    }
});

test('ReadFile: Read with maxLines limit', async t => {
    const contextId = createTestContext();
    
    try {
        // Write a large file
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
        const content = lines.join('\n');
        
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename: 'largetest.txt',
            userMessage: 'Writing large file'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Read with maxLines limit
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: writeParsed.fileId || 'largetest.txt',
            maxLines: 10,
            userMessage: 'Reading with limit'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 100);
        t.is(readParsed.returnedLines, 10);
        t.true(readParsed.truncated);
    } finally {
        await cleanup(contextId);
    }
});

// ========== ModifyFile Tests ==========

test('ModifyFile: Replace single line', async t => {
    const contextId = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: initialContent,
            filename: 'modifytest.txt',
            userMessage: 'Writing file for modify test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Modify line 3
        const modifyResult = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: writeParsed.fileId || 'modifytest.txt',
            startLine: 3,
            endLine: 3,
            content: 'Modified Line 3',
            userMessage: 'Modifying line 3'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.is(modifyParsed.replacedLines, 1);
        t.is(modifyParsed.insertedLines, 1);
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: modifyParsed.fileId || 'modifytest.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        const lines = readParsed.content.split('\n');
        t.is(lines[2], 'Modified Line 3'); // Line 3 is index 2 (0-indexed)
    } finally {
        await cleanup(contextId);
    }
});

test('ModifyFile: Replace multiple lines', async t => {
    const contextId = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: initialContent,
            filename: 'multimodify.txt',
            userMessage: 'Writing file for multi-line modify'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Replace lines 2-4 with new content
        const modifyResult = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: writeParsed.fileId || 'multimodify.txt',
            startLine: 2,
            endLine: 4,
            content: 'New Line 2\nNew Line 3\nNew Line 4',
            userMessage: 'Replacing multiple lines'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.is(modifyParsed.replacedLines, 3);
        t.is(modifyParsed.insertedLines, 3);
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: modifyParsed.fileId || 'multimodify.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        const lines = readParsed.content.split('\n');
        t.is(lines[0], 'Line 1');
        t.is(lines[1], 'New Line 2');
        t.is(lines[2], 'New Line 3');
        t.is(lines[3], 'New Line 4');
        t.is(lines[4], 'Line 5');
    } finally {
        await cleanup(contextId);
    }
});

test('ModifyFile: Insert content (replace with more lines)', async t => {
    const contextId = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3';
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: initialContent,
            filename: 'inserttest.txt',
            userMessage: 'Writing file for insert test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Replace line 2 with 3 new lines
        const modifyResult = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: writeParsed.fileId || 'inserttest.txt',
            startLine: 2,
            endLine: 2,
            content: 'New Line 2a\nNew Line 2b\nNew Line 2c',
            userMessage: 'Inserting multiple lines'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.is(modifyParsed.replacedLines, 1);
        t.is(modifyParsed.insertedLines, 3);
        t.is(modifyParsed.modifiedLines, 5); // 1 + 3 + 1 = 5 lines
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: modifyParsed.fileId || 'inserttest.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 5);
        const lines = readParsed.content.split('\n');
        t.is(lines[0], 'Line 1');
        t.is(lines[1], 'New Line 2a');
        t.is(lines[2], 'New Line 2b');
        t.is(lines[3], 'New Line 2c');
        t.is(lines[4], 'Line 3');
    } finally {
        await cleanup(contextId);
    }
});

test('ModifyFile: Delete content (replace with fewer lines)', async t => {
    const contextId = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: initialContent,
            filename: 'deletetest.txt',
            userMessage: 'Writing file for delete test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Replace lines 2-4 with a single line
        const modifyResult = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: writeParsed.fileId || 'deletetest.txt',
            startLine: 2,
            endLine: 4,
            content: 'Replacement Line',
            userMessage: 'Deleting multiple lines'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.is(modifyParsed.replacedLines, 3);
        t.is(modifyParsed.insertedLines, 1);
        t.is(modifyParsed.modifiedLines, 3); // 1 + 1 + 1 = 3 lines
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: modifyParsed.fileId || 'deletetest.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 3);
        const lines = readParsed.content.split('\n');
        t.is(lines[0], 'Line 1');
        t.is(lines[1], 'Replacement Line');
        t.is(lines[2], 'Line 5');
    } finally {
        await cleanup(contextId);
    }
});

test('ModifyFile: Error handling - file not found', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: 'nonexistent.txt',
            startLine: 1,
            endLine: 1,
            content: 'test',
            userMessage: 'Trying to modify nonexistent file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error?.includes('not found') || parsed.error?.includes('File not found'));
    } finally {
        await cleanup(contextId);
    }
});

test('ModifyFile: Error handling - invalid line range', async t => {
    const contextId = createTestContext();
    
    try {
        // Write a file first
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: 'Line 1\nLine 2',
            filename: 'rangetest.txt',
            userMessage: 'Writing test file'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Try invalid range (endLine < startLine)
        const result = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: writeParsed.fileId || 'rangetest.txt',
            startLine: 5,
            endLine: 3,
            content: 'test',
            userMessage: 'Invalid range test'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error?.includes('endLine must be >= startLine'));
    } finally {
        await cleanup(contextId);
    }
});

test('ModifyFile: Error handling - line out of range', async t => {
    const contextId = createTestContext();
    
    try {
        // Write a file with 2 lines
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: 'Line 1\nLine 2',
            filename: 'rangetest2.txt',
            userMessage: 'Writing test file'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Try to modify line 10 (doesn't exist)
        const result = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: writeParsed.fileId || 'rangetest2.txt',
            startLine: 10,
            endLine: 10,
            content: 'test',
            userMessage: 'Out of range test'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error?.includes('exceeds file length'));
    } finally {
        await cleanup(contextId);
    }
});

// ========== Integration Tests ==========

test('File Operations: Write, Read, Modify workflow', async t => {
    const contextId = createTestContext();
    
    try {
        // 1. Write a file
        const writeResult = await callPathway('sys_tool_writefile', {
            contextId,
            content: 'Initial content\nLine 2\nLine 3',
            filename: 'workflow.txt',
            userMessage: 'Writing initial file'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(writeParsed.success, true);
        const fileId = writeParsed.fileId;
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 2. Read the file
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: fileId,
            userMessage: 'Reading file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 3);
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 3. Modify the file
        const modifyResult = await callPathway('sys_tool_modifyfile', {
            contextId,
            file: fileId,
            startLine: 2,
            endLine: 2,
            content: 'Modified Line 2',
            userMessage: 'Modifying file'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 4. Read again to verify modification
        const readResult2 = await callPathway('sys_tool_readfile', {
            contextId,
            file: fileId,
            userMessage: 'Reading modified file'
        });
        
        const readParsed2 = JSON.parse(readResult2);
        t.is(readParsed2.success, true);
        const lines = readParsed2.content.split('\n');
        t.is(lines[1], 'Modified Line 2');
    } finally {
        await cleanup(contextId);
    }
});

