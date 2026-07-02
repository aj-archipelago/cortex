// fileCollection.test.js
// Tests for file collection utility functions

import test from 'ava';
import {
    extractFilesFromChatHistory,
    extractFilenameFromUrl,
    ensureFilenameExtension,
    determineMimeTypeFromUrl,
    findFileInCollection,
    getWriteFileAccessTarget,
    getWorkspacePathForFile,
    constructFolderPath,
    normalizeImageDataForUpload,
    getMimeTypeFromFilename,
    getMimeTypeFromExtension,
    isTextMimeType,
} from '../../../lib/fileUtils.js';

function createFileAccessPlan(contextId) {
    return contextId
        ? [{ kind: 'user-global', userContextId: contextId, write: true }]
        : null;
}

test('normalizeImageDataForUpload handles JPEG base64 that looks like an absolute path', t => {
    const buffer = normalizeImageDataForUpload('/9j/');

    t.true(Buffer.isBuffer(buffer));
    t.deepEqual([...buffer], [0xff, 0xd8, 0xff]);
});

test('normalizeImageDataForUpload strips data URL prefixes', t => {
    const buffer = normalizeImageDataForUpload('data:image/png;base64,iVBORw0KGgo=');

    t.true(Buffer.isBuffer(buffer));
    t.deepEqual([...buffer.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

// Test extractFilesFromChatHistory
test('extractFilesFromChatHistory should extract files from array content', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' }, gcs: 'gs://bucket/image.jpg', originalFilename: 'image.jpg' },
                { type: 'file', url: 'https://example.com/doc.pdf', gcs: 'gs://bucket/doc.pdf', originalFilename: 'doc.pdf' }
            ]
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 2);
    t.is(files[0].url, 'https://example.com/image.jpg');
    t.is(files[0].gcs, 'gs://bucket/image.jpg');
    // filename is no longer extracted from messages (displayFilename is set by CFH on upload)
    t.is(files[1].url, 'https://example.com/doc.pdf');
    t.is(files[1].gcs, 'gs://bucket/doc.pdf');
});

test('extractFilesFromChatHistory should extract files from string JSON content', t => {
    const chatHistory = [
        {
            role: 'user',
            content: JSON.stringify({
                type: 'image_url',
                image_url: { url: 'https://example.com/image.jpg' },
                gcs: 'gs://bucket/image.jpg',
                originalFilename: 'image.jpg'
            })
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 1);
    t.is(files[0].url, 'https://example.com/image.jpg');
    t.is(files[0].gcs, 'gs://bucket/image.jpg');
});

test('extractFilesFromChatHistory should extract files from array content with file type', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [
                {
                    type: 'file',
                    url: 'https://example.com/doc.pdf',
                    gcs: 'gs://bucket/doc.pdf',
                    originalFilename: 'doc.pdf',
                    hash: 'abc123'
                }
            ]
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 1);
    t.is(files[0].url, 'https://example.com/doc.pdf');
    t.is(files[0].hash, 'abc123');
});

test('extractFilesFromChatHistory should handle empty chat history', t => {
    t.deepEqual(extractFilesFromChatHistory([]), []);
    t.deepEqual(extractFilesFromChatHistory(null), []);
    t.deepEqual(extractFilesFromChatHistory(undefined), []);
});

test('extractFilesFromChatHistory should handle messages without content', t => {
    const chatHistory = [
        { role: 'user' },
        { role: 'assistant', content: 'Hello' }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 0);
});

