import fs from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import test from 'ava';
import XLSX from 'xlsx';

import {
    documentToText,
    easyChunker,
    xlsxToCsv,
    convertDocument,
} from '../docHelper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Setup: Create test documents
test.before(async (t) => {
    const testDir = join(__dirname, 'test-docs');
    await fs.mkdir(testDir, { recursive: true });

    // Create various test files
    const textFile = join(testDir, 'test.txt');
    const largeTextFile = join(testDir, 'large.txt');
    const unicodeFile = join(testDir, 'unicode.txt');
    const jsonFile = join(testDir, 'test.json');
    const emptyFile = join(testDir, 'empty.txt');

    // Regular text content
    await fs.writeFile(
        textFile,
        'This is a test document content.\nIt has multiple lines.\nThird line here.',
    );

    // Large text content (>100KB)
    const largeContent = 'Lorem ipsum '.repeat(10000);
    await fs.writeFile(largeTextFile, largeContent);

    // Unicode content
    const unicodeContent =
    '这是中文内容\nこれは日本語です\nЭто русский текст\n🌟 emoji test';
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
        emptyFile,
    };
});

// Cleanup
test.after.always(async (t) => {
    await fs.rm(t.context.testDir, { recursive: true, force: true });
});

// Test basic text file processing
test('processes text files correctly', async (t) => {
    const result = await documentToText(t.context.textFile, 'text/plain');
    t.true(typeof result === 'string', 'Result should be a string');
    t.true(
        result.includes('test document content'),
        'Result should contain file content',
    );
    t.true(
        result.includes('multiple lines'),
        'Result should preserve multiple lines',
    );
});

// Test large file handling
test('handles large text files', async (t) => {
    const result = await documentToText(t.context.largeTextFile, 'text/plain');
    t.true(result.length > 50000, 'Should handle large files');
    t.true(result.includes('Lorem ipsum'), 'Should contain expected content');
});

// Test Unicode handling
test('handles Unicode content correctly', async (t) => {
    const result = await documentToText(t.context.unicodeFile, 'text/plain');
    t.true(result.includes('这是中文内容'), 'Should preserve Chinese characters');
    t.true(
        result.includes('これは日本語です'),
        'Should preserve Japanese characters',
    );
    t.true(
        result.includes('Это русский текст'),
        'Should preserve Cyrillic characters',
    );
    t.true(result.includes('🌟'), 'Should preserve emoji');
});

// Test JSON file handling
test('rejects JSON files appropriately', async (t) => {
    await t.throwsAsync(
        async () => documentToText(t.context.jsonFile, 'application/json'),
        { message: 'Unsupported file type: json' },
    );
});

// Test empty file handling
test('handles empty files appropriately', async (t) => {
    const result = await documentToText(t.context.emptyFile, 'text/plain');
    t.is(result, '', 'Empty file should return empty string');
});

// Test unsupported file types
test('rejects unsupported file types', async (t) => {
    const unsupportedFile = join(t.context.testDir, 'unsupported.xyz');
    await fs.writeFile(unsupportedFile, 'test content');
    await t.throwsAsync(
        async () => documentToText(unsupportedFile, 'unsupported/type'),
        { message: 'Unsupported file type: xyz' },
    );
});

// Test text chunking functionality
test('chunks text correctly with default settings', (t) => {
    const text = 'This is a test.\nSecond line.\nThird line.\nFourth line.';
    const chunks = easyChunker(text);

    t.true(Array.isArray(chunks), 'Should return an array of chunks');
    t.true(chunks.length > 0, 'Should create at least one chunk');
    t.true(
        chunks.every((chunk) => typeof chunk === 'string'),
        'All chunks should be strings',
    );
});

// Test chunking with very long text
test('handles chunking of long text', (t) => {
    const longText = 'Test sentence. '.repeat(1000);
    const chunks = easyChunker(longText);

    t.true(chunks.length > 1, 'Should split long text into multiple chunks');
    t.true(
        chunks.every((chunk) => chunk.length <= 10000),
        'Each chunk should not exceed max length',
    );
});

// Test chunking with various delimiters
test('respects sentence boundaries in chunking', (t) => {
    const text =
    'First sentence. Second sentence! Third sentence? Fourth sentence.';
    const chunks = easyChunker(text);

    t.true(
        chunks.every(
            (chunk) =>
                chunk.match(/[.!?](\s|$)/) || chunk === chunks[chunks.length - 1],
        ),
        'Chunks should end with sentence delimiters when possible',
    );
});

// Test chunking with newlines
test('handles newlines in chunking', (t) => {
    const text = 'Line 1\nLine 2\nLine 3\nLine 4';
    const chunks = easyChunker(text);

    t.true(
        chunks.some((chunk) => chunk.includes('\n')),
        'Should preserve newlines',
    );
});

// Test chunking edge cases
test('handles chunking edge cases', (t) => {
    // Empty string
    t.deepEqual(easyChunker(''), [''], 'Should handle empty string');

    // Single character
    t.deepEqual(easyChunker('a'), ['a'], 'Should handle single character');

    // Only whitespace
    t.deepEqual(
        easyChunker('   \n   '),
        ['   \n   '],
        'Should handle whitespace',
    );
});

