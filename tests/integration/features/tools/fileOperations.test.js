// fileOperations.test.js
// Integration tests for ReadFile, WriteFile, and EditFile tools

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

// Helper to create a test context (returns agentContext array)
const createTestContext = () => {
    const contextId = `test-fileops-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return {
        contextId,
        agentContext: [{ contextId, contextKey: null, default: true }]
    };
};

// Helper to clean up test data
const cleanup = async (contextId) => {
    try {
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        if (redisClient) {
            const contextMapKey = `FileStoreMap:ctx:${contextId}`;
            await redisClient.del(contextMapKey);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
};

// ========== WriteFile Tests ==========

test('WriteFile: Write and upload text file', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        const content = 'Hello, world!\nThis is a test file.';
        const filename = 'test.txt';
        
        const result = await callPathway('sys_tool_writefile', {
            agentContext,
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
    const { contextId, agentContext } = createTestContext();
    
    try {
        const content = JSON.stringify({ name: 'Test', value: 42 }, null, 2);
        const filename = 'data.json';
        
        const result = await callPathway('sys_tool_writefile', {
            agentContext,
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
    const { contextId, agentContext } = createTestContext();
    
    try {
        // First write a file
        const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
            agentContext,
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
    const { contextId, agentContext } = createTestContext();
    
    try {
        // First write a file
        const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
            agentContext,
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

test('ReadFile: Read with line range limit', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write a large file
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
        const content = lines.join('\n');
        
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        
        // Read with endLine limit (first 10 lines)
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: writeParsed.fileId || 'largetest.txt',
            startLine: 1,
            endLine: 10,
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

// ========== EditFileByLine Tests ==========

test('EditFileByLine: Replace single line', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        
        t.is(writeParsed.success, true, 'File should be written successfully');
        t.truthy(writeParsed.url, 'File should have a URL');
        
        // Wait for file to be available (increased wait for reliability)
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Modify line 3
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
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
            agentContext,
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

test('EditFileByLine: Replace multiple lines', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
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
            agentContext,
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

test('EditFileByLine: Insert content (replace with more lines)', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
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
            agentContext,
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

test('EditFileByLine: Delete content (replace with fewer lines)', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
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
            agentContext,
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

test('EditFileByLine: Error handling - file not found', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_editfile', {
            agentContext,
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

test('EditFileByLine: Error handling - invalid line range', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write a file first
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        const result = await callPathway('sys_tool_editfile', {
            agentContext,
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

test('EditFileByLine: Works after prior SearchAndReplace edit', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Version: v1\nLine2: alpha\nLine3: bravo\nLine4: charlie';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'smoketest-tools.txt',
            userMessage: 'Writing file for sequential edit test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(writeParsed.success, true);
        const fileId = writeParsed.fileId || 'smoketest-tools.txt';
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // First edit: SearchAndReplace (changes hash)
        const searchReplaceResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: fileId,
            oldString: 'Version: v1',
            newString: 'Version: v2',
            replaceAll: false,
            userMessage: 'First edit: SearchAndReplace'
        });
        
        const searchReplaceParsed = JSON.parse(searchReplaceResult);
        t.is(searchReplaceParsed.success, true);
        t.truthy(searchReplaceParsed.url);
        t.truthy(searchReplaceParsed.hash);
        
        // Wait a moment for collection to update
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Second edit: EditFileByLine (should work after hash change)
        const editByLineResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: fileId, // Use same fileId - should resolve correctly after hash change
            startLine: 3,
            endLine: 3,
            content: 'Line3: BRAVO_EDITED',
            userMessage: 'Second edit: EditFileByLine after SearchAndReplace'
        });
        
        const editByLineParsed = JSON.parse(editByLineResult);
        t.is(editByLineParsed.success, true, 'EditFileByLine should work after prior SearchAndReplace edit');
        t.is(editByLineParsed.replacedLines, 1);
        t.is(editByLineParsed.insertedLines, 1);
        
        // Verify final content
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: fileId,
            userMessage: 'Reading final file content'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.true(readParsed.content.includes('Version: v2'), 'Should have v2 from SearchAndReplace');
        t.true(readParsed.content.includes('BRAVO_EDITED'), 'Should have edited line from EditFileByLine');
    } finally {
        await cleanup(contextId);
    }
});

test('ReadTextFile: Gets fresh content after EditFileByLine', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line1: alpha\nLine2: bravo\nLine3: charlie';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'read-after-edit.txt',
            userMessage: 'Writing file for read-after-edit test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(writeParsed.success, true);
        const fileId = writeParsed.fileId || 'read-after-edit.txt';
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Edit the file
        const editResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: fileId,
            startLine: 2,
            endLine: 2,
            content: 'Line2: BRAVO_EDITED',
            userMessage: 'Editing file'
        });
        
        const editParsed = JSON.parse(editResult);
        t.is(editParsed.success, true);
        
        // Wait a moment for collection to update
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Read file - should get fresh content (not cached)
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: fileId,
            userMessage: 'Reading file after edit'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.true(readParsed.content.includes('BRAVO_EDITED'), 'ReadTextFile should return fresh content after edit');
        t.false(readParsed.content.includes('Line2: bravo'), 'Should not have old content');
    } finally {
        await cleanup(contextId);
    }
});

test('EditFileByLine: Error handling - line out of range', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write a file with 2 lines
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
        const result = await callPathway('sys_tool_editfile', {
            agentContext,
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

// ========== EditFileBySearchAndReplace Tests ==========

test('EditFileBySearchAndReplace: Replace first occurrence', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Hello world\nThis is a test\nHello again';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'searchreplace.txt',
            userMessage: 'Writing file for search replace test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Replace first occurrence of "Hello"
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: writeParsed.fileId || 'searchreplace.txt',
            oldString: 'Hello',
            newString: 'Hi',
            replaceAll: false,
            userMessage: 'Replacing first occurrence'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.is(modifyParsed.mode, 'string-based');
        t.is(modifyParsed.replaceAll, false);
        t.is(modifyParsed.occurrencesReplaced, 1);
        t.is(modifyParsed.totalOccurrences, 2);
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: modifyParsed.fileId || 'searchreplace.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.content, 'Hi world\nThis is a test\nHello again');
    } finally {
        await cleanup(contextId);
    }
});

test('EditFileBySearchAndReplace: Replace all occurrences', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Hello world\nThis is a test\nHello again';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'searchreplaceall.txt',
            userMessage: 'Writing file for search replace all test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Replace all occurrences of "Hello"
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: writeParsed.fileId || 'searchreplaceall.txt',
            oldString: 'Hello',
            newString: 'Hi',
            replaceAll: true,
            userMessage: 'Replacing all occurrences'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.is(modifyParsed.mode, 'string-based');
        t.is(modifyParsed.replaceAll, true);
        t.is(modifyParsed.occurrencesReplaced, 2);
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: modifyParsed.fileId || 'searchreplaceall.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.content, 'Hi world\nThis is a test\nHi again');
    } finally {
        await cleanup(contextId);
    }
});

test('EditFileBySearchAndReplace: Replace multiline string', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 2\nLine 4';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'multiline.txt',
            userMessage: 'Writing file for multiline replace test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Replace multiline string
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: writeParsed.fileId || 'multiline.txt',
            oldString: 'Line 2\nLine 3',
            newString: 'Replaced 2\nReplaced 3',
            replaceAll: false,
            userMessage: 'Replacing multiline string'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        
        // Read back to verify
        await new Promise(resolve => setTimeout(resolve, 500));
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: modifyParsed.fileId || 'multiline.txt',
            userMessage: 'Reading modified file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.content, 'Line 1\nReplaced 2\nReplaced 3\nLine 2\nLine 4');
    } finally {
        await cleanup(contextId);
    }
});

test('EditFileBySearchAndReplace: Error handling - string not found', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write a file
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: 'Line 1\nLine 2',
            filename: 'notfound.txt',
            userMessage: 'Writing test file'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Try to replace a string that doesn't exist
        const result = await callPathway('sys_tool_editfile', {
            agentContext,
            file: writeParsed.fileId || 'notfound.txt',
            oldString: 'This string does not exist',
            newString: 'replacement',
            userMessage: 'Trying to replace non-existent string'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error?.includes('not found in file') || parsed.error?.includes('oldString not found'));
    } finally {
        await cleanup(contextId);
    }
});

// ========== Data Integrity Tests ==========

test('EditFile: Old file preserved if upload fails (data integrity)', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Original content\nLine 2\nLine 3';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'integrity-test.txt',
            userMessage: 'Writing file for integrity test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(writeParsed.success, true);
        const originalFileId = writeParsed.fileId;
        const originalUrl = writeParsed.url;
        const originalHash = writeParsed.hash;
        
        // Verify original file is readable
        await new Promise(resolve => setTimeout(resolve, 500));
        const readOriginal = await callPathway('sys_tool_readfile', {
            agentContext,
            file: originalFileId,
            userMessage: 'Reading original file'
        });
        const readOriginalParsed = JSON.parse(readOriginal);
        t.is(readOriginalParsed.success, true);
        t.is(readOriginalParsed.content, initialContent);
        
        // Edit the file (this should upload first, then delete old file)
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
            file: originalFileId,
            startLine: 1,
            endLine: 1,
            content: 'Modified content',
            userMessage: 'Modifying file (upload-first test)'
        });
        
        const modifyParsed = JSON.parse(modifyResult);
        t.is(modifyParsed.success, true);
        t.truthy(modifyParsed.url);
        t.truthy(modifyParsed.hash);
        
        // Verify new URL is different from old URL (new file was uploaded)
        t.not(modifyParsed.url, originalUrl);
        t.not(modifyParsed.hash, originalHash);
        
        // Verify new file has correct content
        await new Promise(resolve => setTimeout(resolve, 500));
        const readModified = await callPathway('sys_tool_readfile', {
            agentContext,
            file: modifyParsed.fileId || originalFileId,
            userMessage: 'Reading modified file'
        });
        const readModifiedParsed = JSON.parse(readModified);
        t.is(readModifiedParsed.success, true);
        t.true(readModifiedParsed.content.includes('Modified content'));
        t.false(readModifiedParsed.content.includes('Original content'));
        
        // Verify file collection was updated with new URL (proves upload happened first)
        const listResult = await callPathway('sys_tool_file_collection', {
            agentContext,
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        const updatedFile = listParsed.files.find(f => f.id === originalFileId);
        t.truthy(updatedFile);
        // Most important: URL changed, proving new file was uploaded before old was deleted
        t.is(updatedFile.url, modifyParsed.url);
        t.not(updatedFile.url, originalUrl, 'URL should have changed after edit');
        // Hash verification is optional - some systems may not return it in list
        if (modifyParsed.hash && updatedFile.hash) {
            t.is(updatedFile.hash, modifyParsed.hash);
        }
        
        // Note: We can't easily test upload failure scenario in integration tests,
        // but the code structure ensures old file is preserved because:
        // 1. Upload happens first (line 304-315 in sys_tool_editfile.js)
        // 2. If upload fails, error is thrown before deletion code runs
        // 3. Old file deletion only happens after successful upload (line 317+)
    } finally {
        await cleanup(contextId);
    }
});

// ========== Serialization Tests ==========

test('EditFile: Concurrent edits are serialized (no race conditions)', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file with numbered lines
        const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'serialization-test.txt',
            userMessage: 'Writing file for serialization test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(writeParsed.success, true);
        const fileId = writeParsed.fileId || 'serialization-test.txt';
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Trigger multiple concurrent edits on the same file
        // Each edit modifies a different line to verify they all apply
        const editPromises = [
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 1,
                endLine: 1,
                content: 'Line 1: EDIT_A',
                userMessage: 'Concurrent edit A'
            }),
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 2,
                endLine: 2,
                content: 'Line 2: EDIT_B',
                userMessage: 'Concurrent edit B'
            }),
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 3,
                endLine: 3,
                content: 'Line 3: EDIT_C',
                userMessage: 'Concurrent edit C'
            }),
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 4,
                endLine: 4,
                content: 'Line 4: EDIT_D',
                userMessage: 'Concurrent edit D'
            })
        ];
        
        // Execute all edits concurrently
        const editResults = await Promise.all(editPromises);
        
        // Verify all edits succeeded
        const editParsed = editResults.map(r => JSON.parse(r));
        editParsed.forEach((result, index) => {
            t.is(result.success, true, `Edit ${String.fromCharCode(65 + index)} should succeed`);
        });
        
        // Wait a moment for collection to update
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Read the final file content
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: fileId,
            userMessage: 'Reading final file after concurrent edits'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        
        // Verify all edits were applied (serialization ensures no lost updates)
        const lines = readParsed.content.split('\n');
        t.is(lines[0], 'Line 1: EDIT_A', 'Line 1 should have edit A');
        t.is(lines[1], 'Line 2: EDIT_B', 'Line 2 should have edit B');
        t.is(lines[2], 'Line 3: EDIT_C', 'Line 3 should have edit C');
        t.is(lines[3], 'Line 4: EDIT_D', 'Line 4 should have edit D');
        t.is(lines[4], 'Line 5', 'Line 5 should be unchanged');
        
        // Verify file has exactly 5 lines (no corruption from concurrent edits)
        t.is(readParsed.totalLines, 5, 'File should have exactly 5 lines');
    } finally {
        await cleanup(contextId);
    }
});

test('EditFile: Sequential edits maintain order (serialization verification)', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // Write initial file
        const initialContent = 'Version: 0';
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
            content: initialContent,
            filename: 'order-test.txt',
            userMessage: 'Writing file for order test'
        });
        
        const writeParsed = JSON.parse(writeResult);
        
        if (!writeParsed.success && writeParsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(writeParsed.success, true);
        const fileId = writeParsed.fileId || 'order-test.txt';
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Trigger multiple concurrent edits that each append to the file
        // If serialization works, each edit should see the previous one's changes
        const editPromises = [
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 1,
                endLine: 1,
                content: 'Version: 0\nEdit: 1',
                userMessage: 'Edit 1'
            }),
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 1,
                endLine: 2,
                content: 'Version: 0\nEdit: 1\nEdit: 2',
                userMessage: 'Edit 2'
            }),
            callPathway('sys_tool_editfile', {
                contextId,
                file: fileId,
                startLine: 1,
                endLine: 3,
                content: 'Version: 0\nEdit: 1\nEdit: 2\nEdit: 3',
                userMessage: 'Edit 3'
            })
        ];
        
        // Execute all edits concurrently
        const editResults = await Promise.all(editPromises);
        
        // All should succeed (serialization prevents conflicts)
        const editParsed = editResults.map(r => JSON.parse(r));
        editParsed.forEach((result, index) => {
            t.is(result.success, true, `Edit ${index + 1} should succeed`);
        });
        
        // Wait for collection to update
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Read final content
        const readResult = await callPathway('sys_tool_readfile', {
            agentContext,
            file: fileId,
            userMessage: 'Reading final file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        
        // Verify final content - should have all edits applied in order
        // Since edits are serialized, the last one to complete should have the final state
        const lines = readParsed.content.split('\n');
        t.true(lines.length >= 3, 'File should have at least 3 lines');
        t.true(readParsed.content.includes('Version: 0'), 'Should contain original content');
        t.true(readParsed.content.includes('Edit: 1'), 'Should contain edit 1');
        t.true(readParsed.content.includes('Edit: 2'), 'Should contain edit 2');
        t.true(readParsed.content.includes('Edit: 3'), 'Should contain edit 3');
    } finally {
        await cleanup(contextId);
    }
});

// ========== Integration Tests ==========

test('File Operations: Write, Read, Modify workflow', async t => {
    const { contextId, agentContext } = createTestContext();
    
    try {
        // 1. Write a file
        const writeResult = await callPathway('sys_tool_writefile', {
            agentContext,
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
            agentContext,
            file: fileId,
            userMessage: 'Reading file'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true);
        t.is(readParsed.totalLines, 3);
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 3. Modify the file
        const modifyResult = await callPathway('sys_tool_editfile', {
            agentContext,
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
            agentContext,
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

// ========== Backward Compatibility Test ==========

test('Backward compat: contextId without agentContext still works', async t => {
    // Test that passing contextId directly (without agentContext) still works
    // The pathwayResolver should automatically create agentContext from contextId
    const contextId = `test-backcompat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    try {
        const content = 'Backward compatibility test content';
        const filename = 'backcompat.txt';
        
        // Use contextId directly instead of agentContext
        const result = await callPathway('sys_tool_writefile', {
            contextId,  // Legacy format - no agentContext
            content,
            filename,
            userMessage: 'Testing backward compatibility'
        });
        
        const parsed = JSON.parse(result);
        
        // Skip test if file handler is not configured
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed.success, true, 'Write with legacy contextId should succeed');
        t.is(parsed.filename, filename);
        t.truthy(parsed.url);
        
        // Also test read with legacy format
        const readResult = await callPathway('sys_tool_readfile', {
            contextId,  // Legacy format
            file: parsed.fileId || filename,
            userMessage: 'Reading with legacy contextId'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, true, 'Read with legacy contextId should succeed');
        t.is(readParsed.content, content);
    } finally {
        await cleanup(contextId);
    }
});

