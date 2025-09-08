import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import test from "ava";
import axios from "axios";

import { uploadBlob } from "../src/blobHandler.js";
import { urlExists } from "../src/helper.js";
import { port } from "../src/start.js";
import {
  setFileStoreMap,
  getFileStoreMap,
  removeFromFileStoreMap,
  cleanupRedisFileStoreMapAge,
} from "../src/redis.js";
import { StorageService } from "../src/services/storage/StorageService.js";
import { startTestServer, stopTestServer } from "./testUtils.helper.js";

const __filename = fileURLToPath(import.meta.url);

// Helper function to determine if we should use local storage
function shouldUseLocalStorage() {
  // Use local storage if Azure is not configured
  const useLocal = !process.env.AZURE_STORAGE_CONNECTION_STRING;
  console.log(
    `Debug - AZURE_STORAGE_CONNECTION_STRING: ${process.env.AZURE_STORAGE_CONNECTION_STRING ? "SET" : "NOT SET"}`,
  );
  console.log(`Debug - shouldUseLocalStorage(): ${useLocal}`);
  return useLocal;
}
const __dirname = path.dirname(__filename);

const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to create a test file
async function createTestFile(content, extension = "txt") {
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const filename = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${extension}`;
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Helper function to clean up test files
function cleanupTestFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

// Helper function to create an old timestamp
function createOldTimestamp(daysOld = 8) {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - daysOld);
  return oldDate.toISOString();
}

// Helper function to get requestId from upload result
function getRequestIdFromUploadResult(uploadResult) {
  // Extract requestId from the URL or use a fallback
  if (uploadResult.url) {
    const urlParts = uploadResult.url.split("/");
    const filename = urlParts[urlParts.length - 1];
    // The requestId is the full filename without extension
    const requestId = filename.replace(/\.[^/.]+$/, "");
    console.log(`Extracted requestId: ${requestId} from filename: ${filename}`);
    return requestId;
  }
  return uploadResult.hash || "test-request-id";
}

// Ensure server is ready before tests
test.before(async () => {
  // Start the server with Redis connection setup
  await startTestServer({
    beforeReady: async () => {
      // Ensure Redis is connected
      const { connectClient } = await import("../src/redis.js");
      await connectClient();
    }
  });
});

test.after(async () => {
  // Clean up server with cleanup logic
  await stopTestServer(async () => {
    // Clean up any remaining test entries
    const testKeys = [
      "test-lazy-cleanup",
      "test-age-cleanup",
      "test-old-entry",
    "test-missing-file",
    "test-gcs-backup",
    "test-recent-entry",
    "test-skip-lazy-cleanup",
    "test-no-timestamp",
    "test-malformed",
    "test-checkhash-error",
  ];
  for (const key of testKeys) {
    try {
      await removeFromFileStoreMap(key);
    } catch (error) {
      // Ignore errors
    }
  }

  // Clean up any remaining test files in src/files
  try {
    const fs = await import("fs");
    const path = await import("path");
    const publicFolder = path.join(process.cwd(), "src", "files");

    if (fs.existsSync(publicFolder)) {
      const entries = fs.readdirSync(publicFolder);
      for (const entry of entries) {
        const entryPath = path.join(publicFolder, entry);
        const stat = fs.statSync(entryPath);

        // Only clean up directories that look like test files (LLM-friendly IDs)
        if (stat.isDirectory() && /^[a-z0-9]+-[a-z0-9]+$/.test(entry)) {
          console.log(`Cleaning up test directory: ${entry}`);
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    console.error("Error cleaning up test files:", error);
  }
  });
});

test("lazy cleanup should remove cache entry when file is missing", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile("Test content for lazy cleanup");

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Store the hash in Redis
    const hash = "test-lazy-cleanup";
    await setFileStoreMap(hash, uploadResult);

    // Verify the entry exists (with skipLazyCleanup to avoid interference)
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Cache entry should exist initially");
    t.is(
      initialResult.url,
      uploadResult.url,
      "Cache entry should have correct URL",
    );

    // Delete the actual file from storage using the correct requestId
    const requestId = getRequestIdFromUploadResult(uploadResult);
    console.log(`Attempting to delete file with requestId: ${requestId}`);

    // First verify the file exists
    const fileExistsBeforeDelete = await urlExists(uploadResult.url);
    t.true(fileExistsBeforeDelete.valid, "File should exist before deletion");

    const deleteResponse = await axios.delete(
      `${baseUrl}?operation=delete&requestId=${requestId}`,
      { validateStatus: () => true },
    );
    console.log(
      `Delete response status: ${deleteResponse.status}, body:`,
      deleteResponse.data,
    );
    t.is(deleteResponse.status, 200, "File deletion should succeed");

    // Wait a moment for deletion to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // After deletion, check all storages using StorageService
    const storageService = new StorageService();
    const azureExists = uploadResult.url
      ? await storageService.fileExists(uploadResult.url)
      : false;
    const azureGone = !azureExists;
    const gcsExists = uploadResult.gcs
      ? await storageService.fileExists(uploadResult.gcs)
      : false;
    const gcsGone = !gcsExists;
    console.log(`Debug - uploadResult.url: ${uploadResult.url}`);
    console.log(`Debug - uploadResult.gcs: ${uploadResult.gcs}`);
    console.log(`Debug - azureExists: ${azureExists}, azureGone: ${azureGone}`);
    console.log(`Debug - gcsExists: ${gcsExists}, gcsGone: ${gcsGone}`);
    t.true(azureGone && gcsGone, "File should be deleted from all storages");

    // Now call getFileStoreMap - lazy cleanup should remove the entry
    const resultAfterCleanup = await getFileStoreMap(hash);
    t.is(
      resultAfterCleanup,
      null,
      "Lazy cleanup should remove cache entry for missing file",
    );
  } finally {
    cleanupTestFile(testFile);
  }
});

test("lazy cleanup should keep cache entry when GCS backup exists", async (t) => {
  // This test requires GCS to be configured
  if (!process.env.GOOGLE_CLOUD_STORAGE_BUCKET) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const testFile = await createTestFile("Test content for GCS backup test");

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Verify GCS backup exists
    t.truthy(uploadResult.gcs, "Should have GCS backup URL");

    // Store the hash in Redis
    const hash = "test-gcs-backup";
    await setFileStoreMap(hash, uploadResult);

    // Verify the entry exists initially
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Cache entry should exist initially");

    // Delete the primary file but keep GCS backup
    const requestId = getRequestIdFromUploadResult(uploadResult);
    const deleteResponse = await axios.delete(
      `${baseUrl}?operation=delete&requestId=${requestId}`,
      { validateStatus: () => true },
    );
    t.is(deleteResponse.status, 200, "File deletion should succeed");

    // Wait a moment for deletion to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // After deletion, check all storages using StorageService
    const storageService = new StorageService();
    const azureExists = uploadResult.url
      ? await storageService.fileExists(uploadResult.url)
      : false;
    const azureGone = !azureExists;
    const gcsExists = uploadResult.gcs
      ? await storageService.fileExists(uploadResult.gcs)
      : false;
    const gcsGone = !gcsExists;
    console.log(`Debug - uploadResult.url: ${uploadResult.url}`);
    console.log(`Debug - uploadResult.gcs: ${uploadResult.gcs}`);
    console.log(`Debug - azureExists: ${azureExists}, azureGone: ${azureGone}`);
    console.log(`Debug - gcsExists: ${gcsExists}, gcsGone: ${gcsGone}`);
    t.true(
      azureGone && gcsGone,
      "Primary file should be deleted from all storages",
    );

    // Now call getFileStoreMap - lazy cleanup should keep the entry because GCS backup exists
    const resultAfterCleanup = await getFileStoreMap(hash);
    t.truthy(
      resultAfterCleanup,
      "Lazy cleanup should keep cache entry when GCS backup exists",
    );
    t.is(
      resultAfterCleanup.gcs,
      uploadResult.gcs,
      "GCS backup URL should be preserved",
    );
  } finally {
    cleanupTestFile(testFile);
  }
});

test("age-based cleanup should remove old entries", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile("Test content for age cleanup");

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(context, null, true, testFile); // Use local storage

    // Store the hash in Redis with an old timestamp
    const hash = "test-old-entry";
    const oldEntry = {
      ...uploadResult,
      timestamp: createOldTimestamp(8), // 8 days old
    };
    console.log(`Storing old entry with timestamp: ${oldEntry.timestamp}`);
    await setFileStoreMap(hash, oldEntry);

    // Verify it exists initially (with skipLazyCleanup to avoid interference)
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Old entry should exist initially");

    // Run age-based cleanup with 7-day threshold
    const cleaned = await cleanupRedisFileStoreMapAge(7, 10);
    console.log(
      `Age cleanup returned ${cleaned.length} entries:`,
      cleaned.map((c) => c.hash),
    );

    // Verify the old entry was cleaned up
    t.true(cleaned.length > 0, "Should have cleaned up some entries");
    const cleanedHash = cleaned.find(
      (entry) => entry.hash === "test-old-entry",
    );
    t.truthy(cleanedHash, "Old entry should be in cleaned list");

    // Verify the entry is gone from cache (with skipLazyCleanup to avoid interference)
    const resultAfterCleanup = await getFileStoreMap(hash, true);
    t.is(resultAfterCleanup, null, "Old entry should be removed from cache");
  } finally {
    cleanupTestFile(testFile);
  }
});

test("age-based cleanup should keep recent entries", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile("Test content for recent entry test");

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Store the hash in Redis with a recent timestamp
    const hash = "test-recent-entry";
    const recentEntry = {
      ...uploadResult,
      timestamp: new Date().toISOString(), // Current timestamp
    };
    await setFileStoreMap(hash, recentEntry);

    // Verify it exists initially (with skipLazyCleanup to avoid interference)
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Recent entry should exist initially");

    // Run age-based cleanup with 7-day threshold
    const cleaned = await cleanupRedisFileStoreMapAge(7, 10);

    // Verify the recent entry was NOT cleaned up
    const cleanedHash = cleaned.find(
      (entry) => entry.hash === "test-recent-entry",
    );
    t.falsy(cleanedHash, "Recent entry should not be in cleaned list");

    // Verify the entry still exists in cache
    const resultAfterCleanup = await getFileStoreMap(hash);
    t.truthy(resultAfterCleanup, "Recent entry should still exist in cache");

    // Clean up
    await removeFromFileStoreMap("test-recent-entry");
  } finally {
    cleanupTestFile(testFile);
  }
});

test("age-based cleanup should respect maxEntriesToCheck limit", async (t) => {
  // Create multiple test files and upload them
  const testFiles = [];
  const oldEntries = [];

  try {
    // Create 15 test files
    for (let i = 0; i < 15; i++) {
      const testFile = await createTestFile(
        `Test content for age cleanup ${i}`,
      );
      testFiles.push(testFile);

      const context = { log: console.log };
      const uploadResult = await uploadBlob(
        context,
        null,
        shouldUseLocalStorage(),
        testFile,
      ); // Use appropriate storage

      // Store with old timestamp
      const hash = `test-old-entry-${i}`;
      const oldEntry = {
        ...uploadResult,
        timestamp: createOldTimestamp(8), // 8 days old
      };
      oldEntries.push(oldEntry);
      await setFileStoreMap(hash, oldEntry);
    }

    // Run age-based cleanup with limit of 5 entries
    const cleaned = await cleanupRedisFileStoreMapAge(7, 5);
    console.log(
      `Age cleanup with limit returned ${cleaned.length} entries:`,
      cleaned.map((c) => c.hash),
    );

    // Should only clean up 5 entries due to the limit
    t.is(cleaned.length, 5, "Should only clean up 5 entries due to limit");

    // Verify some entries are still there (with skipLazyCleanup to avoid interference)
    const remainingEntry = await getFileStoreMap("test-old-entry-5", true);
    t.truthy(remainingEntry, "Some old entries should still exist");
  } finally {
    // Clean up test files
    for (const testFile of testFiles) {
      cleanupTestFile(testFile);
    }

    // Clean up remaining entries
    for (let i = 0; i < 15; i++) {
      await removeFromFileStoreMap(`test-old-entry-${i}`);
    }
  }
});

test("getFileStoreMap with skipLazyCleanup should not perform cleanup", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile(
    "Test content for skipLazyCleanup test",
  );

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Store the hash in Redis
    const hash = "test-skip-lazy-cleanup";
    await setFileStoreMap(hash, uploadResult);

    // Verify the entry exists initially
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Cache entry should exist initially");

    // Delete the actual file from storage
    const requestId = getRequestIdFromUploadResult(uploadResult);
    const deleteResponse = await axios.delete(
      `${baseUrl}?operation=delete&requestId=${requestId}`,
      { validateStatus: () => true },
    );
    t.is(deleteResponse.status, 200, "File deletion should succeed");

    // Wait a moment for deletion to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // After deletion, check all storages using StorageService
    const storageService = new StorageService();
    const azureExists = uploadResult.url
      ? await storageService.fileExists(uploadResult.url)
      : false;
    const azureGone = !azureExists;
    const gcsExists = uploadResult.gcs
      ? await storageService.fileExists(uploadResult.gcs)
      : false;
    const gcsGone = !gcsExists;
    console.log(`Debug - uploadResult.url: ${uploadResult.url}`);
    console.log(`Debug - uploadResult.gcs: ${uploadResult.gcs}`);
    console.log(`Debug - azureExists: ${azureExists}, azureGone: ${azureGone}`);
    console.log(`Debug - gcsExists: ${gcsExists}, gcsGone: ${gcsGone}`);
    t.true(azureGone && gcsGone, "File should be deleted from all storages");

    // Call getFileStoreMap with skipLazyCleanup=true - should NOT remove the entry
    const resultWithSkip = await getFileStoreMap(hash, true);
    t.truthy(
      resultWithSkip,
      "Entry should still exist when skipLazyCleanup=true",
    );

    // Call getFileStoreMap without skipLazyCleanup - should remove the entry
    const resultWithoutSkip = await getFileStoreMap(hash, false);
    t.is(
      resultWithoutSkip,
      null,
      "Entry should be removed when skipLazyCleanup=false",
    );
  } finally {
    cleanupTestFile(testFile);
  }
});

test("cleanup should handle entries without timestamps gracefully", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile("Test content for no timestamp test");

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Store the hash in Redis without timestamp
    const hash = "test-no-timestamp";
    const { timestamp, ...entryWithoutTimestamp } = uploadResult;
    console.log(`Storing entry without timestamp:`, entryWithoutTimestamp);

    // Store directly in Redis to avoid timestamp being added
    const { client } = await import("../src/redis.js");
    
    await client.hset(
      "FileStoreMap",
      hash,
      JSON.stringify(entryWithoutTimestamp),
    );

    // Verify it exists initially
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Entry without timestamp should exist initially");
    t.falsy(initialResult.timestamp, "Entry should not have timestamp");

    // Run age-based cleanup - should not crash
    const cleaned = await cleanupRedisFileStoreMapAge(7, 10);

    // Entry without timestamp should not be cleaned up
    const cleanedHash = cleaned.find(
      (entry) => entry.hash === "test-no-timestamp",
    );
    t.falsy(cleanedHash, "Entry without timestamp should not be cleaned up");

    // Verify the entry still exists
    const resultAfterCleanup = await getFileStoreMap(hash, true);
    t.truthy(resultAfterCleanup, "Entry without timestamp should still exist");
  } finally {
    cleanupTestFile(testFile);
  }
});

test("cleanup should handle malformed entries gracefully", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile(
    "Test content for malformed entry test",
  );

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Store the hash in Redis with malformed data
    const malformedKey = "test-malformed";
    const { client } = await import("../src/redis.js");

    await client.hset("FileStoreMap", malformedKey, "this is not json");

    // Verify malformed entry exists
    const initialResult = await getFileStoreMap(malformedKey, true);
    t.truthy(initialResult, "Malformed entry should exist initially");

    // Run age-based cleanup - should not crash
    const cleaned = await cleanupRedisFileStoreMapAge(7, 10);

    // Malformed entry should not be cleaned up (no timestamp)
    const cleanedHash = cleaned.find(
      (entry) => entry.hash === "test-malformed",
    );
    t.falsy(cleanedHash, "Malformed entry should not be cleaned up");

    // Verify the entry still exists
    const resultAfterCleanup = await getFileStoreMap(malformedKey, true);
    t.truthy(resultAfterCleanup, "Malformed entry should still exist");
    
    // Cleanup
    await removeFromFileStoreMap(malformedKey);
  } finally {
    cleanupTestFile(testFile);
  }
});

test("checkHash operation should provide correct error message when files are missing", async (t) => {
  // Create a test file and upload it
  const testFile = await createTestFile(
    "Test content for checkHash error test",
  );

  try {
    const context = { log: console.log };
    const uploadResult = await uploadBlob(
      context,
      null,
      shouldUseLocalStorage(),
      testFile,
    ); // Use appropriate storage

    // Store the hash in Redis
    const hash = "test-checkhash-error";
    await setFileStoreMap(hash, uploadResult);

    // Verify the entry exists initially
    const initialResult = await getFileStoreMap(hash, true);
    t.truthy(initialResult, "Cache entry should exist initially");

    // Delete the actual file from storage
    const requestId = getRequestIdFromUploadResult(uploadResult);
    const deleteResponse = await axios.delete(
      `${baseUrl}?operation=delete&requestId=${requestId}`,
      { validateStatus: () => true },
    );
    t.is(deleteResponse.status, 200, "File deletion should succeed");

    // Wait a moment for deletion to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // After deletion, check all storages using StorageService
    const storageService = new StorageService();
    const azureExists = uploadResult.url
      ? await storageService.fileExists(uploadResult.url)
      : false;
    const azureGone = !azureExists;
    const gcsExists = uploadResult.gcs
      ? await storageService.fileExists(uploadResult.gcs)
      : false;
    const gcsGone = !gcsExists;
    console.log(`Debug - uploadResult.url: ${uploadResult.url}`);
    console.log(`Debug - uploadResult.gcs: ${uploadResult.gcs}`);
    console.log(`Debug - azureExists: ${azureExists}, azureGone: ${azureGone}`);
    console.log(`Debug - gcsExists: ${gcsExists}, gcsGone: ${gcsGone}`);
    t.true(azureGone && gcsGone, "File should be deleted from all storages");

    // Now test checkHash operation - should return 404 with appropriate message
    const checkHashResponse = await axios.get(
      `${baseUrl}?hash=${hash}&checkHash=true`,
      { validateStatus: () => true },
    );

    t.is(
      checkHashResponse.status,
      404,
      "checkHash should return 404 for missing file",
    );
    t.truthy(checkHashResponse.data, "checkHash should return error message");
    t.true(
      checkHashResponse.data.includes("not found") ||
        checkHashResponse.data.includes("Hash") ||
        checkHashResponse.data.includes("404"),
      "Error message should indicate file not found",
    );
  } finally {
    cleanupTestFile(testFile);
  }
});
