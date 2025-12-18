// fileCollection.test.js
// Integration tests for file collection tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { generateFileMessageContent, resolveFileParameter, loadFileCollection } from '../../../../lib/fileUtils.js';

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
            contextId,
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
            contextId,
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        
        await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            tags: ['document'],
            userMessage: 'Add file 2'
        });
        
        // List files
        const result = await callPathway('sys_tool_file_collection', {
            contextId,
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
            contextId,
            url: 'https://example.com/report.pdf',
            filename: 'report.pdf',
            tags: ['document', 'report'],
            notes: 'Monthly report',
            userMessage: 'Add report'
        });
        
        await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/image.jpg',
            filename: 'image.jpg',
            tags: ['photo'],
            notes: 'Photo of office',
            userMessage: 'Add image'
        });
        
        // Search by filename
        const result1 = await callPathway('sys_tool_file_collection', {
            contextId,
            query: 'report',
            userMessage: 'Search for report'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.success, true);
        t.is(parsed1.count, 1);
        t.is(parsed1.files[0].displayFilename, 'report.pdf');
        
        // Search by tag
        const result2 = await callPathway('sys_tool_file_collection', {
            contextId,
            query: 'photo',
            userMessage: 'Search for photo'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 1);
        t.is(parsed2.files[0].displayFilename, 'image.jpg');
        
        // Search by notes
        const result3 = await callPathway('sys_tool_file_collection', {
            contextId,
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

test('File collection: Remove single file', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files
        const addResult1 = await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        const file1Id = JSON.parse(addResult1).fileId;
        
        await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            userMessage: 'Add file 2'
        });
        
        // Remove file1
        const result = await callPathway('sys_tool_file_collection', {
            contextId,
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
        
        // Verify it was removed
        const listResult = await callPathway('sys_tool_file_collection', {
            contextId,
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

test('File collection: Remove multiple files', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files
        const addResult1 = await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/file1.jpg',
            filename: 'file1.jpg',
            userMessage: 'Add file 1'
        });
        const file1Id = JSON.parse(addResult1).fileId;

        const addResult2 = await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/file2.pdf',
            filename: 'file2.pdf',
            userMessage: 'Add file 2'
        });
        const file2Id = JSON.parse(addResult2).fileId;
        
        // Remove multiple files
        const result = await callPathway('sys_tool_file_collection', {
            contextId,
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
            contextId,
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        t.is(listParsed.totalFiles, 0);
    } finally {
        await cleanup(contextId);
    }
});


test('File collection: Error handling - missing contextId', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        url: 'https://example.com/test.jpg',
        filename: 'test.jpg',
        userMessage: 'Test'
    });
    
    const parsed = JSON.parse(result);
    t.is(parsed.success, false);
    t.true(parsed.error.includes('contextId is required'));
});

