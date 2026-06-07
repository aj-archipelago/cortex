// fileOperations.test.js
// Integration tests for ReadFile and WriteFile tools

import test from 'ava';
import serverFactory from '../../../../index.js';
import { config } from '../../../../config.js';
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
        agentContext: [{ kind: "user-global", userContextId: contextId, write: true }]
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
            contextId,
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
        t.true(parsed.message.includes('written') && parsed.message.includes('uploaded'));
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
            contextId,
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
            contextId,
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
            contextId,
            agentContext,
            cloudUrl: writeParsed.url,
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
            contextId,
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
            contextId,
            agentContext,
            cloudUrl: writeParsed.url,
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
            contextId,
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
            contextId,
            agentContext,
            cloudUrl: writeParsed.url,
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

// ========== Legacy EditFile Tool Contract ==========

test('Legacy EditFile tools are not registered', t => {
    const entityTools = config.get('entityTools') || {};

    t.false('editfilebyline' in entityTools);
    t.false('editfilebysearchandreplace' in entityTools);
    t.true('workspacessh' in entityTools);
});

// ========== Current File Access Contract Test ==========

test('ReadFile with file parameter requires agentContext file access plan', async t => {
    const contextId = `test-backcompat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    try {
        const content = 'Backward compatibility test content';
        const filename = 'backcompat.txt';
        
        const result = await callPathway('sys_tool_writefile', {
            contextId,
            content,
            filename,
            userMessage: 'Testing read access contract'
        });
        
        const parsed = JSON.parse(result);
        
        // Skip test if file handler is not configured
        if (!parsed.success && parsed.error?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        
        t.is(parsed.success, true, 'Write with contextId should succeed');
        t.is(parsed.filename, filename);
        t.truthy(parsed.url);

        const readResult = await callPathway('sys_tool_readfile', {
            contextId,
            file: parsed.fileId || filename,
            userMessage: 'Reading without agentContext'
        });
        
        const readParsed = JSON.parse(readResult);
        t.is(readParsed.success, false);
        t.regex(readParsed.error, /agentContext is required/);
    } finally {
        await cleanup(contextId);
    }
});