test('extractFilesFromChatHistory should handle invalid JSON gracefully', t => {
    const chatHistory = [
        {
            role: 'user',
            content: 'not valid json {'
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 0);
});

test('findFileInCollection should resolve workspace-style paths', t => {
    const collection = [
        {
            id: 'file-1',
            name: 'chats/chat123/abc123_report.pdf',
            filename: 'report.pdf',
            displayFilename: 'report.pdf',
            hash: 'abc123',
            url: 'https://example.blob.core.windows.net/container/chats/chat123/abc123_report.pdf?sig=xyz',
            lastModified: '2024-01-01T00:00:00Z',
        },
    ];

    const found = findFileInCollection('/workspace/files/chats/chat123/abc123_report.pdf', collection);
    t.truthy(found);
    t.is(found.hash, 'abc123');

    // file:// URL (as it arrives in chat history from workspace)
    const foundFileUrl = findFileInCollection('file:///workspace/files/chats/chat123/abc123_report.pdf', collection);
    t.truthy(foundFileUrl);
    t.is(foundFileUrl.hash, 'abc123');
});

test('findFileInCollection should accept /files and relative files paths', t => {
    const collection = [
        {
            id: 'file-2',
            name: 'global/def456_image.png',
            filename: 'image.png',
            displayFilename: 'image.png',
            hash: 'def456',
            url: 'https://example.blob.core.windows.net/container/global/def456_image.png?sig=xyz',
            lastModified: '2024-01-02T00:00:00Z',
        },
    ];

    t.is(findFileInCollection('/files/global/def456_image.png', collection)?.hash, 'def456');
    t.is(findFileInCollection('files/global/def456_image.png', collection)?.hash, 'def456');
});

test('findFileInCollection should fall back to basename when folder is wrong', t => {
    const collection = [
        {
            id: 'file-old',
            name: 'chats/old/aaa111_report.pdf',
            filename: 'report.pdf',
            displayFilename: 'report.pdf',
            hash: 'aaa111',
            url: 'https://example.blob.core.windows.net/container/chats/old/aaa111_report.pdf?sig=old',
            lastModified: '2024-01-01T00:00:00Z',
        },
        {
            id: 'file-new',
            name: 'chats/new/bbb222_report.pdf',
            filename: 'report.pdf',
            displayFilename: 'report.pdf',
            hash: 'bbb222',
            url: 'https://example.blob.core.windows.net/container/chats/new/bbb222_report.pdf?sig=new',
            lastModified: '2024-02-01T00:00:00Z',
        },
    ];

    const found = findFileInCollection('/workspace/files/chats/wrong/report.pdf', collection);
    t.truthy(found);
    t.is(found.hash, 'bbb222');
});

test('getWorkspacePathForFile should prefer blob name with hash prefix', t => {
    const file = {
        name: 'chats/chat123/abc123_report.pdf',
        filename: 'report.pdf',
        displayFilename: 'report.pdf',
    };

    const workspacePath = getWorkspacePathForFile(file, null);
    t.is(workspacePath, '/workspace/files/chats/chat123/abc123_report.pdf');
});

test('getWriteFileAccessTarget should return null when no file access target is writable', t => {
    const target = getWriteFileAccessTarget([
        { kind: 'user-global', userContextId: 'user-readonly', write: false },
    ]);

    t.is(target, null);
});

test('extractFilesFromChatHistory should handle mixed content types', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [
                'Hello',
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' }, gcs: 'gs://bucket/image.jpg' },
                { type: 'text', text: 'Some text' }
            ]
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 1);
    t.is(files[0].url, 'https://example.com/image.jpg');
});

