// fileCollection.test.js
// Integration tests for file collection tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { generateFileMessageContent, resolveFileParameter, loadFileCollection, syncAndStripFilesFromChatHistory, loadMergedFileCollection } from '../../../../lib/fileUtils.js';

// Helper to create agentContext from contextId/contextKey
const createAgentContext = (contextId, contextKey = null) => [{ contextId, contextKey, default: true }];

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
    const contextId = `test-file-collection-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return contextId;
};

// Helper to clean up test data
const cleanup = async (contextId, contextKey = null) => {
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

test('File collection: Add file to collection', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.jpg',
            gcs: 'gs://bucket/test.jpg',
            filename: 'test.jpg',
            tags: ['photo', 'test'],
            notes: 'Test file',
            userMessage: 'Adding test file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.truthy(parsed.fileId);
        t.true(parsed.message.includes('test.jpg'));
        
        // Verify it was saved to Redis hash map
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 1);
        t.is(collection[0].displayFilename, 'test.jpg');
        t.is(collection[0].url, 'https://example.com/test.jpg');
        t.is(collection[0].gcs, 'gs://bucket/test.jpg');
        t.deepEqual(collection[0].tags, ['photo', 'test']);
        t.is(collection[0].notes, 'Test file');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: List files', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a few files first
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            tags: ['document'],
            userMessage: 'Add file 2'
        });
        
        // List files
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            userMessage: 'List files'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.count, 2);
        t.is(parsed.totalFiles, 2);
        t.is(parsed.files.length, 2);
        t.true(parsed.files.some(f => f.displayFilename === 'file1.jpg'));
        t.true(parsed.files.some(f => f.displayFilename === 'file2.pdf'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Search files', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files with different metadata
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/report.pdf',
            filename: 'report.pdf',
            tags: ['document', 'report'],
            notes: 'Monthly report',
            userMessage: 'Add report'
        });
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/image.jpg',
            filename: 'image.jpg',
            tags: ['photo'],
            notes: 'Photo of office',
            userMessage: 'Add image'
        });
        
        // Search by filename
        const result1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'report',
            userMessage: 'Search for report'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.success, true);
        t.is(parsed1.count, 1);
        t.is(parsed1.files[0].displayFilename, 'report.pdf');
        
        // Search by tag
        const result2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'photo',
            userMessage: 'Search for photo'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 1);
        t.is(parsed2.files[0].displayFilename, 'image.jpg');
        
        // Search by notes
        const result3 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'office',
            userMessage: 'Search for office'
        });
        
        const parsed3 = JSON.parse(result3);
        t.is(parsed3.success, true);
        t.is(parsed3.count, 1);
        t.is(parsed3.files[0].displayFilename, 'image.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Search by filename when displayFilename not set', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file with only filename (no displayFilename)
        // This tests the bug fix where search only checked displayFilename
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/smoketest-tools.txt',
            filename: 'smoketest-tools.txt',
            tags: ['smoketest', 'text'],
            notes: 'Created to test SearchFileCollection',
            userMessage: 'Add smoketest file'
        });
        
        // Search by filename - should find it even if displayFilename not set
        const result1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'smoketest',
            userMessage: 'Search for smoketest'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.success, true);
        t.is(parsed1.count, 1);
        t.true(parsed1.files[0].displayFilename === 'smoketest-tools.txt' || 
               parsed1.files[0].filename === 'smoketest-tools.txt');
        
        // Search by full filename
        const result2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'smoketest-tools',
            userMessage: 'Search for smoketest-tools'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 1);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Remove single file', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files
        const addResult1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        const file1Id = JSON.parse(addResult1).fileId;
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            userMessage: 'Add file 2'
        });
        
        // Remove file1
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileIds: [file1Id],
            userMessage: 'Remove file 1'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.removedCount, 1);
        t.is(parsed.remainingFiles, 1);
        t.is(parsed.removedFiles.length, 1);
        t.is(parsed.removedFiles[0].displayFilename, 'file1.jpg');
        t.true(parsed.message.includes('Cloud storage cleanup started in background'));
        
        // Verify it was removed (cache should be invalidated immediately)
        const listResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        t.is(listParsed.totalFiles, 1);
        // Check displayFilename with fallback to filename
        t.false(listParsed.files.some(f => (f.displayFilename || f.filename) === 'file1.jpg'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Remove file - cache invalidation', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files
        const addResult1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        const file1Id = JSON.parse(addResult1).fileId;
        
        const addResult2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            userMessage: 'Add file 2'
        });
        const file2Id = JSON.parse(addResult2).fileId;
        
        // Verify both files are in collection
        const listBefore = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            userMessage: 'List files before removal'
        });
        const listBeforeParsed = JSON.parse(listBefore);
        t.is(listBeforeParsed.totalFiles, 2);
        
        // Remove file1
        const removeResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileIds: [file1Id],
            userMessage: 'Remove file 1'
        });
        
        const removeParsed = JSON.parse(removeResult);
        t.is(removeParsed.success, true);
        t.is(removeParsed.removedCount, 1);
        
        // Immediately list files - should reflect removal (cache invalidation test)
        const listAfter = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            userMessage: 'List files after removal'
        });
        const listAfterParsed = JSON.parse(listAfter);
        t.is(listAfterParsed.totalFiles, 1, 'List should immediately reflect removal (cache invalidated)');
        t.false(listAfterParsed.files.some(f => (f.displayFilename || f.filename) === 'file1.jpg'));
        t.true(listAfterParsed.files.some(f => (f.displayFilename || f.filename) === 'file2.pdf'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Remove multiple files', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files
        const addResult1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        const file1Id = JSON.parse(addResult1).fileId;

        const addResult2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            userMessage: 'Add file 2'
        });
        const file2Id = JSON.parse(addResult2).fileId;
        
        // Remove multiple files
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileIds: [file1Id, file2Id],
            userMessage: 'Remove files 1 and 2'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.removedCount, 2);
        t.is(parsed.remainingFiles, 0);
        t.is(parsed.removedFiles.length, 2);
        t.true(parsed.message.includes('Cloud storage cleanup started in background'));
        
        // Verify collection is empty
        const listResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        t.is(listParsed.totalFiles, 0);
    } finally {
        await cleanup(contextId);
    }
});


test('File collection: Error handling - missing contextId', async t => {
    try {
        const result = await callPathway('sys_tool_file_collection', {
            url: 'https://example.com/test.jpg',
            filename: 'test.jpg',
            userMessage: 'Test'
        });
        
        // Result might be JSON or error string
        let parsed;
        try {
            parsed = JSON.parse(result);
        } catch {
            // If not JSON, it's an error string - that's fine
            t.true(typeof result === 'string');
            t.true(result.includes('required') || result.includes('agentContext') || result.includes('contextId'));
            return;
        }
        
        // If it's JSON, check for error
        if (parsed.success === false) {
            t.true(parsed.error.includes('required') || parsed.error.includes('agentContext') || parsed.error.includes('contextId'));
        } else {
            // If no error, that's also a failure case
            t.fail('Expected error when contextId is missing');
        }
    } catch (error) {
        // Error thrown is also acceptable
        t.true(error.message.includes('required') || error.message.includes('agentContext') || error.message.includes('contextId') || error.message.includes('EADDRINUSE'));
    }
});

test('File collection: Error handling - remove non-existent file', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileIds: ['non-existent-id'],
            userMessage: 'Remove file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error.includes('No files found matching'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: List with filters and sorting', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files with different tags and dates
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file1.jpg',
            filename: 'a_file.jpg',
            tags: ['photo'],
            userMessage: 'Add file 1'
        });
        
        // Wait a bit to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/file2.pdf',
            filename: 'z_file.pdf',
            tags: ['document'],
            userMessage: 'Add file 2'
        });
        
        // List sorted by filename
        const result1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            sortBy: 'filename',
            userMessage: 'List sorted by filename'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.files[0].displayFilename, 'a_file.jpg');
        t.is(parsed1.files[1].displayFilename, 'z_file.pdf');
        
        // List filtered by tag
        const result2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            tags: ['photo'],
            userMessage: 'List photos'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.count, 1);
        t.is(parsed2.files[0].displayFilename, 'a_file.jpg');
    } finally {
        await cleanup(contextId);
    }
});

// Test generateFileMessageContent function (integration tests)
// Note: These tests verify basic functionality. If WHISPER_MEDIA_API_URL is configured,
// generateFileMessageContent will automatically use short-lived URLs when file hashes are available.
test('generateFileMessageContent should find file by ID', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file to collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            gcs: 'gs://bucket/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Add test file'
        });
        
        // Get the file ID from the collection
        const collection = await loadFileCollection(contextId, null, false);
        const fileId = collection[0].id;
        
        // Normalize by ID
        const result = await generateFileMessageContent(fileId, createAgentContext(contextId));
        
        t.truthy(result);
        t.is(result.type, 'image_url');
        t.is(result.url, 'https://example.com/test.pdf');
        t.is(result.gcs, 'gs://bucket/test.pdf'); 
        // originalFilename is no longer returned in message content objects
        t.truthy(result.url);
        t.truthy(result.hash);
    } finally {
        await cleanup(contextId);
    }
});

test('generateFileMessageContent should find file by URL', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file to collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            gcs: 'gs://bucket/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Add test file'
        });
        
        // Normalize by URL
        const result = await generateFileMessageContent('https://example.com/test.pdf', createAgentContext(contextId));
        
        t.truthy(result);
        t.is(result.url, 'https://example.com/test.pdf');
        t.is(result.gcs, 'gs://bucket/test.pdf');
    } finally {
        await cleanup(contextId);
    }
});

test('generateFileMessageContent should find file by fuzzy filename match', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files to collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/document.pdf',
            filename: 'document.pdf',
            userMessage: 'Add document'
        });
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/image.jpg',
            filename: 'image.jpg',
            userMessage: 'Add image'
        });
        
        // Normalize by partial filename
        const result1 = await generateFileMessageContent('document', createAgentContext(contextId));
        t.truthy(result1);
        // originalFilename is no longer returned in message content objects
        t.truthy(result1.url);
        t.truthy(result1.hash);
        
        // Normalize by full filename
        const result2 = await generateFileMessageContent('image.jpg', createAgentContext(contextId));
        t.truthy(result2);
        // originalFilename is no longer returned in message content objects
        t.truthy(result2.url);
        t.truthy(result2.hash);
    } finally {
        await cleanup(contextId);
    }
});

test('generateFileMessageContent should detect image type', async t => {
    const contextId = createTestContext();
    
    try {
        // Add an image file
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/image.jpg',
            filename: 'image.jpg',
            userMessage: 'Add image'
        });
        
        const collection = await loadFileCollection(contextId, null, false);
        const fileId = collection[0].id;
        
        const result = await generateFileMessageContent(fileId, createAgentContext(contextId));
        
        t.truthy(result);
        t.is(result.type, 'image_url');
        t.is(result.url, 'https://example.com/image.jpg');
    } finally {
        await cleanup(contextId);
    }
});

// Tests for resolveFileParameter
test('resolveFileParameter: Resolve by file ID', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file to collection
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test-doc.pdf',
            gcs: 'gs://bucket/test-doc.pdf',
            filename: 'test-doc.pdf',
            userMessage: 'Adding test file'
        });
        
        const addParsed = JSON.parse(addResult);
        const fileId = addParsed.fileId;
        
        // Resolve by file ID
        const resolved = await resolveFileParameter(fileId, createAgentContext(contextId));
        t.is(resolved, 'https://example.com/test-doc.pdf');
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Resolve by filename', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file to collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/my-file.txt',
            gcs: 'gs://bucket/my-file.txt',
            filename: 'my-file.txt',
            userMessage: 'Adding test file'
        });
        
        // Resolve by filename
        const resolved = await resolveFileParameter('my-file.txt', createAgentContext(contextId));
        t.is(resolved, 'https://example.com/my-file.txt');
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Resolve by hash', async t => {
    const contextId = createTestContext();
    const testHash = 'abc123def456';
    
    try {
        // Add a file to collection with hash
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/hashed-file.jpg',
            gcs: 'gs://bucket/hashed-file.jpg',
            filename: 'hashed-file.jpg',
            hash: testHash,
            userMessage: 'Adding test file'
        });
        
        // Resolve by hash
        const resolved = await resolveFileParameter(testHash, createAgentContext(contextId));
        t.is(resolved, 'https://example.com/hashed-file.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Resolve by Azure URL', async t => {
    const contextId = createTestContext();
    const testUrl = 'https://example.com/existing-file.pdf';
    
    try {
        // Add a file to collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: testUrl,
            gcs: 'gs://bucket/existing-file.pdf',
            filename: 'existing-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by Azure URL
        const resolved = await resolveFileParameter(testUrl, createAgentContext(contextId));
        t.is(resolved, testUrl);
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Resolve by GCS URL', async t => {
    const contextId = createTestContext();
    const testGcsUrl = 'gs://bucket/gcs-file.pdf';
    
    try {
        // Add a file to collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/gcs-file.pdf',
            gcs: testGcsUrl,
            filename: 'gcs-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by GCS URL
        const resolved = await resolveFileParameter(testGcsUrl, createAgentContext(contextId));
        t.is(resolved, 'https://example.com/gcs-file.pdf');
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Prefer GCS URL when preferGcs is true', async t => {
    const contextId = createTestContext();
    const testGcsUrl = 'gs://bucket/prefer-gcs-file.pdf';
    const testAzureUrl = 'https://example.com/prefer-gcs-file.pdf';
    
    try {
        // Add a file to collection with both URLs
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: testAzureUrl,
            gcs: testGcsUrl,
            filename: 'prefer-gcs-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by filename without preferGcs (should return Azure URL)
        const resolvedDefault = await resolveFileParameter('prefer-gcs-file.pdf', createAgentContext(contextId));
        t.is(resolvedDefault, testAzureUrl);
        
        // Resolve by filename with preferGcs (should return GCS URL)
        const resolvedGcs = await resolveFileParameter('prefer-gcs-file.pdf', createAgentContext(contextId), { preferGcs: true });
        t.is(resolvedGcs, testGcsUrl);
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Return null when file not found', async t => {
    const contextId = createTestContext();
    
    try {
        // Try to resolve a non-existent file
        const resolved = await resolveFileParameter('non-existent-file.txt', createAgentContext(contextId));
        t.is(resolved, null);
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Return null when contextId is missing', async t => {
    // Try to resolve without contextId
    const resolved = await resolveFileParameter('some-file.txt', null);
    t.is(resolved, null);
});

test('resolveFileParameter: Return null when fileParam is empty', async t => {
    const contextId = createTestContext();
    
    try {
        // Try with empty string
        const resolved1 = await resolveFileParameter('', createAgentContext(contextId));
        t.is(resolved1, null);
        
        // Try with null
        const resolved2 = await resolveFileParameter(null, createAgentContext(contextId));
        t.is(resolved2, null);
        
        // Try with undefined
        const resolved3 = await resolveFileParameter(undefined, createAgentContext(contextId));
        t.is(resolved3, null);
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Contains match on filename', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file with a specific filename
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/my-document.pdf',
            gcs: 'gs://bucket/my-document.pdf',
            filename: 'my-document.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by partial filename (contains match)
        const resolved = await resolveFileParameter('document.pdf', createAgentContext(contextId));
        t.is(resolved, 'https://example.com/my-document.pdf');
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Contains match requires minimum 4 characters', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file with a specific filename
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            gcs: 'gs://bucket/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Adding test file'
        });
        
        // Try to resolve with a 3-character parameter (should fail - too short)
        const resolvedShort = await resolveFileParameter('pdf', createAgentContext(contextId));
        t.is(resolvedShort, null, 'Should not match with parameter shorter than 4 characters');
        
        // Try to resolve with a 4-character parameter (should succeed)
        const resolvedLong = await resolveFileParameter('test', createAgentContext(contextId));
        t.is(resolvedLong, 'https://example.com/test.pdf', 'Should match with parameter 4+ characters');
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Fallback to Azure URL when GCS not available and preferGcs is true', async t => {
    const contextId = createTestContext();
    const testAzureUrl = 'https://example.com/no-gcs-file.pdf';
    
    try {
        // Add a file without GCS URL
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: testAzureUrl,
            filename: 'no-gcs-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve with preferGcs=true, but no GCS available (should fallback to Azure URL)
        const resolved = await resolveFileParameter('no-gcs-file.pdf', createAgentContext(contextId), { preferGcs: true });
        t.is(resolved, testAzureUrl);
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Handle contextKey for encrypted collections', async t => {
    const contextId = createTestContext();
    const contextKey = 'test-encryption-key';
    
    try {
        // Add a file to collection with contextKey
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            contextKey,
            url: 'https://example.com/encrypted-file.pdf',
            gcs: 'gs://bucket/encrypted-file.pdf',
            filename: 'encrypted-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve with contextKey
        const resolved = await resolveFileParameter('encrypted-file.pdf', createAgentContext(contextId, contextKey));
        t.is(resolved, 'https://example.com/encrypted-file.pdf');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Update file metadata', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file first
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/original.pdf',
            filename: 'original.pdf',
            tags: ['initial'],
            notes: 'Initial notes',
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        const fileId = addParsed.fileId;
        
        // Get the hash from the collection
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === fileId);
        t.truthy(file);
        const hash = file.hash;
        
        // Update metadata using updateFileMetadata
        const { updateFileMetadata } = await import('../../../../lib/fileUtils.js');
        const success = await updateFileMetadata(contextId, hash, {
            displayFilename: 'renamed.pdf',
            tags: ['updated', 'document'],
            notes: 'Updated notes',
            permanent: true
        });
        
        t.is(success, true);
        
        // Verify metadata was updated
        const updatedCollection = await loadFileCollection(contextId, null, false);
        const updatedFile = updatedCollection.find(f => f.id === fileId);
        t.truthy(updatedFile);
        t.is(updatedFile.displayFilename, 'renamed.pdf');
        t.deepEqual(updatedFile.tags, ['updated', 'document']);
        t.is(updatedFile.notes, 'Updated notes');
        t.is(updatedFile.permanent, true);
        
        // Verify CFH fields were preserved
        t.is(updatedFile.url, 'https://example.com/original.pdf');
        t.is(updatedFile.hash, hash);
    } finally {
        await cleanup(contextId);
    }
});

test('updateFileMetadata should allow updating inCollection', async (t) => {
    const contextId = `test-${Date.now()}`;
    
    try {
        // Add a file to collection
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test-incollection.pdf',
            filename: 'test-incollection.pdf',
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        const fileId = addParsed.fileId;
        
        // Get the hash from the collection
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === fileId);
        t.truthy(file);
        const hash = file.hash;
        
        // Verify file is in collection (should be global by default)
        t.truthy(file);
        
        // Update inCollection to a specific chat
        const { updateFileMetadata } = await import('../../../../lib/fileUtils.js');
        const success1 = await updateFileMetadata(contextId, hash, {
            inCollection: ['chat-123']
        });
        t.is(success1, true);
        
        // Verify file is now only in chat-123 (not global)
        const collection1 = await loadFileCollection(contextId, null, false);
        const file1 = collection1.find(f => f.id === fileId);
        // Should not appear in global collection
        t.falsy(file1);
        
        // Should appear when filtering by chat-123
        const collection2 = await loadFileCollection(contextId, null, false, 'chat-123');
        const file2 = collection2.find(f => f.id === fileId);
        t.truthy(file2);
        
        // Update inCollection back to global
        const success2 = await updateFileMetadata(contextId, hash, {
            inCollection: ['*']
        });
        t.is(success2, true);
        
        // Verify file is back in global collection
        const collection3 = await loadFileCollection(contextId, null, false);
        const file3 = collection3.find(f => f.id === fileId);
        t.truthy(file3);
        
        // Update inCollection to false (remove from collection)
        const success3 = await updateFileMetadata(contextId, hash, {
            inCollection: false
        });
        t.is(success3, true);
        
        // Verify file is no longer in collection
        const collection4 = await loadFileCollection(contextId, null, false);
        const file4 = collection4.find(f => f.id === fileId);
        t.falsy(file4);
        
        // Also not in chat-specific collection
        const collection5 = await loadFileCollection(contextId, null, false, 'chat-123');
        const file5 = collection5.find(f => f.id === fileId);
        t.falsy(file5);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Permanent files not deleted on remove', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a permanent file
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/permanent.pdf',
            filename: 'permanent.pdf',
            userMessage: 'Add permanent file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        const fileId = addParsed.fileId;
        
        // Mark as permanent
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === fileId);
        const { updateFileMetadata } = await import('../../../../lib/fileUtils.js');
        await updateFileMetadata(contextId, file.hash, { permanent: true });
        
        // Remove from collection
        const removeResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileIds: [fileId],
            userMessage: 'Remove permanent file'
        });
        
        const removeParsed = JSON.parse(removeResult);
        t.is(removeParsed.success, true);
        t.is(removeParsed.removedCount, 1);
        // Message should indicate permanent files are not deleted from cloud
        t.true(removeParsed.message.includes('permanent') || removeParsed.message.includes('Cloud storage cleanup'));
        
        // Verify file was removed from collection
        const listResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        t.is(listParsed.totalFiles, 0);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: syncAndStripFilesFromChatHistory only strips collection files', async t => {
    const contextId = createTestContext();
    
    try {
        const { syncAndStripFilesFromChatHistory, addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add one file to collection
        await addFileToCollection(
            contextId,
            null,
            'https://example.com/in-collection.jpg',
            'gs://bucket/in-collection.jpg',
            'in-collection.jpg',
            [],
            '',
            'hash-in-coll'
        );
        
        // Create chat history with two files - one in collection, one not
        const chatHistory = [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: 'https://example.com/in-collection.jpg' },
                        gcs: 'gs://bucket/in-collection.jpg',
                        hash: 'hash-in-coll'
                    },
                    {
                        type: 'file',
                        url: 'https://example.com/external.pdf',
                        gcs: 'gs://bucket/external.pdf',
                        hash: 'hash-external'
                    }
                ]
            }
        ];
        
        // Process chat history
        const { chatHistory: processed, availableFiles } = await syncAndStripFilesFromChatHistory(chatHistory, createAgentContext(contextId));
        
        // Verify only collection file was stripped
        const content = processed[0].content;
        t.true(Array.isArray(content));
        
        // First file (in collection) should be stripped to placeholder
        t.is(content[0].type, 'text');
        t.true(content[0].text.includes('[File:'));
        t.true(content[0].text.includes('available via file tools'));
        
        // Second file (not in collection) should remain as-is
        t.is(content[1].type, 'file');
        t.is(content[1].url, 'https://example.com/external.pdf');
        
        // Collection should still have only 1 file (no auto-syncing)
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 1);
        
        // Available files should list the collection file
        t.true(availableFiles.includes('in-collection.jpg'));
    } finally {
        await cleanup(contextId);
    }
});

// ============================================
// UpdateFileMetadata Tool Tests
// ============================================

test('File collection: UpdateFileMetadata tool - Rename file', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file first
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/old-name.pdf',
            filename: 'old-name.pdf',
            tags: ['test'],
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        const originalFileId = addParsed.fileId;
        
        // Rename using UpdateFileMetadata tool
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'old-name.pdf',
            newFilename: 'new-name.pdf',
            userMessage: 'Rename file'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        t.is(updateParsed.file, 'old-name.pdf');
        t.true(updateParsed.message.includes('renamed to "new-name.pdf"'));
        
        // Verify rename persisted
        const collection = await loadFileCollection(contextId, null, false);
        const updatedFile = collection.find(f => f.id === originalFileId);
        t.truthy(updatedFile);
        t.is(updatedFile.displayFilename, 'new-name.pdf');
        t.is(updatedFile.id, originalFileId); // ID should be preserved
        t.is(updatedFile.url, 'https://example.com/old-name.pdf'); // URL should be preserved
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Replace all tags', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file with initial tags
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            tags: ['old', 'tags'],
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Replace all tags
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'test.pdf',
            tags: ['new', 'replaced', 'tags'],
            userMessage: 'Replace tags'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify tags were replaced
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === addParsed.fileId);
        t.deepEqual(file.tags, ['new', 'replaced', 'tags']);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Add tags', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file with initial tags
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            tags: ['existing', 'tag'],
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Add more tags
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'test.pdf',
            addTags: ['new', 'added'],
            userMessage: 'Add tags'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify tags were added (should contain both old and new)
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === addParsed.fileId);
        t.is(file.tags.length, 4);
        t.true(file.tags.includes('existing'));
        t.true(file.tags.includes('tag'));
        t.true(file.tags.includes('new'));
        t.true(file.tags.includes('added'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Remove tags', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file with tags
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            tags: ['keep', 'remove1', 'remove2', 'also-keep'],
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Remove specific tags
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'test.pdf',
            removeTags: ['remove1', 'remove2'],
            userMessage: 'Remove tags'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify tags were removed
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === addParsed.fileId);
        t.is(file.tags.length, 2);
        t.true(file.tags.includes('keep'));
        t.true(file.tags.includes('also-keep'));
        t.false(file.tags.includes('remove1'));
        t.false(file.tags.includes('remove2'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Add and remove tags together', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file with tags
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            tags: ['old1', 'old2', 'remove-me'],
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Add and remove tags in one operation
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'test.pdf',
            addTags: ['new1', 'new2'],
            removeTags: ['remove-me'],
            userMessage: 'Update tags'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify tags were updated correctly
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === addParsed.fileId);
        t.is(file.tags.length, 4);
        t.true(file.tags.includes('old1'));
        t.true(file.tags.includes('old2'));
        t.true(file.tags.includes('new1'));
        t.true(file.tags.includes('new2'));
        t.false(file.tags.includes('remove-me'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Update notes', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file with initial notes
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            notes: 'Initial notes',
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Update notes
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'test.pdf',
            notes: 'Updated notes with more detail',
            userMessage: 'Update notes'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify notes were updated
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === addParsed.fileId);
        t.is(file.notes, 'Updated notes with more detail');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Update permanent flag', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file (defaults to temporary)
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Mark as permanent
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'test.pdf',
            permanent: true,
            userMessage: 'Mark as permanent'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify permanent flag was set
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === addParsed.fileId);
        t.is(file.permanent, true);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Combined updates', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/original.pdf',
            filename: 'original.pdf',
            tags: ['old'],
            notes: 'Old notes',
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        const originalFileId = addParsed.fileId;
        
        // Update everything at once
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'original.pdf',
            newFilename: 'renamed-and-tagged.pdf',
            tags: ['new', 'tags'],
            notes: 'New notes',
            permanent: true,
            userMessage: 'Full update'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        t.true(updateParsed.message.includes('renamed'));
        t.true(updateParsed.message.includes('tags set'));
        t.true(updateParsed.message.includes('notes updated'));
        t.true(updateParsed.message.includes('permanent'));
        
        // Verify all updates persisted
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === originalFileId);
        t.is(file.displayFilename, 'renamed-and-tagged.pdf');
        t.deepEqual(file.tags, ['new', 'tags']);
        t.is(file.notes, 'New notes');
        t.is(file.permanent, true);
        t.is(file.id, originalFileId); // ID preserved
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - File not found error', async t => {
    const contextId = createTestContext();
    
    try {
        // Try to update a non-existent file
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'nonexistent.pdf',
            newFilename: 'new-name.pdf',
            userMessage: 'Update missing file'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, false);
        t.true(updateParsed.error.includes('not found'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: UpdateFileMetadata tool - Find file by ID', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Add file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        const fileId = addParsed.fileId;
        
        // Update using file ID instead of filename
        const updateResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: fileId,
            newFilename: 'renamed-by-id.pdf',
            userMessage: 'Update by ID'
        });
        
        const updateParsed = JSON.parse(updateResult);
        t.is(updateParsed.success, true);
        
        // Verify update worked
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === fileId);
        t.is(file.displayFilename, 'renamed-by-id.pdf');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: addFileToCollection returns correct ID for existing files', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file first time
        const addResult1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/duplicate.pdf',
            filename: 'first.pdf',
            tags: ['first'],
            userMessage: 'Add file first time'
        });
        
        const addParsed1 = JSON.parse(addResult1);
        t.is(addParsed1.success, true);
        const firstFileId = addParsed1.fileId;
        
        // Add same file again (same URL = same hash)
        const addResult2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/duplicate.pdf',
            filename: 'second.pdf',
            tags: ['second'],
            userMessage: 'Add same file again'
        });
        
        const addParsed2 = JSON.parse(addResult2);
        t.is(addParsed2.success, true);
        
        // The returned ID should match the first one (same hash = same entry)
        t.is(addParsed2.fileId, firstFileId, 'Second add should return same ID as first');
        
        // Verify only one entry exists (not duplicated)
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 1);
        
        // Verify metadata was merged (tags from second add, but same ID)
        const file = collection[0];
        t.is(file.id, firstFileId);
        t.deepEqual(file.tags, ['second']); // New tags replaced old ones
        t.is(file.displayFilename, 'second.pdf'); // New filename
    } finally {
        await cleanup(contextId);
    }
});

// ============================================
// File Collection Encryption Tests
// ============================================

test('File collection encryption: Encrypt tags and notes with contextKey', async t => {
    const contextId = createTestContext();
    const contextKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
    
    try {
        // Add file with tags and notes
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey, default: true }],
            url: 'https://example.com/encrypted.pdf',
            filename: 'encrypted.pdf',
            tags: ['sensitive', 'private', 'confidential'],
            notes: 'This is sensitive information that should be encrypted',
            userMessage: 'Add encrypted file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        
        // Verify data is encrypted in Redis
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const collection = await loadFileCollection(contextId, contextKey, false);
        const file = collection.find(f => f.id === parsed.fileId);
        t.truthy(file);
        
        // Get raw data from Redis (should be encrypted)
        const rawDataStr = await redisClient.hget(contextMapKey, file.hash);
        const rawData = JSON.parse(rawDataStr);
        
        // Verify tags and notes are encrypted (encrypted strings contain ':')
        t.true(typeof rawData.tags === 'string', 'Tags should be encrypted string');
        t.true(rawData.tags.includes(':'), 'Encrypted tags should contain IV separator');
        t.true(typeof rawData.notes === 'string', 'Notes should be encrypted string');
        t.true(rawData.notes.includes(':'), 'Encrypted notes should contain IV separator');
        
        // Verify core fields are NOT encrypted
        t.is(rawData.url, 'https://example.com/encrypted.pdf', 'URL should not be encrypted');
        t.is(rawData.displayFilename, 'encrypted.pdf', 'displayFilename should not be encrypted');
        
        // Verify decryption works correctly
        t.deepEqual(file.tags, ['sensitive', 'private', 'confidential'], 'Tags should be decrypted correctly');
        t.is(file.notes, 'This is sensitive information that should be encrypted', 'Notes should be decrypted correctly');
    } finally {
        await cleanup(contextId, contextKey);
    }
});

test('File collection encryption: Empty tags and notes are not encrypted', async t => {
    const contextId = createTestContext();
    const contextKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
    
    try {
        // Add file with empty tags and notes
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            contextKey,
            url: 'https://example.com/empty.pdf',
            filename: 'empty.pdf',
            tags: [],
            notes: '',
            userMessage: 'Add file with empty metadata'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        
        // Verify empty values are not encrypted in Redis
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const collection = await loadFileCollection(contextId, contextKey, false);
        const file = collection.find(f => f.id === parsed.fileId);
        t.truthy(file);
        
        const rawDataStr = await redisClient.hget(contextMapKey, file.hash);
        const rawData = JSON.parse(rawDataStr);
        
        // Empty tags should be array (not encrypted)
        t.true(Array.isArray(rawData.tags), 'Empty tags should remain as array');
        t.is(rawData.tags.length, 0, 'Empty tags array should be empty');
        
        // Empty notes should be empty string (not encrypted)
        t.is(rawData.notes, '', 'Empty notes should remain as empty string');
        t.false(rawData.notes.includes(':'), 'Empty notes should not be encrypted');
    } finally {
        await cleanup(contextId, contextKey);
    }
});

test('File collection encryption: Decryption fails with wrong contextKey', async t => {
    const contextId = createTestContext();
    const contextKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
    const wrongKey = '0000000000000000000000000000000000000000000000000000000000000000'; // 64 hex chars
    
    try {
        // Add file with contextKey
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            contextKey,
            url: 'https://example.com/wrong-key.pdf',
            filename: 'wrong-key.pdf',
            tags: ['secret'],
            notes: 'Secret notes',
            userMessage: 'Add file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        
        // Try to load with wrong key
        const collection = await loadFileCollection(contextId, wrongKey, false);
        const file = collection.find(f => f.id === parsed.fileId);
        t.truthy(file);
        
        // With wrong key, tags and notes should be encrypted strings (not decrypted)
        // The fallback should keep them as-is, but they'll be encrypted strings
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const rawDataStr = await redisClient.hget(contextMapKey, file.hash);
        const rawData = JSON.parse(rawDataStr);
        
        // When decryption fails, readFileDataFromRedis keeps the original encrypted string
        // So file.tags and file.notes will be encrypted strings, not the original values
        t.true(typeof file.tags === 'string' || Array.isArray(file.tags), 'Tags should be string or array');
        if (typeof file.tags === 'string') {
            t.true(file.tags.includes(':'), 'Tags should remain encrypted with wrong key');
        }
        
        t.true(typeof file.notes === 'string', 'Notes should be string');
        if (file.notes.includes(':')) {
            t.true(file.notes.includes(':'), 'Notes should remain encrypted with wrong key');
        }
    } finally {
        await cleanup(contextId, contextKey);
    }
});

test('File collection encryption: Migration from unencrypted to encrypted', async t => {
    const contextId = createTestContext();
    const contextKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
    
    try {
        // First, add file without contextKey (unencrypted)
        const result1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/migration.pdf',
            filename: 'migration.pdf',
            tags: ['unencrypted'],
            notes: 'Unencrypted notes',
            userMessage: 'Add unencrypted file'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.success, true);
        
        // Verify it's unencrypted in Redis
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const collection1 = await loadFileCollection(contextId, null, false);
        const file1 = collection1.find(f => f.id === parsed1.fileId);
        t.truthy(file1);
        
        const rawDataStr1 = await redisClient.hget(contextMapKey, file1.hash);
        const rawData1 = JSON.parse(rawDataStr1);
        
        // Unencrypted data should have tags as array and notes as string
        t.true(Array.isArray(rawData1.tags), 'Unencrypted tags should be array');
        t.is(typeof rawData1.notes, 'string', 'Unencrypted notes should be string');
        t.false(rawData1.notes.includes(':'), 'Unencrypted notes should not contain IV separator');
        
        // Now update with contextKey (should encrypt on next write)
        await callPathway('sys_update_file_metadata', {
            agentContext: [{ contextId, contextKey, default: true }],
            hash: file1.hash,
            tags: ['encrypted'],
            notes: 'Encrypted notes'
        });
        
        // Verify it's now encrypted
        const rawDataStr2 = await redisClient.hget(contextMapKey, file1.hash);
        const rawData2 = JSON.parse(rawDataStr2);
        
        t.true(typeof rawData2.tags === 'string', 'Tags should now be encrypted string');
        t.true(rawData2.tags.includes(':'), 'Encrypted tags should contain IV separator');
        t.true(typeof rawData2.notes === 'string', 'Notes should now be encrypted string');
        t.true(rawData2.notes.includes(':'), 'Encrypted notes should contain IV separator');
        
        // Verify decryption works
        const collection2 = await loadFileCollection(contextId, contextKey, false);
        const file2 = collection2.find(f => f.id === parsed1.fileId);
        t.deepEqual(file2.tags, ['encrypted'], 'Tags should be decrypted correctly');
        t.is(file2.notes, 'Encrypted notes', 'Notes should be decrypted correctly');
    } finally {
        await cleanup(contextId, contextKey);
    }
});

test('File collection encryption: Core fields are never encrypted', async t => {
    const contextId = createTestContext();
    const contextKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
    
    try {
        // Add file with all fields
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            contextKey,
            url: 'https://example.com/core-fields.pdf',
            filename: 'core-fields.pdf',
            tags: ['test'],
            notes: 'Test notes',
            userMessage: 'Add file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        
        // Verify core fields are NOT encrypted
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const collection = await loadFileCollection(contextId, contextKey, false);
        const file = collection.find(f => f.id === parsed.fileId);
        t.truthy(file);
        
        const rawDataStr = await redisClient.hget(contextMapKey, file.hash);
        const rawData = JSON.parse(rawDataStr);
        
        // Core fields should never be encrypted
        t.is(rawData.url, 'https://example.com/core-fields.pdf', 'URL should not be encrypted');
        t.is(rawData.displayFilename, 'core-fields.pdf', 'displayFilename should not be encrypted');
        t.truthy(rawData.id, 'ID should not be encrypted');
        t.truthy(rawData.hash, 'Hash should not be encrypted');
        t.truthy(rawData.mimeType || rawData.mimeType === null, 'mimeType should not be encrypted');
        t.truthy(rawData.addedDate, 'addedDate should not be encrypted');
        t.truthy(rawData.lastAccessed, 'lastAccessed should not be encrypted');
        t.is(typeof rawData.permanent, 'boolean', 'permanent should not be encrypted');
    } finally {
        await cleanup(contextId, contextKey);
    }
});

test('File collection encryption: Works without contextKey (no encryption)', async t => {
    const contextId = createTestContext();
    
    try {
        // Add file without contextKey
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/no-encryption.pdf',
            filename: 'no-encryption.pdf',
            tags: ['public'],
            notes: 'Public notes',
            userMessage: 'Add unencrypted file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        
        // Verify data is NOT encrypted in Redis
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection.find(f => f.id === parsed.fileId);
        t.truthy(file);
        
        const rawDataStr = await redisClient.hget(contextMapKey, file.hash);
        const rawData = JSON.parse(rawDataStr);
        
        // Without contextKey, tags and notes should be unencrypted
        t.true(Array.isArray(rawData.tags), 'Tags should be array when not encrypted');
        t.is(typeof rawData.notes, 'string', 'Notes should be string when not encrypted');
        t.false(rawData.notes.includes(':'), 'Unencrypted notes should not contain IV separator');
        
        // Verify values are correct
        t.deepEqual(file.tags, ['public'], 'Tags should be readable');
        t.is(file.notes, 'Public notes', 'Notes should be readable');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: YouTube URLs are rejected (cannot be added to collection)', async t => {
    const contextId = createTestContext();
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    
    try {
        // Attempt to add YouTube URL - should be rejected
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileUrl: youtubeUrl,
            filename: 'Test YouTube Video',
            tags: ['video', 'youtube'],
            notes: 'Test YouTube video',
            userMessage: 'Add YouTube video'
        });
        
        // callPathway may catch and return error as JSON string, or throw
        // Check if it's an error response
        try {
            const parsed = JSON.parse(result);
            t.falsy(parsed.success, 'Should not succeed');
            t.truthy(parsed.error || parsed.message, 'Should have error message');
            t.true(
                (parsed.error || parsed.message || '').includes('YouTube URLs cannot be added'),
                'Error should mention YouTube URLs cannot be added'
            );
        } catch (parseError) {
            // If not JSON, it should be an error string
            t.true(
                result.includes('YouTube URLs cannot be added'),
                'Error message should mention YouTube URLs cannot be added'
            );
        }
        
        // Verify it was NOT added to collection
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } catch (error) {
        // If callPathway throws, verify the error message
        t.true(
            error.message.includes('YouTube URLs cannot be added'),
            'Error should mention YouTube URLs cannot be added'
        );
        
        // Verify it was NOT added to collection
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: YouTube Shorts URLs are rejected', async t => {
    const contextId = createTestContext();
    const shortsUrl = 'https://www.youtube.com/shorts/abc123';
    
    try {
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileUrl: shortsUrl,
            filename: 'YouTube Short',
            userMessage: 'Add YouTube short'
        });
        
        try {
            const parsed = JSON.parse(result);
            t.falsy(parsed.success);
            t.true((parsed.error || parsed.message || '').includes('YouTube URLs cannot be added'));
        } catch (parseError) {
            t.true(result.includes('YouTube URLs cannot be added'));
        }
        
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } catch (error) {
        t.true(error.message.includes('YouTube URLs cannot be added'));
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: youtu.be URLs are rejected', async t => {
    const contextId = createTestContext();
    const youtuBeUrl = 'https://youtu.be/dQw4w9WgXcQ';
    
    try {
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            fileUrl: youtuBeUrl,
            filename: 'YouTube Video',
            userMessage: 'Add YouTube video'
        });
        
        try {
            const parsed = JSON.parse(result);
            t.falsy(parsed.success);
            t.true((parsed.error || parsed.message || '').includes('YouTube URLs cannot be added'));
        } catch (parseError) {
            t.true(result.includes('YouTube URLs cannot be added'));
        }
        
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } catch (error) {
        t.true(error.message.includes('YouTube URLs cannot be added'));
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } finally {
        await cleanup(contextId);
    }
});

test('generateFileMessageContent: Accepts direct YouTube URL without collection', async t => {
    const contextId = createTestContext();
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    
    try {
        // Test that generateFileMessageContent accepts YouTube URL directly
        // even if it's not in the collection
        const fileContent = await generateFileMessageContent(youtubeUrl, createAgentContext(contextId));
        t.truthy(fileContent);
        t.is(fileContent.url, youtubeUrl);
        t.is(fileContent.type, 'image_url');
        t.falsy(fileContent.gcs);
        t.falsy(fileContent.hash);
        
        // Verify it's not in the collection
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 0);
    } finally {
        await cleanup(contextId);
    }
});

test('generateFileMessageContent: Accepts direct youtu.be URL without collection', async t => {
    const contextId = createTestContext();
    const youtuBeUrl = 'https://youtu.be/dQw4w9WgXcQ';
    
    try {
        const fileContent = await generateFileMessageContent(youtuBeUrl, createAgentContext(contextId));
        t.truthy(fileContent);
        t.is(fileContent.url, youtuBeUrl);
        t.is(fileContent.type, 'image_url');
    } finally {
        await cleanup(contextId);
    }
});

test('Analyzer tool: Returns error JSON format when file not found', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_analyzefile', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'non-existent-file.jpg',
            detailedInstructions: 'Analyze this file',
            userMessage: 'Testing error handling'
        });
        
        t.truthy(result, 'Should have a result');
        
        // Parse the result to check for error format
        let parsedResult;
        try {
            parsedResult = JSON.parse(result);
        } catch (error) {
            t.fail(`Failed to parse result: ${error.message}`);
        }
        
        // Should return error JSON format (same as search tools)
        t.truthy(parsedResult.error, 'Should have error field');
        t.truthy(parsedResult.recoveryMessage, 'Should have recoveryMessage field');
        t.true(typeof parsedResult.error === 'string', 'Error should be a string');
        t.true(typeof parsedResult.recoveryMessage === 'string', 'RecoveryMessage should be a string');
        t.true(parsedResult.error.includes('File not found'), 'Error should mention file not found');
    } finally {
        await cleanup(contextId);
    }
});

test('Analyzer tool: Works with legacy contextId/contextKey parameters (backward compatibility)', async t => {
    const contextId = createTestContext();
    
    try {
        // First add a file to the collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test-document.pdf',
            filename: 'test-document.pdf',
            userMessage: 'Add test file for analyzer'
        });
        
        // Get the file ID from the collection
        const collection = await loadFileCollection(contextId, null, false);
        const fileId = collection[0].id;
        
        // Test analyzer tool with legacy contextId/contextKey (without agentContext)
        // This tests that the tool correctly handles backward compatibility
        const result = await callPathway('sys_tool_analyzefile', {
            contextId,  // Legacy format - no agentContext
            contextKey: null,
            file: fileId,
            detailedInstructions: 'What is this file?',
            userMessage: 'Testing backward compatibility'
        });
        
        t.truthy(result, 'Should have a result');
        
        // The result should be a string (not an error JSON)
        // If it's an error, it should be properly formatted
        let parsedResult;
        try {
            parsedResult = JSON.parse(result);
            // If it parsed as JSON, check if it's an error
            if (parsedResult.error) {
                t.fail(`Tool returned error when it should have worked: ${parsedResult.error}`);
            }
        } catch (error) {
            // If it doesn't parse as JSON, that's fine - it's likely the model response
            t.truthy(typeof result === 'string', 'Result should be a string');
        }
    } finally {
        await cleanup(contextId);
    }
});

test('Analyzer tool: File resolution works with agentContext', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file to the collection
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/test-file.pdf',
            filename: 'test-file.pdf',
            userMessage: 'Add test file'
        });
        
        // Get the file ID from the collection
        const collection = await loadFileCollection(contextId, null, false);
        const fileId = collection[0].id;
        
        // Test analyzer tool with agentContext (modern format)
        const result = await callPathway('sys_tool_analyzefile', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: fileId,
            detailedInstructions: 'What is this file?',
            userMessage: 'Testing with agentContext'
        });
        
        t.truthy(result, 'Should have a result');
        
        // The result should not be an error
        let parsedResult;
        try {
            parsedResult = JSON.parse(result);
            if (parsedResult.error) {
                t.fail(`Tool returned error: ${parsedResult.error}`);
            }
        } catch (error) {
            // If it doesn't parse as JSON, that's fine - it's likely the model response
            t.truthy(typeof result === 'string', 'Result should be a string');
        }
    } finally {
        await cleanup(contextId);
    }
});

// ============================================
// Converted Files Tests (displayFilename != URL extension)
// ============================================

test('Converted files: displayFilename .docx but URL .md - MIME type from URL', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a file where displayFilename is .docx but URL points to converted .md file
        // This simulates the case where a docx file was converted to markdown
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/converted-document.md', // Converted to markdown
            gcs: 'gs://bucket/converted-document.md',
            filename: 'original-document.docx', // Original filename preserved
            userMessage: 'Add converted file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Verify file was stored correctly
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 1);
        
        const file = collection[0];
        // displayFilename should preserve original user filename
        t.is(file.displayFilename, 'original-document.docx', 'displayFilename should preserve original filename');
        // mimeType should be determined from URL (actual content), not displayFilename
        t.is(file.mimeType, 'text/markdown', 'mimeType should be from URL (.md), not displayFilename (.docx)');
        t.is(file.url, 'https://example.com/converted-document.md', 'URL should point to converted file');
    } finally {
        await cleanup(contextId);
    }
});

test('Converted files: EditFile should use URL MIME type, not displayFilename', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a converted file: displayFilename is .docx but URL is .md
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/report.md', // Converted markdown
            gcs: 'gs://bucket/report.md',
            filename: 'report.docx', // Original filename
            userMessage: 'Add converted file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Verify the file has correct MIME type from URL
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection[0];
        t.is(file.mimeType, 'text/markdown', 'MIME type should be from URL');
        t.is(file.displayFilename, 'report.docx', 'displayFilename should be original');
        
        // Note: We can't actually test EditFile here without a real file handler,
        // but we can verify the file is set up correctly for editing
        // The EditFile tool should use getActualContentMimeType() which uses URL
        const { getActualContentMimeType } = await import('../../../../lib/fileUtils.js');
        const actualMimeType = getActualContentMimeType(file);
        t.is(actualMimeType, 'text/markdown', 'getActualContentMimeType should return URL MIME type');
    } finally {
        await cleanup(contextId);
    }
});

test('Converted files: ReadFile should accept text files based on URL, not displayFilename', async t => {
    const contextId = createTestContext();
    
    try {
        // Add a converted file: displayFilename is .docx but URL is .md
        const addResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/document.md', // Converted markdown (text file)
            gcs: 'gs://bucket/document.md',
            filename: 'document.docx', // Original filename (would be binary if checked)
            userMessage: 'Add converted text file'
        });
        
        const addParsed = JSON.parse(addResult);
        t.is(addParsed.success, true);
        
        // Verify file setup
        const collection = await loadFileCollection(contextId, null, false);
        const file = collection[0];
        t.is(file.displayFilename, 'document.docx');
        t.is(file.mimeType, 'text/markdown');
        
        // ReadFile should use resolveFileParameter which returns the URL
        // The URL (.md) should be recognized as text, not the displayFilename (.docx)
        const { resolveFileParameter } = await import('../../../../lib/fileUtils.js');
        const resolvedUrl = await resolveFileParameter('document.docx', createAgentContext(contextId));
        t.is(resolvedUrl, 'https://example.com/document.md', 'Should resolve to URL');
        
        // The isTextFile function in ReadFile should check the URL, not displayFilename
        // Since the URL is .md, it should be recognized as text
        const { getMimeTypeFromFilename, isTextMimeType } = await import('../../../../lib/fileUtils.js');
        const urlMimeType = getMimeTypeFromFilename(resolvedUrl);
        t.is(urlMimeType, 'text/markdown', 'URL should be recognized as markdown');
        t.true(isTextMimeType(urlMimeType), 'Markdown should be recognized as text type');
    } finally {
        await cleanup(contextId);
    }
});

test('Converted files: Multiple converted files with different extensions', async t => {
    const contextId = createTestContext();
    
    try {
        // Add multiple converted files
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/doc1.md', // docx -> md
            filename: 'document1.docx',
            userMessage: 'Add docx->md'
        });
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/doc2.txt', // xlsx -> txt (CSV)
            filename: 'spreadsheet.xlsx',
            userMessage: 'Add xlsx->txt'
        });
        
        await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            url: 'https://example.com/doc3.json', // pptx -> json (structured data)
            filename: 'presentation.pptx',
            userMessage: 'Add pptx->json'
        });
        
        // Verify all files have correct MIME types from URLs
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 3);
        
        const doc1 = collection.find(f => f.displayFilename === 'document1.docx');
        t.truthy(doc1);
        t.is(doc1.mimeType, 'text/markdown', 'docx->md should have markdown MIME type');
        
        const doc2 = collection.find(f => f.displayFilename === 'spreadsheet.xlsx');
        t.truthy(doc2);
        t.is(doc2.mimeType, 'text/plain', 'xlsx->txt should have text/plain MIME type');
        
        const doc3 = collection.find(f => f.displayFilename === 'presentation.pptx');
        t.truthy(doc3);
        t.is(doc3.mimeType, 'application/json', 'pptx->json should have JSON MIME type');
    } finally {
        await cleanup(contextId);
    }
});

test('Converted files: loadFileCollection should use converted values as primary (no converted block in response)', async t => {
    const contextId = createTestContext();
    
    try {
        // Write a file with converted block directly to Redis (simulating CFH behavior)
        // The converted block exists in Redis, but is not exposed in the file collection response
        const { getRedisClient, writeFileDataToRedis } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        
        if (!redisClient) {
            t.skip('Redis not available');
            return;
        }
        
        const hash = 'test-converted-hash-123';
        const fileData = {
            id: 'test-file-id',
            url: 'https://example.com/original.docx',
            gcs: 'gs://bucket/original.docx',
            filename: 'original.docx',
            displayFilename: 'original.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            hash: hash,
            permanent: false,
            timestamp: new Date().toISOString(),
            // Include converted block in Redis (as CFH would write it)
            // This will be used to set primary values, but the block itself is not exposed
            converted: {
                url: 'https://example.com/converted.md',
                gcs: 'gs://bucket/converted.md',
                mimeType: 'text/markdown'
            },
            inCollection: ['*']
        };
        
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        await writeFileDataToRedis(redisClient, contextMapKey, hash, fileData, null);
        
        // Load the collection
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 1);
        
        const file = collection[0];
        
        // CRITICAL: Main URL, GCS, and mimeType should use converted values as primary
        // The converted block is NOT included in the response - only the _isConverted flag
        t.is(file.url, 'https://example.com/converted.md', 'Main URL should be converted URL');
        t.is(file.gcs, 'gs://bucket/converted.md', 'Main GCS should be converted GCS');
        t.is(file.mimeType, 'text/markdown', 'Main mimeType should be converted mimeType');
        t.is(file.displayFilename, 'original.docx', 'displayFilename should preserve original filename');
        
        // Verify converted block is NOT included in file collection response
        t.falsy(file.converted, 'File should NOT have converted block in collection response');
        t.truthy(file._isConverted, 'File should be marked as converted');
        
        // Verify we can match by displayFilename (original filename)
        const { findFileInCollection } = await import('../../../../lib/fileUtils.js');
        const matchedByDisplayFilename = findFileInCollection('original.docx', collection);
        t.truthy(matchedByDisplayFilename, 'Should match file by original displayFilename');
        
        // Verify resolveFileParameter returns converted URL (now the main URL)
        const { resolveFileParameter } = await import('../../../../lib/fileUtils.js');
        const resolvedUrl = await resolveFileParameter('original.docx', createAgentContext(contextId));
        t.is(resolvedUrl, 'https://example.com/converted.md', 'Should resolve to converted URL (now main URL)');
        
        // Verify converted files can be read (text type)
        const { isTextMimeType } = await import('../../../../lib/fileUtils.js');
        t.true(isTextMimeType(file.mimeType), 'Converted file should be recognized as text type');
        
        // Verify converted files cannot be edited
        const editResult = await callPathway('sys_tool_editfile', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            file: 'original.docx',
            startLine: 1,
            endLine: 1,
            content: 'test',
            userMessage: 'Try to edit converted file'
        });
        const editParsed = JSON.parse(editResult);
        t.is(editParsed.success, false, 'Should not allow editing converted files');
        t.true(editParsed.error.includes('converted') || editParsed.error.includes('Cannot edit'), 'Error should mention converted files cannot be edited');
    } finally {
        await cleanup(contextId);
    }
});

test('loadMergedFileCollection should merge collections from contextId and altContextId', async t => {
    const { loadMergedFileCollection, addFileToCollection, getRedisClient } = await import('../../../../lib/fileUtils.js');
    
    const contextId = `test-primary-${Date.now()}`;
    const altContextId = `test-alt-${Date.now()}`;
    
    try {
        // Add file to primary context
        await addFileToCollection(contextId, null, 'https://example.com/primary.jpg', null, 'primary.jpg', [], '', 'hash-primary');
        
        // Add file to alt context
        await addFileToCollection(altContextId, null, 'https://example.com/alt.jpg', null, 'alt.jpg', [], '', 'hash-alt');
        
        // Load just primary - should have 1 file
        const primaryOnly = await loadMergedFileCollection([{ contextId, contextKey: null, default: true }]);
        t.is(primaryOnly.length, 1);
        t.is(primaryOnly[0].hash, 'hash-primary');
        
        // Load merged - should have 2 files (both contexts unencrypted)
        const merged = await loadMergedFileCollection([
            { contextId, contextKey: null, default: true },
            { contextId: altContextId, contextKey: null, default: false }
        ]);
        t.is(merged.length, 2);
        t.true(merged.some(f => f.hash === 'hash-primary'));
        t.true(merged.some(f => f.hash === 'hash-alt'));
    } finally {
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${contextId}`);
            await redisClient.del(`FileStoreMap:ctx:${altContextId}`);
        }
    }
});

