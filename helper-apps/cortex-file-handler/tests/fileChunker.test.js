import test from 'ava';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { splitMediaFile, downloadFile } from '../fileChunker.js';
import nock from 'nock';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper function to create a test media file of specified duration using ffmpeg
async function createTestMediaFile(filepath, durationSeconds = 10) {
    try {
        // Generate silence using ffmpeg
        execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${durationSeconds} -q:a 9 -acodec libmp3lame "${filepath}"`, {
            stdio: 'ignore'
        });
    } catch (error) {
        console.error('Error creating test file:', error);
        throw error;
    }
}

// Setup: Create test files and mock external services
test.before(async t => {
    // Check if ffmpeg is available
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
    } catch (error) {
        console.error('ffmpeg is not installed. Please install it to run these tests.');
        process.exit(1);
    }

    const testDir = join(__dirname, 'test-files');
    await fs.mkdir(testDir, { recursive: true });
    
    // Create test files of different durations
    const testFile1s = join(testDir, 'test-1s.mp3');
    const testFile10s = join(testDir, 'test-10s.mp3');
    const testFile600s = join(testDir, 'test-600s.mp3');
    
    await createTestMediaFile(testFile1s, 1);
    await createTestMediaFile(testFile10s, 10);
    await createTestMediaFile(testFile600s, 600);
    
    t.context = {
        testDir,
        testFile1s,
        testFile10s,
        testFile600s
    };

    // Setup nock for URL tests with proper headers
    nock('https://example.com')
        .get('/media/test.mp3')
        .replyWithFile(200, testFile10s, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': (await fs.stat(testFile10s)).size.toString()
        })
        .persist();
});

// Cleanup: Remove test files
test.after.always(async t => {
    await fs.rm(t.context.testDir, { recursive: true, force: true });
    nock.cleanAll();
});

// Test successful chunking of a short file
test('successfully chunks short media file', async t => {
    const { chunkPromises, chunkOffsets, uniqueOutputPath } = await splitMediaFile(t.context.testFile1s);
    
    t.true(Array.isArray(chunkPromises), 'Should return array of promises');
    t.true(Array.isArray(chunkOffsets), 'Should return array of offsets');
    t.true(typeof uniqueOutputPath === 'string', 'Should return output path');
    
    // Should only create one chunk for 1s file
    t.is(chunkPromises.length, 1, 'Should create single chunk for short file');
    
    // Wait for chunks to process
    const chunkPaths = await Promise.all(chunkPromises);
    
    // Verify chunk exists
    t.true(existsSync(chunkPaths[0]), 'Chunk file should exist');
    
    // Cleanup
    await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test chunking of a longer file
test('correctly chunks longer media file', async t => {
    const { chunkPromises, chunkOffsets, uniqueOutputPath } = await splitMediaFile(t.context.testFile600s);
    
    // For 600s file with 500s chunks, should create 2 chunks
    t.is(chunkPromises.length, 2, 'Should create correct number of chunks');
    t.is(chunkOffsets.length, 2, 'Should create correct number of offsets');
    
    // Verify offsets
    t.is(chunkOffsets[0], 0, 'First chunk should start at 0');
    t.is(chunkOffsets[1], 500, 'Second chunk should start at 500s');
    
    // Wait for chunks to process
    const chunkPaths = await Promise.all(chunkPromises);
    
    // Verify all chunks exist
    for (const chunkPath of chunkPaths) {
        t.true(existsSync(chunkPath), 'Each chunk file should exist');
    }
    
    // Cleanup
    await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test custom chunk duration
test('respects custom chunk duration', async t => {
    const customDuration = 5; // 5 seconds
    const { chunkPromises, chunkOffsets } = await splitMediaFile(t.context.testFile10s, customDuration);
    
    // For 10s file with 5s chunks, should create 2 chunks
    t.is(chunkPromises.length, 2, 'Should create correct number of chunks for custom duration');
    t.deepEqual(chunkOffsets, [0, 5], 'Should have correct offset points');
});

// Test URL-based file processing
test('processes media file from URL', async t => {
    const url = 'https://example.com/media/test.mp3';
    const { chunkPromises, uniqueOutputPath } = await splitMediaFile(url);
    
    // Wait for chunks to process
    const chunkPaths = await Promise.all(chunkPromises);
    
    // Verify chunks were created
    for (const chunkPath of chunkPaths) {
        t.true(existsSync(chunkPath), 'Chunk files should exist for URL-based media');
    }
    
    // Cleanup
    await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test error handling for invalid files
test('handles invalid media files gracefully', async t => {
    const invalidFile = join(t.context.testDir, 'invalid.mp3');
    await fs.writeFile(invalidFile, 'not a valid mp3 file');
    
    await t.throwsAsync(
        async () => splitMediaFile(invalidFile),
        { message: /Error processing media file/ }
    );
});

// Test error handling for non-existent files
test('handles non-existent files gracefully', async t => {
    const nonExistentFile = join(t.context.testDir, 'non-existent.mp3');
    
    await t.throwsAsync(
        async () => splitMediaFile(nonExistentFile),
        { message: /Error processing media file/ }
    );
});

// Test file download functionality
test('successfully downloads file from URL', async t => {
    const url = 'https://example.com/media/test.mp3';
    const outputPath = join(os.tmpdir(), 'downloaded-test.mp3');
    
    await downloadFile(url, outputPath);
    t.true(existsSync(outputPath), 'Downloaded file should exist');
    
    // Cleanup
    await fs.unlink(outputPath);
});

// Test error handling for invalid URLs in download
test('handles invalid URLs in download gracefully', async t => {
    const invalidUrl = 'https://invalid-url-that-does-not-exist.com/test.mp3';
    const outputPath = join(os.tmpdir(), 'should-not-exist.mp3');
    
    await t.throwsAsync(
        async () => downloadFile(invalidUrl, outputPath)
    );
}); 