test('extractFilesFromChatHistory should extract files with hash', t => {
    const chatHistory = [
        {
            role: 'user',
            content: {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.jpg' },
                hash: 'abc123def456'
            }
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 1);
    t.is(files[0].hash, 'abc123def456');
});

test('extractFilesFromChatHistory should handle files without gcsUrl', t => {
    const chatHistory = [
        {
            role: 'user',
            content: {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.jpg' }
            }
        }
    ];
    
    const files = extractFilesFromChatHistory(chatHistory);
    t.is(files.length, 1);
    t.is(files[0].gcs, null);
});

test('extractFilesFromChatHistory should extract files without filename (filename no longer extracted from messages)', t => {
    const testCases = [
        { originalFilename: 'file1.jpg' },
        { name: 'file2.jpg' },
        { filename: 'file3.jpg' },
        { url: 'https://example.com/file4.jpg' }
    ];
    
    testCases.forEach((testCase, index) => {
        const chatHistory = [{
            role: 'user',
            content: {
                type: 'image_url',
                image_url: { url: testCase.url || 'https://example.com/test.jpg' },
                ...testCase
            }
        }];
        
        const files = extractFilesFromChatHistory(chatHistory);
        // Files should be extracted but without filename (displayFilename is set by CFH on upload)
        t.is(files.length, 1, `Test case ${index} should extract file`);
        t.is(files[0].url, testCase.url || 'https://example.com/test.jpg');
    });
});

// Test extractFilenameFromUrl
test('extractFilenameFromUrl should return null when no URL provided', t => {
    t.is(extractFilenameFromUrl(null), null);
    t.is(extractFilenameFromUrl(null, null), null);
    t.is(extractFilenameFromUrl(undefined), null);
    t.is(extractFilenameFromUrl(''), null);
});

test('extractFilenameFromUrl should extract filename from Azure URL', t => {
    t.is(extractFilenameFromUrl('https://example.com/file.pdf'), 'file.pdf');
    t.is(extractFilenameFromUrl('https://storage.blob.core.windows.net/container/file.docx'), 'file.docx');
});

test('extractFilenameFromUrl should prefer GCS URL over Azure URL', t => {
    const azureUrl = 'https://example.com/file1.pdf';
    const gcsUrl = 'gs://bucket/file2.pdf';
    t.is(extractFilenameFromUrl(azureUrl, gcsUrl), 'file2.pdf');
});

test('extractFilenameFromUrl should remove query parameters', t => {
    t.is(extractFilenameFromUrl('https://example.com/file.pdf?token=abc123'), 'file.pdf');
    t.is(extractFilenameFromUrl('https://example.com/file.pdf?token=abc&sig=xyz'), 'file.pdf');
});

test('extractFilenameFromUrl should handle URLs without extension', t => {
    t.is(extractFilenameFromUrl('https://example.com/filename'), 'filename');
    t.is(extractFilenameFromUrl('https://example.com/path/to/file'), 'file');
});

// Test ensureFilenameExtension and determineMimeTypeFromUrl (replacing deprecated combineFilenameWithUrlExtension)
test('ensureFilenameExtension should return null when no MIME type', t => {
    t.is(ensureFilenameExtension(null, null), null);
    t.is(ensureFilenameExtension('file.pdf', null), 'file.pdf');
    t.is(ensureFilenameExtension('file.pdf', 'application/octet-stream'), 'file.pdf');
});

test('ensureFilenameExtension should return original filename when no MIME type', t => {
    t.is(ensureFilenameExtension('document.pdf', null), 'document.pdf');
    t.is(ensureFilenameExtension('document.pdf', 'application/octet-stream'), 'document.pdf');
});

test('ensureFilenameExtension should handle empty string filename', t => {
    // Empty string should return null (no filename to work with)
    t.is(ensureFilenameExtension('', 'text/plain'), null);
});

test('ensureFilenameExtension should preserve base name with correct extension from MIME type', t => {
    t.is(ensureFilenameExtension('document.docx', 'application/pdf'), 'document.pdf');
    t.is(ensureFilenameExtension('myfile.txt', 'text/markdown'), 'myfile.md');
    t.is(ensureFilenameExtension('image.jpg', 'image/jpeg'), 'image.jpg'); // Already correct
});

test('ensureFilenameExtension should use MIME type extension when no filename', t => {
    t.is(ensureFilenameExtension(null, 'application/pdf'), null); // Returns null, doesn't generate filename
});

test('determineMimeTypeFromUrl should prefer GCS URL', t => {
    const mimeType1 = determineMimeTypeFromUrl('https://example.com/file.pdf', 'gs://bucket/file.md');
    t.is(mimeType1, 'text/markdown');
    
    const mimeType2 = determineMimeTypeFromUrl('https://example.com/file.pdf', null);
    t.is(mimeType2, 'application/pdf');
});

test('ensureFilenameExtension should handle files without extension', t => {
    t.is(ensureFilenameExtension('document', 'application/pdf'), 'document.pdf');
    t.is(ensureFilenameExtension('document.docx', 'application/octet-stream'), 'document.docx'); // No change for binary
});

test('ensureFilenameExtension should normalize extensions (jpeg->jpg, markdown->md)', t => {
    t.is(ensureFilenameExtension('image.jpeg', 'image/jpeg'), 'image.jpg');
    t.is(ensureFilenameExtension('doc.markdown', 'text/markdown'), 'doc.md');
});

// Test MIME type utilities
test('getMimeTypeFromFilename should detect MIME types from filenames', t => {
    for (const [filename, expectedMimeType] of [
        ['test.pdf', 'application/pdf'],
        ['image.jpg', 'image/jpeg'],
        ['script.js', 'application/javascript'],
        ['readme.md', 'text/markdown'],
        ['data.json', 'application/json'],
        ['page.html', 'text/html'],
        ['data.csv', 'text/csv'],
        ['noextension', 'application/octet-stream'],
    ]) {
        t.is(getMimeTypeFromFilename(filename), expectedMimeType);
    }

    // .xyz files may have a specific MIME type from the library, so we check it's not empty
    const xyzMime = getMimeTypeFromFilename('unknown.xyz');
    t.truthy(xyzMime);
    t.not(xyzMime, '');
});

test('getMimeTypeFromFilename should handle paths', t => {
    for (const [filename, expectedMimeType] of [
        ['/path/to/file.pdf', 'application/pdf'],
        ['folder/subfolder/image.png', 'image/png'],
        ['C:\\Windows\\file.txt', 'text/plain'],
    ]) {
        t.is(getMimeTypeFromFilename(filename), expectedMimeType);
    }
});

test('getMimeTypeFromExtension should detect MIME types from extensions', t => {
    for (const [extension, expectedMimeType] of [
        ['.pdf', 'application/pdf'],
        ['pdf', 'application/pdf'],
        ['.jpg', 'image/jpeg'],
        ['js', 'application/javascript'],
        ['.md', 'text/markdown'],
        ['.json', 'application/json'],
    ]) {
        t.is(getMimeTypeFromExtension(extension), expectedMimeType);
    }

    // .xyz files may have a specific MIME type from the library, so we check it's not empty
    const xyzMime = getMimeTypeFromExtension('.xyz');
    t.truthy(xyzMime);
    t.not(xyzMime, '');
});

test('isTextMimeType should identify text MIME types', t => {
    for (const mimeType of [
        'text/plain',
        'text/html',
        'text/markdown',
        'text/csv',
        'text/javascript',
        'application/json',
        'application/javascript',
        'application/xml',
        'application/x-sh',
        'application/x-python',
    ]) {
        t.true(isTextMimeType(mimeType), `${mimeType} should be treated as text`);
    }

    for (const mimeType of [
        'image/jpeg',
        'image/png',
        'application/pdf',
        'application/octet-stream',
        'video/mp4',
        'audio/mpeg',
        null,
        undefined,
        '',
    ]) {
        t.false(isTextMimeType(mimeType), `${mimeType} should not be treated as text`);
    }
});

// Test converted files: displayFilename has different MIME type than URL
test('determineMimeTypeFromUrl should use URL extension, not displayFilename', async t => {
    const { determineMimeTypeFromUrl } = await import('../../../lib/fileUtils.js');
    
    // Simulate converted file: displayFilename is .docx but URL is .md
    const url = 'https://example.com/converted-file.md';
    const gcs = 'gs://bucket/converted-file.md';
    const displayFilename = 'original-document.docx';
    
    // MIME type should be determined from URL (.md), not displayFilename (.docx)
    const mimeType = determineMimeTypeFromUrl(url, gcs, null);
    t.is(mimeType, 'text/markdown', 'Should use URL extension (.md) for MIME type');
    
    // Even if displayFilename is provided, URL takes precedence
    const mimeType2 = determineMimeTypeFromUrl(url, gcs, displayFilename);
    t.is(mimeType2, 'text/markdown', 'Should still use URL extension even with displayFilename');
});

test('getActualContentMimeType should use URL, not displayFilename', async t => {
    const { getActualContentMimeType } = await import('../../../lib/fileUtils.js');
    
    // Simulate converted file: displayFilename is .docx but URL is .md
    const file = {
        url: 'https://example.com/converted-file.md',
        gcs: 'gs://bucket/converted-file.md',
        displayFilename: 'original-document.docx',
        mimeType: null // Not set yet
    };
    
    const mimeType = getActualContentMimeType(file);
    t.is(mimeType, 'text/markdown', 'Should determine MIME type from URL, not displayFilename');
    
    // If mimeType is already set (from URL), use it
    const fileWithMimeType = {
        ...file,
        mimeType: 'text/markdown'
    };
    const mimeType2 = getActualContentMimeType(fileWithMimeType);
    t.is(mimeType2, 'text/markdown', 'Should use stored mimeType if available');
});

test('addFileToCollection should preserve original displayFilename for converted files', async t => {
    const { addFileToCollection } = await import('../../../lib/fileUtils.js');
    
    // Simulate adding a file where URL points to converted content (.md)
    // but user wants to keep original filename (.docx)
    const contextId = `test-converted-${Date.now()}`;
    const url = 'https://example.com/converted-file.md'; // Converted to markdown
    const originalFilename = 'original-document.docx'; // User's original filename

    try {
        const fileEntry = await addFileToCollection(
            contextId,
            null,
            url,
            originalFilename, // This should be preserved as displayFilename
            null,
            null,
            null
        );
        
        // displayFilename should be the original user-provided filename
        t.is(fileEntry.displayFilename, 'original-document.docx', 'displayFilename should preserve original filename');
        
        // mimeType should be determined from URL (actual content)
        t.is(fileEntry.mimeType, 'text/markdown', 'mimeType should be from URL, not displayFilename');
        
    } finally {
        // Cleanup
        const { getRedisClient } = await import('../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${contextId}`);
        }
    }
});

// Note: Tests that require Redis (adding files to collection) are in integration tests
// These unit tests only test behavior that doesn't require Redis

test('syncAndStripFilesFromChatHistory should leave all files when no contextId', async t => {
    const { syncAndStripFilesFromChatHistory } = await import('../../../lib/fileUtils.js');
    
    const chatHistory = [
        {
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: { url: 'https://example.com/image.jpg' },
                    hash: 'somehash'
                }
            ]
        }
    ];
    
    // No contextId - should leave files in place
    const { chatHistory: processedHistory } = await syncAndStripFilesFromChatHistory(chatHistory, null);
    
    t.is(processedHistory[0].content[0].type, 'image_url');
    t.is(processedHistory[0].content[0].image_url.url, 'https://example.com/image.jpg');
});

