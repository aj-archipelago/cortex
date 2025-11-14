// fileCollection.test.js
// Integration tests for file collection tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { getvWithDoubleDecryption, setvWithDoubleEncryption } from '../../../../lib/keyValueStorageClient.js';
import { generateFileMessageContent } from '../../../../lib/fileUtils.js';

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
        const collection = JSON.parse(saved);
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
        const collection = JSON.parse(saved);
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
        const collection = JSON.parse(saved);
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