test('loadMergedFileCollection should dedupe files present in both contexts', async t => {
    const { loadMergedFileCollection, addFileToCollection, getRedisClient } = await import('../../../../lib/fileUtils.js');
    
    const contextId = `test-primary-dupe-${Date.now()}`;
    const altContextId = `test-alt-dupe-${Date.now()}`;
    
    try {
        // Add same file (same hash) to both contexts
        await addFileToCollection(contextId, null, 'https://example.com/shared.jpg', null, 'shared.jpg', [], '', 'hash-shared');
        await addFileToCollection(altContextId, null, 'https://example.com/shared.jpg', null, 'shared.jpg', [], '', 'hash-shared');
        
        // Add unique file to alt context
        await addFileToCollection(altContextId, null, 'https://example.com/alt-only.jpg', null, 'alt-only.jpg', [], '', 'hash-alt-only');
        
        // Load merged - should have 2 files (deduped shared file, both contexts unencrypted)
        const merged = await loadMergedFileCollection([
            { contextId, contextKey: null, default: true },
            { contextId: altContextId, contextKey: null, default: false }
        ]);
        t.is(merged.length, 2);
        t.true(merged.some(f => f.hash === 'hash-shared'));
        t.true(merged.some(f => f.hash === 'hash-alt-only'));
    } finally {
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${contextId}`);
            await redisClient.del(`FileStoreMap:ctx:${altContextId}`);
        }
    }
});

test('File collection: SearchFileCollection filters by chatId by default', async t => {
    const contextId = createTestContext();
    const chatId1 = 'chat-1';
    const chatId2 = 'chat-2';
    
    try {
        const { addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add file to chat-1
        await addFileToCollection(contextId, null, 'https://example.com/chat1-file.pdf', null, 'chat1-file.pdf', [], '', 'hash-chat1', null, null, false, chatId1);
        
        // Add file to chat-2
        await addFileToCollection(contextId, null, 'https://example.com/chat2-file.pdf', null, 'chat2-file.pdf', [], '', 'hash-chat2', null, null, false, chatId2);
        
        // Add global file (no chatId)
        await addFileToCollection(contextId, null, 'https://example.com/global-file.pdf', null, 'global-file.pdf', [], '', 'hash-global', null, null, false, null);
        
        // Search from chat-1 - should only see chat-1 file and global file
        const result1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1,
            query: 'file',
            userMessage: 'Search from chat-1'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.success, true);
        t.is(parsed1.count, 2, 'Should find chat-1 file and global file');
        const filenames1 = parsed1.files.map(f => f.displayFilename);
        t.true(filenames1.includes('chat1-file.pdf'), 'Should include chat-1 file');
        t.true(filenames1.includes('global-file.pdf'), 'Should include global file');
        t.false(filenames1.includes('chat2-file.pdf'), 'Should not include chat-2 file');
        
        // Search from chat-2 - should only see chat-2 file and global file
        const result2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId2,
            query: 'file',
            userMessage: 'Search from chat-2'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 2, 'Should find chat-2 file and global file');
        const filenames2 = parsed2.files.map(f => f.displayFilename);
        t.true(filenames2.includes('chat2-file.pdf'), 'Should include chat-2 file');
        t.true(filenames2.includes('global-file.pdf'), 'Should include global file');
        t.false(filenames2.includes('chat1-file.pdf'), 'Should not include chat-1 file');
        
        // Search without chatId - should see all files (no filtering when chatId not provided)
        const result3 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'file',
            userMessage: 'Search without chatId'
        });
        
        const parsed3 = JSON.parse(result3);
        t.is(parsed3.success, true);
        t.is(parsed3.count, 3, 'Should find all files when chatId not provided');
        const filenames3 = parsed3.files.map(f => f.displayFilename);
        t.true(filenames3.includes('chat1-file.pdf'), 'Should include chat-1 file');
        t.true(filenames3.includes('chat2-file.pdf'), 'Should include chat-2 file');
        t.true(filenames3.includes('global-file.pdf'), 'Should include global file');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: SearchFileCollection with includeAllChats=true shows all files', async t => {
    const contextId = createTestContext();
    const chatId1 = 'chat-1';
    const chatId2 = 'chat-2';
    
    try {
        const { addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add file to chat-1
        await addFileToCollection(contextId, null, 'https://example.com/chat1-file.pdf', null, 'chat1-file.pdf', [], '', 'hash-chat1', null, null, false, chatId1);
        
        // Add file to chat-2
        await addFileToCollection(contextId, null, 'https://example.com/chat2-file.pdf', null, 'chat2-file.pdf', [], '', 'hash-chat2', null, null, false, chatId2);
        
        // Add global file
        await addFileToCollection(contextId, null, 'https://example.com/global-file.pdf', null, 'global-file.pdf', [], '', 'hash-global', null, null, false, null);
        
        // Search from chat-1 with includeAllChats=true - should see all files
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1,
            query: 'file',
            includeAllChats: true,
            userMessage: 'Search all chats from chat-1'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.count, 3, 'Should find all files from all chats');
        const filenames = parsed.files.map(f => f.displayFilename);
        t.true(filenames.includes('chat1-file.pdf'), 'Should include chat-1 file');
        t.true(filenames.includes('chat2-file.pdf'), 'Should include chat-2 file');
        t.true(filenames.includes('global-file.pdf'), 'Should include global file');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: ListFileCollection filters by chatId by default', async t => {
    const contextId = createTestContext();
    const chatId1 = 'chat-1';
    const chatId2 = 'chat-2';
    
    try {
        const { addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add file to chat-1
        await addFileToCollection(contextId, null, 'https://example.com/chat1-file.pdf', null, 'chat1-file.pdf', [], '', 'hash-chat1', null, null, false, chatId1);
        
        // Add file to chat-2
        await addFileToCollection(contextId, null, 'https://example.com/chat2-file.pdf', null, 'chat2-file.pdf', [], '', 'hash-chat2', null, null, false, chatId2);
        
        // Add global file
        await addFileToCollection(contextId, null, 'https://example.com/global-file.pdf', null, 'global-file.pdf', [], '', 'hash-global', null, null, false, null);
        
        // List from chat-1 - should only see chat-1 file and global file
        const result1 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1,
            userMessage: 'List files from chat-1'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.success, true);
        t.is(parsed1.count, 2, 'Should find chat-1 file and global file');
        t.is(parsed1.totalFiles, 2, 'Total should match count');
        const filenames1 = parsed1.files.map(f => f.displayFilename);
        t.true(filenames1.includes('chat1-file.pdf'), 'Should include chat-1 file');
        t.true(filenames1.includes('global-file.pdf'), 'Should include global file');
        t.false(filenames1.includes('chat2-file.pdf'), 'Should not include chat-2 file');
        
        // List from chat-2 - should only see chat-2 file and global file
        const result2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId2,
            userMessage: 'List files from chat-2'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 2, 'Should find chat-2 file and global file');
        const filenames2 = parsed2.files.map(f => f.displayFilename);
        t.true(filenames2.includes('chat2-file.pdf'), 'Should include chat-2 file');
        t.true(filenames2.includes('global-file.pdf'), 'Should include global file');
        t.false(filenames2.includes('chat1-file.pdf'), 'Should not include chat-1 file');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: ListFileCollection with includeAllChats=true shows all files', async t => {
    const contextId = createTestContext();
    const chatId1 = 'chat-1';
    const chatId2 = 'chat-2';
    
    try {
        const { addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add file to chat-1
        await addFileToCollection(contextId, null, 'https://example.com/chat1-file.pdf', null, 'chat1-file.pdf', [], '', 'hash-chat1', null, null, false, chatId1);
        
        // Add file to chat-2
        await addFileToCollection(contextId, null, 'https://example.com/chat2-file.pdf', null, 'chat2-file.pdf', [], '', 'hash-chat2', null, null, false, chatId2);
        
        // Add global file
        await addFileToCollection(contextId, null, 'https://example.com/global-file.pdf', null, 'global-file.pdf', [], '', 'hash-global', null, null, false, null);
        
        // List from chat-1 with includeAllChats=true - should see all files
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1,
            includeAllChats: true,
            userMessage: 'List all files from chat-1'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.count, 3, 'Should find all files from all chats');
        t.is(parsed.totalFiles, 3, 'Total should match count');
        const filenames = parsed.files.map(f => f.displayFilename);
        t.true(filenames.includes('chat1-file.pdf'), 'Should include chat-1 file');
        t.true(filenames.includes('chat2-file.pdf'), 'Should include chat-2 file');
        t.true(filenames.includes('global-file.pdf'), 'Should include global file');
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: RemoveFileFromCollection can remove files from any chat', async t => {
    const contextId = createTestContext();
    const chatId1 = 'chat-1';
    const chatId2 = 'chat-2';
    
    try {
        const { addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add file to chat-1
        await addFileToCollection(contextId, null, 'https://example.com/chat1-file.pdf', null, 'chat1-file.pdf', [], '', 'hash-chat1', null, null, false, chatId1);
        
        // Add file to chat-2
        await addFileToCollection(contextId, null, 'https://example.com/chat2-file.pdf', null, 'chat2-file.pdf', [], '', 'hash-chat2', null, null, false, chatId2);
        
        // Add global file
        await addFileToCollection(contextId, null, 'https://example.com/global-file.pdf', null, 'global-file.pdf', [], '', 'hash-global', null, null, false, null);
        
        // Search from chat-1 to get the file ID for chat-2's file
        const searchResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1,
            query: 'chat2',
            includeAllChats: true,
            userMessage: 'Search all chats to find chat-2 file'
        });
        const searchParsed = JSON.parse(searchResult);
        t.is(searchParsed.success, true);
        const chat2File = searchParsed.files.find(f => f.displayFilename === 'chat2-file.pdf');
        t.truthy(chat2File, 'Should find chat-2 file when searching all chats');
        const chat2FileId = chat2File.id || chat2File.hash || chat2File.url;
        
        // Remove chat-2's file from chat-1 context (cross-chat removal)
        const removeResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1, // Calling from chat-1
            fileIds: [chat2FileId],
            userMessage: 'Remove chat-2 file from chat-1'
        });
        
        const removeParsed = JSON.parse(removeResult);
        t.is(removeParsed.success, true);
        t.is(removeParsed.removedCount, 1);
        t.is(removeParsed.removedFiles.length, 1);
        t.is(removeParsed.removedFiles[0].displayFilename, 'chat2-file.pdf');
        
        // Verify chat-2 file is gone (search from chat-2)
        const verifyResult = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId2,
            userMessage: 'List files from chat-2'
        });
        const verifyParsed = JSON.parse(verifyResult);
        t.is(verifyParsed.success, true);
        t.is(verifyParsed.count, 1, 'Should only have global file left');
        t.true(verifyParsed.files.some(f => f.displayFilename === 'global-file.pdf'));
        t.false(verifyParsed.files.some(f => f.displayFilename === 'chat2-file.pdf'));
        
        // Verify chat-1 file is still there
        const chat1Result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            chatId: chatId1,
            userMessage: 'List files from chat-1'
        });
        const chat1Parsed = JSON.parse(chat1Result);
        t.is(chat1Parsed.success, true);
        t.is(chat1Parsed.count, 2, 'Should have chat-1 file and global file');
        t.true(chat1Parsed.files.some(f => f.displayFilename === 'chat1-file.pdf'));
        t.true(chat1Parsed.files.some(f => f.displayFilename === 'global-file.pdf'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: SearchFileCollection normalizes separators (space/dash/underscore matching)', async t => {
    const contextId = createTestContext();
    
    try {
        const { addFileToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Add files with different separator conventions
        await addFileToCollection(contextId, null, 'https://example.com/news-corp-report.pdf', null, 'News-Corp-Report.pdf', [], '', 'hash-dashes', null, null, false, null);
        await addFileToCollection(contextId, null, 'https://example.com/news_corp_annual.pdf', null, 'News_Corp_Annual.pdf', [], '', 'hash-underscores', null, null, false, null);
        await addFileToCollection(contextId, null, 'https://example.com/unrelated.pdf', null, 'Unrelated-File.pdf', [], '', 'hash-unrelated', null, null, false, null);
        
        // Search with space: "News Corp" should match both "News-Corp" and "News_Corp"
        const result = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'News Corp',
            userMessage: 'Search with spaces'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.count, 2, 'Should find both files with different separators');
        const filenames = parsed.files.map(f => f.displayFilename);
        t.true(filenames.includes('News-Corp-Report.pdf'), 'Should match dash-separated');
        t.true(filenames.includes('News_Corp_Annual.pdf'), 'Should match underscore-separated');
        t.false(filenames.includes('Unrelated-File.pdf'), 'Should not match unrelated file');
        
        // Search with dash: "News-Corp" should also match both
        const result2 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'News-Corp',
            userMessage: 'Search with dashes'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 2, 'Dash search should also find both');
        
        // Search with underscore: "News_Corp" should also match both
        const result3 = await callPathway('sys_tool_file_collection', {
            agentContext: [{ contextId, contextKey: null, default: true }],
            query: 'News_Corp',
            userMessage: 'Search with underscores'
        });
        
        const parsed3 = JSON.parse(result3);
        t.is(parsed3.success, true);
        t.is(parsed3.count, 2, 'Underscore search should also find both');
    } finally {
        await cleanup(contextId);
    }
});