test('syncAndStripFilesFromChatHistory should leave files when collection is empty', async t => {
    const { syncAndStripFilesFromChatHistory } = await import('../../../lib/fileUtils.js');
    
    // Use a unique contextId that won't have any files
    const contextId = `test-empty-${Date.now()}`;
    
    const chatHistory = [
        {
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: { url: 'https://example.com/image.jpg' },
                    hash: 'somehash'
                }
            ]
        }
    ];
    
    // Empty collection - files should stay in place (not stripped)
    const { chatHistory: processedHistory } = await syncAndStripFilesFromChatHistory(chatHistory, createFileAccessPlan(contextId));
    
    t.is(processedHistory[0].content[0].type, 'image_url');
    t.is(processedHistory[0].content[0].image_url.url, 'https://example.com/image.jpg');
});

test('syncAndStripFilesFromChatHistory should handle empty chat history', async t => {
    const { syncAndStripFilesFromChatHistory } = await import('../../../lib/fileUtils.js');
    
    const { chatHistory: result1 } = await syncAndStripFilesFromChatHistory([], createFileAccessPlan('context'));
    t.deepEqual(result1, []);
    
    const { chatHistory: result2 } = await syncAndStripFilesFromChatHistory(null, createFileAccessPlan('context'));
    t.deepEqual(result2, []);
});