test('File collection: Error handling - remove non-existent file', async t => {
    const contextId = createTestContext();
    
    try {
        const result = await callPathway('sys_tool_file_collection', {
            contextId,
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
            contextId,
            url: 'https://example.com/file1.jpg',
            filename: 'a_file.jpg',
            tags: ['photo'],
            userMessage: 'Add file 1'
        });
        
        // Wait a bit to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
        
        await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/file2.pdf',
            filename: 'z_file.pdf',
            tags: ['document'],
            userMessage: 'Add file 2'
        });
        
        // List sorted by filename
        const result1 = await callPathway('sys_tool_file_collection', {
            contextId,
            sortBy: 'filename',
            userMessage: 'List sorted by filename'
        });
        
        const parsed1 = JSON.parse(result1);
        t.is(parsed1.files[0].displayFilename, 'a_file.jpg');
        t.is(parsed1.files[1].displayFilename, 'z_file.pdf');
        
        // List filtered by tag
        const result2 = await callPathway('sys_tool_file_collection', {
            contextId,
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

test('Memory system: file collections excluded from memoryAll', async t => {
    const contextId = createTestContext();
    
    try {
        // Save a file collection directly to Redis
        const { saveFileCollection } = await import('../../../../lib/fileUtils.js');
        await saveFileCollection(contextId, null, [{
            id: 'test-1',
            url: 'https://example.com/test.jpg',
            displayFilename: 'test.jpg'
        }]);
        
        // Save other memory
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memorySelf',
            aiMemory: 'Test memory content'
        });
        
        // Read all memory - should not include file collections
        const allMemory = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryAll'
        });
        
        const parsed = JSON.parse(allMemory);
        t.truthy(parsed.memorySelf);
        t.falsy(parsed.memoryFiles);
        
        // But should be accessible via loadFileCollection
        const files = await loadFileCollection(contextId, null, false);
        t.is(files.length, 1);
        t.is(files[0].displayFilename, 'test.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('Memory system: file collections not cleared by memoryAll clear', async t => {
    const contextId = createTestContext();
    
    try {
        // Save file collection directly to Redis
        const { saveFileCollection } = await import('../../../../lib/fileUtils.js');
        await saveFileCollection(contextId, null, [{
            id: 'test-1',
            url: 'https://example.com/test.jpg',
            displayFilename: 'test.jpg'
        }]);
        
        // Clear all memory
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryAll',
            aiMemory: ''
        });
        
        // Verify files are still there (file collections are separate from memory system)
        const files = await loadFileCollection(contextId, null, false);
        t.is(files.length, 1);
        t.is(files[0].displayFilename, 'test.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('Memory system: file collections ignored in memoryAll save', async t => {
    const contextId = createTestContext();
    
    try {
        // Save file collection first directly to Redis
        const { saveFileCollection } = await import('../../../../lib/fileUtils.js');
        await saveFileCollection(contextId, null, [{
            id: 'original',
            url: 'https://example.com/original.jpg',
            displayFilename: 'original.jpg'
        }]);
        
        // Try to save all memory with memoryFiles included (should be ignored)
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryAll',
            aiMemory: JSON.stringify({
                memorySelf: 'Test content',
                memoryFiles: JSON.stringify([{
                    id: 'new',
                    url: 'https://example.com/new.jpg',
                    displayFilename: 'new.jpg'
                }])
            })
        });
        
        // Verify original files are still there (not overwritten - memoryFiles is ignored)
        const files = await loadFileCollection(contextId, null, false);
        t.is(files.length, 1);
        t.is(files[0].displayFilename, 'original.jpg');
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
            contextId,
            url: 'https://example.com/test.pdf',
            gcs: 'gs://bucket/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Add test file'
        });
        
        // Get the file ID from the collection
        const collection = await loadFileCollection(contextId, null, false);
        const fileId = collection[0].id;
        
        // Normalize by ID
        const result = await generateFileMessageContent(fileId, contextId);
        
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
            contextId,
            url: 'https://example.com/test.pdf',
            gcs: 'gs://bucket/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Add test file'
        });
        
        // Normalize by URL
        const result = await generateFileMessageContent('https://example.com/test.pdf', contextId);
        
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
            contextId,
            url: 'https://example.com/document.pdf',
            filename: 'document.pdf',
            userMessage: 'Add document'
        });
        
        await callPathway('sys_tool_file_collection', {
            contextId,
            url: 'https://example.com/image.jpg',
            filename: 'image.jpg',
            userMessage: 'Add image'
        });
        
        // Normalize by partial filename
        const result1 = await generateFileMessageContent('document', contextId);
        t.truthy(result1);
        // originalFilename is no longer returned in message content objects
        t.truthy(result1.url);
        t.truthy(result1.hash);
        
        // Normalize by full filename
        const result2 = await generateFileMessageContent('image.jpg', contextId);
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
            contextId,
            url: 'https://example.com/image.jpg',
            filename: 'image.jpg',
            userMessage: 'Add image'
        });
        
        const collection = await loadFileCollection(contextId, null, false);
        const fileId = collection[0].id;
        
        const result = await generateFileMessageContent(fileId, contextId);
        
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
            contextId,
            url: 'https://example.com/test-doc.pdf',
            gcs: 'gs://bucket/test-doc.pdf',
            filename: 'test-doc.pdf',
            userMessage: 'Adding test file'
        });
        
        const addParsed = JSON.parse(addResult);
        const fileId = addParsed.fileId;
        
        // Resolve by file ID
        const resolved = await resolveFileParameter(fileId, contextId);
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
            contextId,
            url: 'https://example.com/my-file.txt',
            gcs: 'gs://bucket/my-file.txt',
            filename: 'my-file.txt',
            userMessage: 'Adding test file'
        });
        
        // Resolve by filename
        const resolved = await resolveFileParameter('my-file.txt', contextId);
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
            contextId,
            url: 'https://example.com/hashed-file.jpg',
            gcs: 'gs://bucket/hashed-file.jpg',
            filename: 'hashed-file.jpg',
            hash: testHash,
            userMessage: 'Adding test file'
        });
        
        // Resolve by hash
        const resolved = await resolveFileParameter(testHash, contextId);
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
            contextId,
            url: testUrl,
            gcs: 'gs://bucket/existing-file.pdf',
            filename: 'existing-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by Azure URL
        const resolved = await resolveFileParameter(testUrl, contextId);
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
            contextId,
            url: 'https://example.com/gcs-file.pdf',
            gcs: testGcsUrl,
            filename: 'gcs-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by GCS URL
        const resolved = await resolveFileParameter(testGcsUrl, contextId);
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
            contextId,
            url: testAzureUrl,
            gcs: testGcsUrl,
            filename: 'prefer-gcs-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by filename without preferGcs (should return Azure URL)
        const resolvedDefault = await resolveFileParameter('prefer-gcs-file.pdf', contextId);
        t.is(resolvedDefault, testAzureUrl);
        
        // Resolve by filename with preferGcs (should return GCS URL)
        const resolvedGcs = await resolveFileParameter('prefer-gcs-file.pdf', contextId, null, { preferGcs: true });
        t.is(resolvedGcs, testGcsUrl);
    } finally {
        await cleanup(contextId);
    }
});

