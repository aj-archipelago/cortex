// fileCollection.test.js
// Integration tests for file collection tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { getvWithDoubleDecryption, setvWithDoubleEncryption } from '../../../../lib/keyValueStorageClient.js';
import { generateFileMessageContent, resolveFileParameter } from '../../../../lib/fileUtils.js';

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
        
        // Verify it was saved
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        t.is(collection.length, 1);
        t.is(collection[0].filename, 'test.jpg');
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
        t.true(parsed.files.some(f => f.filename === 'file1.jpg'));
        t.true(parsed.files.some(f => f.filename === 'file2.pdf'));
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
        t.is(parsed1.files[0].filename, 'report.pdf');
        
        // Search by tag
        const result2 = await callPathway('sys_tool_file_collection', {
            contextId,
            query: 'photo',
            userMessage: 'Search for photo'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.success, true);
        t.is(parsed2.count, 1);
        t.is(parsed2.files[0].filename, 'image.jpg');
        
        // Search by notes
        const result3 = await callPathway('sys_tool_file_collection', {
            contextId,
            query: 'office',
            userMessage: 'Search for office'
        });
        
        const parsed3 = JSON.parse(result3);
        t.is(parsed3.success, true);
        t.is(parsed3.count, 1);
        t.is(parsed3.files[0].filename, 'image.jpg');
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
            fileId: file1Id,
            userMessage: 'Remove file 1'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.removedCount, 1);
        t.is(parsed.remainingFiles, 1);
        t.is(parsed.removedFiles.length, 1);
        t.is(parsed.removedFiles[0].filename, 'file1.jpg');
        // Note: deletedFromCloud may be 0 if file has no hash or deletion fails (which is OK)
        t.true(typeof parsed.deletedFromCloud === 'number');
        
        // Verify it was removed
        const listResult = await callPathway('sys_tool_file_collection', {
            contextId,
            userMessage: 'List files'
        });
        const listParsed = JSON.parse(listResult);
        t.is(listParsed.totalFiles, 1);
        t.false(listParsed.files.some(f => f.filename === 'file1.jpg'));
    } finally {
        await cleanup(contextId);
    }
});

test('File collection: Remove all files', async t => {
    const contextId = createTestContext();
    
    try {
        // Add files
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
            userMessage: 'Add file 2'
        });
        
        // Remove all
        const result = await callPathway('sys_tool_file_collection', {
            contextId,
            fileId: '*',
            userMessage: 'Remove all files'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.removedCount, 2);
        t.is(parsed.remainingFiles, 0);
        t.is(parsed.removedFiles.length, 2);
        t.true(parsed.message.includes('All 2 file(s)'));
        // Note: deletedFromCloud may be 0 if files have no hash or deletion fails (which is OK)
        t.true(typeof parsed.deletedFromCloud === 'number');
        
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
            fileId: 'non-existent-id',
            userMessage: 'Remove file'
        });
        
        const parsed = JSON.parse(result);
        t.is(parsed.success, false);
        t.true(parsed.error.includes('not found in collection'));
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
        t.is(parsed1.files[0].filename, 'a_file.jpg');
        t.is(parsed1.files[1].filename, 'z_file.pdf');
        
        // List filtered by tag
        const result2 = await callPathway('sys_tool_file_collection', {
            contextId,
            tags: ['photo'],
            userMessage: 'List photos'
        });
        
        const parsed2 = JSON.parse(result2);
        t.is(parsed2.count, 1);
        t.is(parsed2.files[0].filename, 'a_file.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('Memory system: memoryFiles excluded from memoryAll', async t => {
    const contextId = createTestContext();
    
    try {
        // Save a file collection
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryFiles',
            aiMemory: JSON.stringify([{
                id: 'test-1',
                url: 'https://example.com/test.jpg',
                filename: 'test.jpg'
            }])
        });
        
        // Save other memory
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memorySelf',
            aiMemory: 'Test memory content'
        });
        
        // Read all memory - should not include memoryFiles
        const allMemory = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryAll'
        });
        
        const parsed = JSON.parse(allMemory);
        t.truthy(parsed.memorySelf);
        t.falsy(parsed.memoryFiles);
        
        // But should be accessible explicitly
        const files = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        
        const filesParsed = JSON.parse(files);
        t.is(filesParsed.length, 1);
        t.is(filesParsed[0].filename, 'test.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('Memory system: memoryFiles not cleared by memoryAll clear', async t => {
    const contextId = createTestContext();
    
    try {
        // Save file collection
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryFiles',
            aiMemory: JSON.stringify([{
                id: 'test-1',
                url: 'https://example.com/test.jpg',
                filename: 'test.jpg'
            }])
        });
        
        // Clear all memory
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryAll',
            aiMemory: ''
        });
        
        // Verify files are still there
        const files = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        
        const filesParsed = JSON.parse(files);
        t.is(filesParsed.length, 1);
        t.is(filesParsed[0].filename, 'test.jpg');
    } finally {
        await cleanup(contextId);
    }
});

test('Memory system: memoryFiles ignored in memoryAll save', async t => {
    const contextId = createTestContext();
    
    try {
        // Save file collection first
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryFiles',
            aiMemory: JSON.stringify([{
                id: 'original',
                cloudUrl: 'https://example.com/original.jpg',
                filename: 'original.jpg'
            }])
        });
        
        // Try to save all memory with memoryFiles included
        await callPathway('sys_save_memory', {
            contextId,
            section: 'memoryAll',
            aiMemory: JSON.stringify({
                memorySelf: 'Test content',
                memoryFiles: JSON.stringify([{
                    id: 'new',
                    url: 'https://example.com/new.jpg',
                    filename: 'new.jpg'
                }])
            })
        });
        
        // Verify original files are still there (not overwritten)
        const files = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        
        const filesParsed = JSON.parse(files);
        t.is(filesParsed.length, 1);
        t.is(filesParsed[0].filename, 'original.jpg');
    } finally {
        await cleanup(contextId);
    }
});

// Test generateFileMessageContent function (integration tests)
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
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        const fileId = collection[0].id;
        
        // Normalize by ID
        const result = await generateFileMessageContent(fileId, contextId);
        
        t.truthy(result);
        t.is(result.type, 'file');
        t.is(result.url, 'https://example.com/test.pdf');
        t.is(result.gcs, 'gs://bucket/test.pdf');
        t.is(result.originalFilename, 'test.pdf');
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
        t.is(result1.originalFilename, 'document.pdf');
        
        // Normalize by full filename
        const result2 = await generateFileMessageContent('image.jpg', contextId);
        t.truthy(result2);
        t.is(result2.originalFilename, 'image.jpg');
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
        
        const saved = await callPathway('sys_read_memory', {
            contextId,
            section: 'memoryFiles'
        });
        const collection = extractFilesFromStored(saved);
        const fileId = collection[0].id;
        
        const result = await generateFileMessageContent(fileId, contextId);
        
        t.truthy(result);
        t.is(result.type, 'image_url');
        t.truthy(result.image_url);
        t.is(result.image_url.url, 'https://example.com/image.jpg');
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

test('resolveFileParameter: Fuzzy filename matching', async t => {
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
        
        // Resolve by partial filename (fuzzy match)
        const resolved = await resolveFileParameter('document.pdf', contextId);
        t.is(resolved, 'https://example.com/my-document.pdf');
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
