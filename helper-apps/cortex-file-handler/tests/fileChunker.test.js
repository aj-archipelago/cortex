import { execSync } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import os from "os";
import { dirname, join } from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";

import test from "ava";
import nock from "nock";

import { splitMediaFile, downloadFile } from "../src/fileChunker.js";
import { createTestMediaFile } from "./testUtils.helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Setup: Create test files and mock external services
test.before(async (t) => {
  // Check if ffmpeg is available
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
  } catch (error) {
    console.error(
      "ffmpeg is not installed. Please install it to run these tests.",
    );
    process.exit(1);
  }

  const testDir = join(__dirname, "test-files");
  await fs.mkdir(testDir, { recursive: true });

  try {
    // Create test files of different durations
    const testFile1s = join(testDir, "test-1s.mp3");
    const testFile10s = join(testDir, "test-10s.mp3");
    const testFile600s = join(testDir, "test-600s.mp3");

    await createTestMediaFile(testFile1s, 1);
    await createTestMediaFile(testFile10s, 10);
    await createTestMediaFile(testFile600s, 600);

    // Create large test files
    const testFile1h = join(testDir, "test-1h.mp3");
    const testFile4h = join(testDir, "test-4h.mp3");

    console.log("\nCreating large test files (this may take a while)...");
    await createTestMediaFile(testFile1h, 3600);
    await createTestMediaFile(testFile4h, 14400);

    t.context = {
      testDir,
      testFile1s,
      testFile10s,
      testFile600s,
      testFile1h,
      testFile4h,
    };

    // Setup nock for URL tests with proper headers
    nock("https://example.com")
      .get("/media/test.mp3")
      .replyWithFile(200, testFile10s, {
        "Content-Type": "audio/mpeg",
        "Content-Length": (await fs.stat(testFile10s)).size.toString(),
      })
      .persist();
  } catch (error) {
    console.error("Error during test setup:", error);
    // Clean up any partially created files
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }
    throw error;
  }
});

// Cleanup: Remove test files
test.after.always(async (t) => {
  // Clean up test files
  if (t.context.testDir) {
    try {
      await fs.rm(t.context.testDir, { recursive: true, force: true });
      console.log("Test files cleaned up successfully");
    } catch (error) {
      console.error("Error cleaning up test files:", error);
    }
  }

  // Clean up nock
  nock.cleanAll();
});

