// fileCollection.test.js
// Tests for file collection utility functions

import test from 'ava';
import { 
    extractFilesFromChatHistory,
    formatFilesForTemplate,
    extractFilenameFromUrl,
    ensureFilenameExtension,
    determineMimeTypeFromUrl
} from '../../../lib/fileUtils.js';

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


// Test formatFilesForTemplate
test('formatFilesForTemplate should format files correctly', t => {
    const collection = [
        {
            id: 'file-1',
            url: 'https://example.com/image.jpg',
            gcs: 'gs://bucket/image.jpg',
            displayFilename: 'image.jpg',
            hash: 'abc123',
            addedDate: '2024-01-01T00:00:00Z',
            lastAccessed: '2024-01-02T00:00:00Z',
            tags: ['photo'],
            notes: 'Test image'
        },
        {
            id: 'file-2',
            url: 'https://example.com/doc.pdf',
            displayFilename: 'doc.pdf',
            hash: 'def456',
            addedDate: '2024-01-02T00:00:00Z',
            lastAccessed: '2024-01-03T00:00:00Z'
        }
    ];
    
    const result = formatFilesForTemplate(collection);
    // Should not include header or notes
    t.false(result.includes('Hash | Filename | URL | Date Added | Notes'));
    t.false(result.includes('Test image'));
    // Should include hash, displayFilename, url, date, and tags
    t.true(result.includes('def456 | doc.pdf | https://example.com/doc.pdf'));
    t.true(result.includes('abc123 | image.jpg | https://example.com/image.jpg'));
    t.true(result.includes('photo')); // tags should be included
    t.true(result.includes('Jan')); // date should be included
    // Should be sorted by lastAccessed (most recently accessed first)
    const docIndex = result.indexOf('def456');
    const imageIndex = result.indexOf('abc123');
    t.true(docIndex < imageIndex, 'More recently accessed file should appear first');
});

test('formatFilesForTemplate should handle empty collection', t => {
    t.is(formatFilesForTemplate([]), 'No files available.');
    t.is(formatFilesForTemplate(null), 'No files available.');
});

test('formatFilesForTemplate should handle files without optional fields', t => {
    const collection = [
        {
            id: 'file-1',
            url: 'https://example.com/image.jpg',
            displayFilename: 'image.jpg',
            addedDate: '2024-01-01T00:00:00Z'
        }
    ];
    
    const result = formatFilesForTemplate(collection);
    // Should not include header
    t.false(result.includes('Hash | Filename | URL | Date Added | Notes'));
    // Should include displayFilename, url, and date even without hash or tags
    t.true(result.includes('image.jpg'));
    t.true(result.includes('https://example.com/image.jpg'));
    // Date should be included (may be 2023 or 2024 due to timezone conversion)
    t.true(result.includes('2023') || result.includes('2024'));
    t.false(result.includes('Azure URL'));
    t.false(result.includes('GCS URL'));
});