test('syncAndStripFilesFromChatHistory should preserve non-file content', async t => {
    const { syncAndStripFilesFromChatHistory } = await import('../../../lib/fileUtils.js');
    
    const contextId = `test-preserve-${Date.now()}`;
    
    const chatHistory = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Hello world' },
                {
                    type: 'image_url',
                    image_url: { url: 'https://example.com/image.jpg' },
                    hash: 'somehash'
                }
            ]
        },
        {
            role: 'assistant',
            content: 'I see an image'
        }
    ];
    
    const { chatHistory: processedHistory } = await syncAndStripFilesFromChatHistory(chatHistory, createFileAccessPlan(contextId));
    
    // Text content should be preserved
    t.is(processedHistory[0].content[0].type, 'text');
    t.is(processedHistory[0].content[0].text, 'Hello world');
    
    // Image not in collection should be preserved
    t.is(processedHistory[0].content[1].type, 'image_url');
    
    // Assistant message should be preserved
    t.is(processedHistory[1].role, 'assistant');
    t.is(processedHistory[1].content, 'I see an image');
});

// ============================================================================
// constructFolderPath
// ============================================================================

test('constructFolderPath produces stable folder storage paths', t => {
    const cases = [
        [{}, null],
        [{ userId: 'u1' }, 'global'],
        [{ userId: 'u1', fileScope: 'global' }, 'global'],
        [{ userId: 'u1', fileScope: 'all' }, ''],
        [{ userId: 'u1', chatId: 'c1', fileScope: 'chat' }, 'chats/c1'],
        [{ userId: 'u1', fileScope: 'chat' }, 'global'],
        [{ userId: 'u1', workspaceId: 'w1', fileScope: 'workspace-user-legacy' }, 'applets/w1'],
        [{ contextId: 'applet-user:applet1:u1', fileScope: 'applet-user' }, 'applets/applet1'],
        [{ userId: 'u1', appletId: 'applet1', fileScope: 'applet-user' }, 'applets/applet1'],
        [{ userId: 'u1', fileScope: 'workspace-user-legacy' }, 'global'],
        [{ userId: 'u1', fileScope: 'profile' }, 'profile'],
        [{ userId: 'u1', fileScope: 'articles' }, 'articles'],
        [{ userId: 'u1', fileScope: 'applets' }, 'applets'],
        [{ workspaceId: 'w1', fileScope: 'workspace-shared-legacy' }, ''],
        [{ fileScope: 'workspace-shared-legacy' }, null],
        [{ userId: '../escape', fileScope: 'global' }, 'global'],
        [{ userId: 'u1', chatId: '../bad', fileScope: 'chat' }, null],
    ];

    for (const [input, expected] of cases) {
        t.is(constructFolderPath(input), expected, `Mismatch for input ${JSON.stringify(input)}`);
    }
});