test('resolveFileParameter: Return null when file not found', async t => {
    const contextId = createTestContext();
    
    try {
        // Try to resolve a non-existent file
        const resolved = await resolveFileParameter('non-existent-file.txt', contextId);
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
        const resolved1 = await resolveFileParameter('', contextId);
        t.is(resolved1, null);
        
        // Try with null
        const resolved2 = await resolveFileParameter(null, contextId);
        t.is(resolved2, null);
        
        // Try with undefined
        const resolved3 = await resolveFileParameter(undefined, contextId);
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
            contextId,
            url: 'https://example.com/my-document.pdf',
            gcs: 'gs://bucket/my-document.pdf',
            filename: 'my-document.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve by partial filename (contains match)
        const resolved = await resolveFileParameter('document.pdf', contextId);
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
            contextId,
            url: 'https://example.com/test.pdf',
            gcs: 'gs://bucket/test.pdf',
            filename: 'test.pdf',
            userMessage: 'Adding test file'
        });
        
        // Try to resolve with a 3-character parameter (should fail - too short)
        const resolvedShort = await resolveFileParameter('pdf', contextId);
        t.is(resolvedShort, null, 'Should not match with parameter shorter than 4 characters');
        
        // Try to resolve with a 4-character parameter (should succeed)
        const resolvedLong = await resolveFileParameter('test', contextId);
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
            contextId,
            url: testAzureUrl,
            filename: 'no-gcs-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve with preferGcs=true, but no GCS available (should fallback to Azure URL)
        const resolved = await resolveFileParameter('no-gcs-file.pdf', contextId, null, { preferGcs: true });
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
            contextId,
            contextKey,
            url: 'https://example.com/encrypted-file.pdf',
            gcs: 'gs://bucket/encrypted-file.pdf',
            filename: 'encrypted-file.pdf',
            userMessage: 'Adding test file'
        });
        
        // Resolve with contextKey
        const resolved = await resolveFileParameter('encrypted-file.pdf', contextId, contextKey);
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
            contextId,
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
            contextId,
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
            contextId,
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
            contextId,
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
            contextId,
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        t.is(listParsed.totalFiles, 0);
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Sync files from chat history', async t => {
    const contextId = createTestContext();
    
    try {
        const { syncFilesToCollection } = await import('../../../../lib/fileUtils.js');
        
        // Create chat history with files
        const chatHistory = [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: 'https://example.com/synced1.jpg' },
                        gcs: 'gs://bucket/synced1.jpg',
                        hash: 'hash1'
                    },
                    {
                        type: 'file',
                        url: 'https://example.com/synced2.pdf',
                        gcs: 'gs://bucket/synced2.pdf',
                        hash: 'hash2'
                    }
                ]
            }
        ];
        
        // Sync files to collection
        await syncFilesToCollection(chatHistory, contextId, null);
        
        // Verify files were added
        const collection = await loadFileCollection(contextId, null, false);
        t.is(collection.length, 2);
        t.true(collection.some(f => f.url === 'https://example.com/synced1.jpg'));
        t.true(collection.some(f => f.url === 'https://example.com/synced2.pdf'));
        
        // Sync again (should update lastAccessed, not duplicate)
        await syncFilesToCollection(chatHistory, contextId, null);
        const collection2 = await loadFileCollection(contextId, null, false);
        t.is(collection2.length, 2); // Should still be 2, not 4
    } finally {
        await cleanup(contextId);
    }
});
