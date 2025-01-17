import test from 'ava';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { documentToText, easyChunker } from '../docHelper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Setup: Create test documents
test.before(async t => {
    const testDir = join(__dirname, 'test-docs');
    await fs.mkdir(testDir, { recursive: true });
    
    // Create various test files
    const textFile = join(testDir, 'test.txt');
    const largeTextFile = join(testDir, 'large.txt');
    const unicodeFile = join(testDir, 'unicode.txt');
    const jsonFile = join(testDir, 'test.json');
    const emptyFile = join(testDir, 'empty.txt');
    
    // Regular text content
    await fs.writeFile(textFile, 'This is a test document content.\nIt has multiple lines.\nThird line here.');
    
    // Large text content (>100KB)
    const largeContent = 'Lorem ipsum '.repeat(10000);
    await fs.writeFile(largeTextFile, largeContent);
    
    // Unicode content
    const unicodeContent = '这是中文内容\nこれは日本語です\nЭто русский текст\n🌟 emoji test';
    await fs.writeFile(unicodeFile, unicodeContent);
    
    // JSON content
    await fs.writeFile(jsonFile, JSON.stringify({ test: 'content' }));
    
    // Empty file
    await fs.writeFile(emptyFile, '');

    t.context = {
        testDir,
        textFile,
        largeTextFile,
        unicodeFile,
        jsonFile,
        emptyFile
    };
});

// Cleanup
test.after.always(async t => {
    await fs.rm(t.context.testDir, { recursive: true, force: true });
});

// Test basic text file processing
test('processes text files correctly', async t => {
    const result = await documentToText(t.context.textFile, 'text/plain');
    t.true(typeof result === 'string', 'Result should be a string');
    t.true(result.includes('test document content'), 'Result should contain file content');
    t.true(result.includes('multiple lines'), 'Result should preserve multiple lines');
});

// Test large file handling
test('handles large text files', async t => {
    const result = await documentToText(t.context.largeTextFile, 'text/plain');
    t.true(result.length > 50000, 'Should handle large files');
    t.true(result.includes('Lorem ipsum'), 'Should contain expected content');
});

// Test Unicode handling
test('handles Unicode content correctly', async t => {
    const result = await documentToText(t.context.unicodeFile, 'text/plain');
    t.true(result.includes('这是中文内容'), 'Should preserve Chinese characters');
    t.true(result.includes('これは日本語です'), 'Should preserve Japanese characters');
    t.true(result.includes('Это русский текст'), 'Should preserve Cyrillic characters');
    t.true(result.includes('🌟'), 'Should preserve emoji');
});

// Test JSON file handling
test('rejects JSON files appropriately', async t => {
    await t.throwsAsync(
        async () => documentToText(t.context.jsonFile, 'application/json'),
        { message: 'Unsupported file type: json' }
    );
});

// Test empty file handling
test('handles empty files appropriately', async t => {
    const result = await documentToText(t.context.emptyFile, 'text/plain');
    t.is(result, '', 'Empty file should return empty string');
});

// Test unsupported file types
test('rejects unsupported file types', async t => {
    const unsupportedFile = join(t.context.testDir, 'unsupported.xyz');
    await fs.writeFile(unsupportedFile, 'test content');
    await t.throwsAsync(
        async () => documentToText(unsupportedFile, 'unsupported/type'),
        { message: 'Unsupported file type: xyz' }
    );
});

// Test text chunking functionality
test('chunks text correctly with default settings', t => {
    const text = 'This is a test.\nSecond line.\nThird line.\nFourth line.';
    const chunks = easyChunker(text);
    
    t.true(Array.isArray(chunks), 'Should return an array of chunks');
    t.true(chunks.length > 0, 'Should create at least one chunk');
    t.true(chunks.every(chunk => typeof chunk === 'string'), 'All chunks should be strings');
});

// Test chunking with very long text
test('handles chunking of long text', t => {
    const longText = 'Test sentence. '.repeat(1000);
    const chunks = easyChunker(longText);
    
    t.true(chunks.length > 1, 'Should split long text into multiple chunks');
    t.true(chunks.every(chunk => chunk.length <= 10000), 'Each chunk should not exceed max length');
});

// Test chunking with various delimiters
test('respects sentence boundaries in chunking', t => {
    const text = 'First sentence. Second sentence! Third sentence? Fourth sentence.';
    const chunks = easyChunker(text);
    
    t.true(chunks.every(chunk => 
        chunk.match(/[.!?](\s|$)/) || chunk === chunks[chunks.length - 1]
    ), 'Chunks should end with sentence delimiters when possible');
});

// Test chunking with newlines
test('handles newlines in chunking', t => {
    const text = 'Line 1\nLine 2\nLine 3\nLine 4';
    const chunks = easyChunker(text);
    
    t.true(chunks.some(chunk => chunk.includes('\n')), 'Should preserve newlines');
});

// Test chunking edge cases
test('handles chunking edge cases', t => {
    // Empty string
    t.deepEqual(easyChunker(''), [''], 'Should handle empty string');
    
    // Single character
    t.deepEqual(easyChunker('a'), ['a'], 'Should handle single character');
    
    // Only whitespace
    t.deepEqual(easyChunker('   \n   '), ['   \n   '], 'Should handle whitespace');
}); 