// XLSX to CSV Conversion Tests
test('converts XLSX to CSV with multiple sheets', async (t) => {
    const testDir = join(__dirname, 'fixtures');
    await fs.mkdir(testDir, { recursive: true });

    // Create a test XLSX file with multiple sheets
    const workbook = XLSX.utils.book_new();

    // Sheet 1: Simple data
    const ws1 = XLSX.utils.aoa_to_sheet([
        ['Name', 'Age', 'City'],
        ['John', 30, 'New York'],
        ['Alice', 25, 'London'],
        ['Bob', 35, 'Paris'],
    ]);
    XLSX.utils.book_append_sheet(workbook, ws1, 'Sheet1');

    // Sheet 2: Different data
    const ws2 = XLSX.utils.aoa_to_sheet([
        ['Product', 'Price', 'Stock'],
        ['Apple', 1.99, 100],
        ['Banana', 0.99, 200],
        ['Orange', 1.49, 150],
    ]);
    XLSX.utils.book_append_sheet(workbook, ws2, 'Sheet2');

    const testXlsxPath = join(testDir, 'test.xlsx');
    XLSX.writeFile(workbook, testXlsxPath);

    try {
    // Convert the file
        const csvPath = await xlsxToCsv(testXlsxPath);

        // Wait a bit to ensure file is written
        await new Promise((resolve) => setTimeout(resolve, 100));

        const csvContent = await fs.readFile(csvPath, 'utf-8');

        // Verify the content
        t.true(
            csvContent.includes('Sheet: Sheet1'),
            'Should include Sheet1 header',
        );
        t.true(
            csvContent.includes('Sheet: Sheet2'),
            'Should include Sheet2 header',
        );
        t.true(
            csvContent.includes('Name,Age,City'),
            'Should include Sheet1 headers',
        );
        t.true(
            csvContent.includes('Product,Price,Stock'),
            'Should include Sheet2 headers',
        );
        t.true(
            csvContent.includes('John,30,New York'),
            'Should include Sheet1 data',
        );
        t.true(csvContent.includes('Apple,1.99,100'), 'Should include Sheet2 data');

        // Clean up the CSV file
        await fs.unlink(csvPath);
    } finally {
    // Clean up test files
        await fs.rm(testDir, { recursive: true, force: true });
    }
});

test('handles empty sheets in XLSX', async (t) => {
    const testDir = join(__dirname, 'fixtures');
    await fs.mkdir(testDir, { recursive: true });

    // Create a workbook with an empty sheet
    const workbook = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[]]);
    XLSX.utils.book_append_sheet(workbook, ws, 'EmptySheet');

    const emptyXlsxPath = join(testDir, 'empty.xlsx');
    XLSX.writeFile(workbook, emptyXlsxPath);

    try {
        const csvPath = await xlsxToCsv(emptyXlsxPath);

        // Wait a bit to ensure file is written
        await new Promise((resolve) => setTimeout(resolve, 100));

        const csvContent = await fs.readFile(csvPath, 'utf-8');

        t.true(
            csvContent.includes('Sheet: EmptySheet'),
            'Should include sheet name',
        );
        t.is(
            csvContent.trim(),
            'Sheet: EmptySheet',
            'Should only contain sheet name',
        );

        // Clean up the CSV file
        await fs.unlink(csvPath);
    } finally {
        await fs.rm(testDir, { recursive: true, force: true });
    }
});

test('handles special characters in XLSX data', async (t) => {
    const testDir = join(__dirname, 'fixtures');
    await fs.mkdir(testDir, { recursive: true });

    // Create a workbook with special characters
    const workbook = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
        ['Text', 'Special'],
        ['Hello, World!', 'Quotes: "test"'],
        ['Line\nBreak', 'Tab\tHere'],
        ['Comma, in text', 'Semicolon; here'],
    ]);
    XLSX.utils.book_append_sheet(workbook, ws, 'SpecialChars');

    const specialXlsxPath = join(testDir, 'special.xlsx');
    XLSX.writeFile(workbook, specialXlsxPath);

    try {
        const csvPath = await xlsxToCsv(specialXlsxPath);

        // Wait a bit to ensure file is written
        await new Promise((resolve) => setTimeout(resolve, 100));

        const csvContent = await fs.readFile(csvPath, 'utf-8');

        t.true(
            csvContent.includes('Sheet: SpecialChars'),
            'Should include sheet name',
        );
        t.true(
            csvContent.includes('Hello, World!'),
            'Should preserve comma in text',
        );
        t.true(csvContent.includes('Quotes: ""test""'), 'Should preserve quotes');
        t.true(csvContent.includes('Line\nBreak'), 'Should preserve newlines');
        t.true(csvContent.includes('Tab\tHere'), 'Should preserve tabs');

        // Clean up the CSV file
        await fs.unlink(csvPath);
    } finally {
        await fs.rm(testDir, { recursive: true, force: true });
    }
});