test('formatFilesForTemplate should limit to 10 files and show note', t => {
    const collection = Array.from({ length: 15 }, (_, i) => ({
        id: `file-${i}`,
        displayFilename: `file${i}.txt`,
        hash: `hash${i}`,
        url: `https://example.com/file${i}.txt`,
        addedDate: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        lastAccessed: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`
    }));
    
    const result = formatFilesForTemplate(collection);
    // Should only show 10 files - count file lines (excluding the note line)
    const lines = result.split('\n');
    // Count file lines (lines with | that are not the note line)
    const fileLines = lines.filter(line => 
        line.includes('|') && !line.includes('more file(s) available')
    );
    const fileCount = fileLines.length;
    t.is(fileCount, 10);
    // Should include compact note about more files
    t.true(result.includes('more file(s) available'));
    t.true(result.includes('5 more file(s) available'));
    t.true(result.includes('ListFileCollection or SearchFileCollection'));
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
test('getMimeTypeFromFilename should detect MIME types from filenames', async t => {
    const { getMimeTypeFromFilename } = await import('../../../lib/fileUtils.js');
    
    t.is(getMimeTypeFromFilename('test.pdf'), 'application/pdf');
    t.is(getMimeTypeFromFilename('image.jpg'), 'image/jpeg');
    t.is(getMimeTypeFromFilename('script.js'), 'application/javascript');
    t.is(getMimeTypeFromFilename('readme.md'), 'text/markdown');
    t.is(getMimeTypeFromFilename('data.json'), 'application/json');
    t.is(getMimeTypeFromFilename('page.html'), 'text/html');
    t.is(getMimeTypeFromFilename('data.csv'), 'text/csv');
    // .xyz files may have a specific MIME type from the library, so we check it's not empty
    const xyzMime = getMimeTypeFromFilename('unknown.xyz');
    t.truthy(xyzMime);
    t.not(xyzMime, '');
    t.is(getMimeTypeFromFilename('noextension'), 'application/octet-stream');
});

test('getMimeTypeFromFilename should handle paths', async t => {
    const { getMimeTypeFromFilename } = await import('../../../lib/fileUtils.js');
    
    t.is(getMimeTypeFromFilename('/path/to/file.pdf'), 'application/pdf');
    t.is(getMimeTypeFromFilename('folder/subfolder/image.png'), 'image/png');
    t.is(getMimeTypeFromFilename('C:\\Windows\\file.txt'), 'text/plain');
});

test('getMimeTypeFromExtension should detect MIME types from extensions', async t => {
    const { getMimeTypeFromExtension } = await import('../../../lib/fileUtils.js');
    
    t.is(getMimeTypeFromExtension('.pdf'), 'application/pdf');
    t.is(getMimeTypeFromExtension('pdf'), 'application/pdf');
    t.is(getMimeTypeFromExtension('.jpg'), 'image/jpeg');
    t.is(getMimeTypeFromExtension('js'), 'application/javascript');
    t.is(getMimeTypeFromExtension('.md'), 'text/markdown');
    t.is(getMimeTypeFromExtension('.json'), 'application/json');
    // .xyz files may have a specific MIME type from the library, so we check it's not empty
    const xyzMime = getMimeTypeFromExtension('.xyz');
    t.truthy(xyzMime);
    t.not(xyzMime, '');
});

test('isTextMimeType should identify text MIME types', async t => {
    const { isTextMimeType } = await import('../../../lib/fileUtils.js');
    
    // Text types
    t.true(isTextMimeType('text/plain'));
    t.true(isTextMimeType('text/html'));
    t.true(isTextMimeType('text/markdown'));
    t.true(isTextMimeType('text/csv'));
    t.true(isTextMimeType('text/javascript'));
    t.true(isTextMimeType('application/json'));
    t.true(isTextMimeType('application/javascript'));
    t.true(isTextMimeType('application/xml'));
    t.true(isTextMimeType('application/x-sh'));
    t.true(isTextMimeType('application/x-python'));
    
    // Non-text types
    t.false(isTextMimeType('image/jpeg'));
    t.false(isTextMimeType('image/png'));
    t.false(isTextMimeType('application/pdf'));
    t.false(isTextMimeType('application/octet-stream'));
    t.false(isTextMimeType('video/mp4'));
    t.false(isTextMimeType('audio/mpeg'));
    
    // Edge cases
    t.false(isTextMimeType(null));
    t.false(isTextMimeType(undefined));
    t.false(isTextMimeType(''));
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
    const gcs = 'gs://bucket/converted-file.md';
    const originalFilename = 'original-document.docx'; // User's original filename
    
    try {
        const fileEntry = await addFileToCollection(
            contextId,
            null,
            url,
            gcs,
            originalFilename, // This should be preserved as displayFilename
            [],
            '',
            null,
            null,
            null,
            false
        );
        
        // displayFilename should be the original user-provided filename
        t.is(fileEntry.displayFilename, 'original-document.docx', 'displayFilename should preserve original filename');
        
        // mimeType should be determined from URL (actual content)
        t.is(fileEntry.mimeType, 'text/markdown', 'mimeType should be from URL, not displayFilename');
        
        // Verify it was saved correctly
        const { loadFileCollection } = await import('../../../lib/fileUtils.js');
        const collection = await loadFileCollection(contextId, { useCache: false });
        t.is(collection.length, 1);
        t.is(collection[0].displayFilename, 'original-document.docx');
        t.is(collection[0].mimeType, 'text/markdown');
        t.is(collection[0].url, url);
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
    const { chatHistory: processedHistory } = await syncAndStripFilesFromChatHistory(chatHistory, null, null);
    
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
    const { chatHistory: processedHistory } = await syncAndStripFilesFromChatHistory(chatHistory, contextId, null);
    
    t.is(processedHistory[0].content[0].type, 'image_url');
    t.is(processedHistory[0].content[0].image_url.url, 'https://example.com/image.jpg');
});

test('syncAndStripFilesFromChatHistory should handle empty chat history', async t => {
    const { syncAndStripFilesFromChatHistory } = await import('../../../lib/fileUtils.js');
    
    const { chatHistory: result1 } = await syncAndStripFilesFromChatHistory([], 'context', null);
    t.deepEqual(result1, []);
    
    const { chatHistory: result2 } = await syncAndStripFilesFromChatHistory(null, 'context', null);
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
    
    const { chatHistory: processedHistory } = await syncAndStripFilesFromChatHistory(chatHistory, contextId, null);
    
    // Text content should be preserved
    t.is(processedHistory[0].content[0].type, 'text');
    t.is(processedHistory[0].content[0].text, 'Hello world');
    
    // Image not in collection should be preserved
    t.is(processedHistory[0].content[1].type, 'image_url');
    
    // Assistant message should be preserved
    t.is(processedHistory[1].role, 'assistant');
    t.is(processedHistory[1].content, 'I see an image');
});


