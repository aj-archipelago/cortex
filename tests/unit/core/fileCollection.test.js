// fileCollection.test.js
// Tests for file collection utility functions

import test from 'ava';
import { 
    extractFilesFromChatHistory,
    formatFilesForTemplate
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
    t.is(files[0].filename, 'image.jpg');
    t.is(files[1].url, 'https://example.com/doc.pdf');
    t.is(files[1].gcs, 'gs://bucket/doc.pdf');
    t.is(files[1].filename, 'doc.pdf');
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
            filename: 'image.jpg',
            hash: 'abc123',
            addedDate: '2024-01-01T00:00:00Z',
            lastAccessed: '2024-01-02T00:00:00Z',
            tags: ['photo'],
            notes: 'Test image'
        },
        {
            id: 'file-2',
            url: 'https://example.com/doc.pdf',
            filename: 'doc.pdf',
            hash: 'def456',
            addedDate: '2024-01-02T00:00:00Z',
            lastAccessed: '2024-01-03T00:00:00Z'
        }
    ];
    
    const result = formatFilesForTemplate(collection);
    t.true(result.includes('Hash | Filename | URL | Date Added | Notes'));
    t.true(result.includes('def456 | doc.pdf |'));
    t.true(result.includes('abc123 | image.jpg |'));
    t.true(result.includes('Test image'));
    // Should be sorted by lastAccessed (most recent first)
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
            filename: 'image.jpg',
            addedDate: '2024-01-01T00:00:00Z'
        }
    ];
    
    const result = formatFilesForTemplate(collection);
    t.true(result.includes('Hash | Filename | URL | Date Added | Notes'));
    t.true(result.includes(' | image.jpg |'));
    t.false(result.includes('Azure URL'));
    t.false(result.includes('GCS URL'));
    t.false(result.includes('Tags'));
});

test('formatFilesForTemplate should limit to 10 files and show note', t => {
    const collection = Array.from({ length: 15 }, (_, i) => ({
        id: `file-${i}`,
        filename: `file${i}.txt`,
        hash: `hash${i}`,
        addedDate: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        lastAccessed: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`
    }));
    
    const result = formatFilesForTemplate(collection);
    // Should only show 10 files - count file lines (excluding header, separator, and note)
    const lines = result.split('\n');
    // Find the separator line index
    const separatorIndex = lines.findIndex(line => line.startsWith('-'));
    // Count file lines (between separator and note, or end of result)
    const fileLines = lines.slice(separatorIndex + 1).filter(line => 
        line.includes('|') && !line.startsWith('Note:')
    );
    const fileCount = fileLines.length;
    t.is(fileCount, 10);
    // Should include note about more files
    t.true(result.includes('Note: Showing the last 10 most recently used files'));
    t.true(result.includes('5 more file(s) are available'));
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

test('extractFilesFromChatHistory should extract filename from various fields', t => {
    const testCases = [
        { originalFilename: 'file1.jpg', expected: 'file1.jpg' },
        { name: 'file2.jpg', expected: 'file2.jpg' },
        { filename: 'file3.jpg', expected: 'file3.jpg' },
        { url: 'https://example.com/file4.jpg', expected: null } // Will extract from URL
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
        if (testCase.expected) {
            t.is(files[0].filename, testCase.expected, `Test case ${index} failed`);
        }
    });
});