// Test successful chunking of a short file
test("successfully chunks short media file", async (t) => {
  const { chunkPromises, chunkOffsets, uniqueOutputPath } =
    await splitMediaFile(t.context.testFile1s);

  t.true(Array.isArray(chunkPromises), "Should return array of promises");
  t.true(Array.isArray(chunkOffsets), "Should return array of offsets");
  t.true(typeof uniqueOutputPath === "string", "Should return output path");

  // Should only create one chunk for 1s file
  t.is(chunkPromises.length, 1, "Should create single chunk for short file");

  // Wait for chunks to process
  const chunkPaths = await Promise.all(chunkPromises);

  // Verify chunk exists
  t.true(existsSync(chunkPaths[0]), "Chunk file should exist");

  // Cleanup
  await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test chunking of a longer file
test("correctly chunks longer media file", async (t) => {
  const { chunkPromises, chunkOffsets, uniqueOutputPath } =
    await splitMediaFile(t.context.testFile600s);

  // For 600s file with 500s chunks, should create 2 chunks
  t.is(chunkPromises.length, 2, "Should create correct number of chunks");
  t.is(chunkOffsets.length, 2, "Should create correct number of offsets");

  // Verify offsets
  t.is(chunkOffsets[0], 0, "First chunk should start at 0");
  t.is(chunkOffsets[1], 500, "Second chunk should start at 500s");

  // Wait for chunks to process
  const chunkPaths = await Promise.all(chunkPromises);

  // Verify all chunks exist
  for (const chunkPath of chunkPaths) {
    t.true(existsSync(chunkPath), "Each chunk file should exist");
  }

  // Cleanup
  await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test custom chunk duration
test("respects custom chunk duration", async (t) => {
  const customDuration = 5; // 5 seconds
  const { chunkPromises, chunkOffsets } = await splitMediaFile(
    t.context.testFile10s,
    customDuration,
  );

  // For 10s file with 5s chunks, should create 2 chunks
  t.is(
    chunkPromises.length,
    2,
    "Should create correct number of chunks for custom duration",
  );
  t.deepEqual(chunkOffsets, [0, 5], "Should have correct offset points");
});

// Test URL-based file processing
test("processes media file from URL", async (t) => {
  const url = "https://example.com/media/test.mp3";
  const { chunkPromises, uniqueOutputPath } = await splitMediaFile(url);

  // Wait for chunks to process
  const chunkPaths = await Promise.all(chunkPromises);

  // Verify chunks were created
  for (const chunkPath of chunkPaths) {
    t.true(
      existsSync(chunkPath),
      "Chunk files should exist for URL-based media",
    );
  }

  // Cleanup
  await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test error handling for invalid files
test("handles invalid media files gracefully", async (t) => {
  const invalidFile = join(t.context.testDir, "invalid.mp3");
  await fs.writeFile(invalidFile, "not a valid mp3 file");

  await t.throwsAsync(async () => splitMediaFile(invalidFile), {
    message: /Error processing media file/,
  });
});

// Test error handling for non-existent files
test("handles non-existent files gracefully", async (t) => {
  const nonExistentFile = join(t.context.testDir, "non-existent.mp3");

  await t.throwsAsync(async () => splitMediaFile(nonExistentFile), {
    message: /Error processing media file/,
  });
});

// Test file download functionality
test("successfully downloads file from URL", async (t) => {
  const url = "https://example.com/media/test.mp3";
  const outputPath = join(os.tmpdir(), "downloaded-test.mp3");

  await downloadFile(url, outputPath);
  t.true(existsSync(outputPath), "Downloaded file should exist");

  // Cleanup
  await fs.unlink(outputPath);
});

// Test error handling for invalid URLs in download
test("handles invalid URLs in download gracefully", async (t) => {
  const invalidUrl = "https://invalid-url-that-does-not-exist.com/test.mp3";
  const outputPath = join(os.tmpdir(), "should-not-exist.mp3");

  await t.throwsAsync(async () => downloadFile(invalidUrl, outputPath));
});

// Helper to format duration nicely
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(2)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(2)}h`;
}

// Test performance with 1-hour file
test("performance test - 1 hour file", async (t) => {
  const start = performance.now();

  const { chunkPromises, uniqueOutputPath } = await splitMediaFile(
    t.context.testFile1h,
  );

  // Wait for all chunks to complete
  const chunkPaths = await Promise.all(chunkPromises);
  const end = performance.now();
  const duration = end - start;

  console.log(`\n1 hour file processing stats:
    - Total time: ${formatDuration(duration)}
    - Chunks created: ${chunkPaths.length}
    - Average time per chunk: ${formatDuration(duration / chunkPaths.length)}
    - Processing speed: ${(3600 / (duration / 1000)).toFixed(2)}x realtime`);

  t.true(chunkPaths.length > 0, "Should create chunks");
  t.true(duration > 0, "Should measure time");

  // Cleanup
  await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test performance with 4-hour file
test("performance test - 4 hour file", async (t) => {
  const start = performance.now();

  const { chunkPromises, uniqueOutputPath } = await splitMediaFile(
    t.context.testFile4h,
  );

  // Wait for all chunks to complete
  const chunkPaths = await Promise.all(chunkPromises);
  const end = performance.now();
  const duration = end - start;

  console.log(`\n4 hour file processing stats:
    - Total time: ${formatDuration(duration)}
    - Chunks created: ${chunkPaths.length}
    - Average time per chunk: ${formatDuration(duration / chunkPaths.length)}
    - Processing speed: ${(14400 / (duration / 1000)).toFixed(2)}x realtime`);

  t.true(chunkPaths.length > 0, "Should create chunks");
  t.true(duration > 0, "Should measure time");

  // Cleanup
  await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

// Test memory usage during large file processing
test("memory usage during large file processing", async (t) => {
  const initialMemory = process.memoryUsage().heapUsed;
  let peakMemory = initialMemory;

  const interval = setInterval(() => {
    const used = process.memoryUsage().heapUsed;
    peakMemory = Math.max(peakMemory, used);
  }, 100);

  const { chunkPromises, uniqueOutputPath } = await splitMediaFile(
    t.context.testFile4h,
  );
  await Promise.all(chunkPromises);

  clearInterval(interval);

  const memoryIncrease = (peakMemory - initialMemory) / 1024 / 1024; // Convert to MB
  console.log(`\nMemory usage stats:
    - Initial memory: ${(initialMemory / 1024 / 1024).toFixed(2)}MB
    - Peak memory: ${(peakMemory / 1024 / 1024).toFixed(2)}MB
    - Memory increase: ${memoryIncrease.toFixed(2)}MB`);

  t.true(memoryIncrease >= 0, "Should track memory usage");

  // Cleanup
  await fs.rm(uniqueOutputPath, { recursive: true, force: true });
});

test("should chunk video files with .mp3 extension for transcription", async (t) => {
  // Create a test video file (we'll use an MP3 file but rename it to simulate a video)
  const testVideoFile = join(t.context.testDir, "test-video.mp4");
  await fs.copyFile(t.context.testFile10s, testVideoFile);

  const { chunkPromises, chunkOffsets, uniqueOutputPath, chunkBaseName } =
    await splitMediaFile(testVideoFile, 5); // Use 5 second chunks for faster test

  t.true(Array.isArray(chunkPromises), "Should return array of promises");
  t.is(chunkPromises.length, 2, "Should create 2 chunks for 10s file with 5s chunks");
  t.true(Array.isArray(chunkOffsets), "Should return array of offsets");
  t.is(chunkOffsets.length, 2, "Should have 2 offsets");
  t.truthy(uniqueOutputPath, "Should return unique output path");
  
  // Check that the chunk base name has .mp3 extension (not .mp4)
  t.true(chunkBaseName.endsWith('.mp3'), "Chunk base name should end with .mp3 extension");
  t.false(chunkBaseName.endsWith('.mp4'), "Chunk base name should not end with .mp4 extension");

  // Process the chunks
  const chunks = [];
  for (const chunkPromise of chunkPromises) {
    const chunkPath = await chunkPromise;
    chunks.push(chunkPath);
  }

  // Verify all chunks have .mp3 extension
  for (const chunkPath of chunks) {
    t.true(chunkPath.endsWith('.mp3'), `Chunk path should end with .mp3: ${chunkPath}`);
    t.false(chunkPath.endsWith('.mp4'), `Chunk path should not end with .mp4: ${chunkPath}`);
  }

  // Clean up
  try {
    if (uniqueOutputPath && existsSync(uniqueOutputPath)) {
      await fs.rm(uniqueOutputPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.log("Error cleaning up test directory:", err);
  }
});
