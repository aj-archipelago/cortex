import test from "ava";
import { StorageService } from "../../src/services/storage/StorageService.js";
import { StorageFactory } from "../../src/services/storage/StorageFactory.js";
import { getFileStoreMap, setFileStoreMap, removeFromFileStoreMap } from "../../src/redis.js";
import path from "path";
import os from "os";
import fs from "fs";

test("should create storage service with factory", (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  t.truthy(service);
});

test("should get primary provider", (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const provider = service.getPrimaryProvider();
  t.truthy(provider);
});

test("should get backup provider", (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const provider = service.getBackupProvider();
  if (!provider) {
    t.log("GCS not configured, skipping test");
    t.pass();
  } else {
    t.truthy(provider);
  }
});

test("should upload file to primary storage", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const testContent = "test content";
  const buffer = Buffer.from(testContent);

  const result = await service.uploadFile(buffer, "test.txt");
  t.truthy(result.url);

  // Cleanup
  await service.deleteFile(result.url);
});

test("should upload file to backup storage", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const provider = await service.getBackupProvider();
  if (!provider) {
    t.log("Backup provider not configured, skipping test");
    t.pass();
    return;
  }
  
  try {
    const testContent = "test content";
    const buffer = Buffer.from(testContent);

    const result = await service.uploadFileToBackup(buffer, "test.txt");
    t.truthy(result.url);

    // Cleanup
    await service.deleteFileFromBackup(result.url);
  } catch (error) {
    if (error.message === "Backup provider not configured") {
      t.log("Backup provider not configured, skipping test");
      t.pass();
    } else {
      throw error;
    }
  }
});

test("should download file from primary storage", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const testContent = "test content";
  const buffer = Buffer.from(testContent);

  // Upload first
  const uploadResult = await service.uploadFile(buffer, "test.txt");

  // Download
  const downloadResult = await service.downloadFile(uploadResult.url);
  t.deepEqual(downloadResult, buffer);

  // Cleanup
  await service.deleteFile(uploadResult.url);
});

test("should download file from backup storage", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const provider = await service.getBackupProvider();
  if (!provider) {
    t.log("Backup provider not configured, skipping test");
    t.pass();
    return;
  }
  
  try {
    const testContent = "test content";
    const buffer = Buffer.from(testContent);

    // Upload first
    const uploadResult = await service.uploadFileToBackup(buffer, "test.txt");

    // Create temp file for download
    const tempFile = path.join(os.tmpdir(), "test-download.txt");
    try {
      // Download
      await service.downloadFileFromBackup(uploadResult.url, tempFile);
      const downloadedContent = await fs.promises.readFile(tempFile);
      t.deepEqual(downloadedContent, buffer);

      // Cleanup
      await service.deleteFileFromBackup(uploadResult.url);
    } finally {
      // Cleanup temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  } catch (error) {
    if (error.message === "Backup provider not configured") {
      t.log("Backup provider not configured, skipping test");
      t.pass();
    } else {
      throw error;
    }
  }
});

test("should delete file by hash", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const testContent = "test content for hash deletion";
  const buffer = Buffer.from(testContent);
  const testHash = "test-hash-123";

  try {
    // Upload file first
    const uploadResult = await service.uploadFile(buffer, "test-hash-delete.txt");
    t.truthy(uploadResult.url);

    // Store file info in Redis map
    const fileInfo = {
      url: uploadResult.url,
      filename: "test-hash-delete.txt",
      hash: testHash,
      timestamp: new Date().toISOString()
    };
    await setFileStoreMap(testHash, fileInfo);

    // Verify file exists in map
    const storedInfo = await getFileStoreMap(testHash);
    t.truthy(storedInfo);
    t.is(storedInfo.url, uploadResult.url);

    // Delete file by hash
    const deleteResult = await service.deleteFileByHash(testHash);
    t.truthy(deleteResult);
    t.is(deleteResult.hash, testHash);
    t.is(deleteResult.filename, "test-hash-delete.txt");
    t.truthy(deleteResult.deleted);
    t.true(Array.isArray(deleteResult.deleted));

    // Verify file is removed from Redis map
    const removedInfo = await getFileStoreMap(testHash);
    t.falsy(removedInfo);

  } catch (error) {
    // Cleanup in case of error
    try {
      await removeFromFileStoreMap(testHash);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
});

test("should handle delete file by hash when file not found", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const nonExistentHash = "non-existent-hash-456";

  try {
    await service.deleteFileByHash(nonExistentHash);
    t.fail("Should have thrown an error for non-existent hash");
  } catch (error) {
    t.true(error.message.includes("not found"));
  }
});

test("should handle delete file by hash with missing hash parameter", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);

  try {
    await service.deleteFileByHash("");
    t.fail("Should have thrown an error for empty hash");
  } catch (error) {
    t.true(error.message.includes("Missing hash parameter"));
  }

  try {
    await service.deleteFileByHash(null);
    t.fail("Should have thrown an error for null hash");
  } catch (error) {
    t.true(error.message.includes("Missing hash parameter"));
  }

  try {
    await service.deleteFileByHash(undefined);
    t.fail("Should have thrown an error for undefined hash");
  } catch (error) {
    t.true(error.message.includes("Missing hash parameter"));
  }
});

test("should delete file by hash with backup storage", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const testContent = "test content for backup deletion";
  const buffer = Buffer.from(testContent);
  const testHash = "test-hash-backup-456";

  try {
    // Upload file first
    const uploadResult = await service.uploadFile(buffer, "test-backup-delete.txt");
    t.truthy(uploadResult.url);

    // Store file info in Redis map with backup URL
    const fileInfo = {
      url: uploadResult.url,
      gcs: "gs://test-bucket/test-backup-file.txt", // Mock backup URL
      filename: "test-backup-delete.txt",
      hash: testHash,
      timestamp: new Date().toISOString()
    };
    await setFileStoreMap(testHash, fileInfo);

    // Delete file by hash
    const deleteResult = await service.deleteFileByHash(testHash);
    t.truthy(deleteResult);
    t.is(deleteResult.hash, testHash);
    t.is(deleteResult.filename, "test-backup-delete.txt");
    t.truthy(deleteResult.deleted);
    t.true(Array.isArray(deleteResult.deleted));

    // Should have attempted both primary and backup deletion
    const deletionResults = deleteResult.deleted;
    t.true(deletionResults.length >= 1, "Should have at least primary deletion result");

    // Verify file is removed from Redis map
    const removedInfo = await getFileStoreMap(testHash);
    t.falsy(removedInfo);

  } catch (error) {
    // Cleanup in case of error
    try {
      await removeFromFileStoreMap(testHash);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
});

test("should handle delete file by hash when Redis map is corrupted", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const testHash = "test-hash-corrupted-789";

  try {
    // Store corrupted data in Redis map
    const corruptedInfo = {
      // Missing required fields like url
      corrupted: true,
      timestamp: new Date().toISOString()
    };
    await setFileStoreMap(testHash, corruptedInfo);

    // Delete file by hash should handle corrupted data gracefully
    const deleteResult = await service.deleteFileByHash(testHash);
    t.truthy(deleteResult);
    t.is(deleteResult.hash, testHash);
    t.truthy(deleteResult.deleted);
    t.true(Array.isArray(deleteResult.deleted));

    // Should have removed the corrupted entry from Redis
    const removedInfo = await getFileStoreMap(testHash);
    t.falsy(removedInfo);

  } catch (error) {
    // Cleanup in case of error
    try {
      await removeFromFileStoreMap(testHash);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
});

test("should handle delete file by hash with empty URL in Redis", async (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  const testHash = "test-hash-empty-url-654";

  try {
    // Store file info in Redis map with empty/null URL
    const fileInfo = {
      url: null,
      filename: "test-empty-url-delete.txt",
      hash: testHash,
      timestamp: new Date().toISOString()
    };
    await setFileStoreMap(testHash, fileInfo);

    // Verify the hash exists in Redis before deletion (skip lazy cleanup)
    const storedInfo = await getFileStoreMap(testHash, true);
    t.truthy(storedInfo, "Hash should exist in Redis before deletion");

    // Delete file by hash - should handle missing URL gracefully
    const deleteResult = await service.deleteFileByHash(testHash);
    t.truthy(deleteResult);
    t.is(deleteResult.hash, testHash);
    t.is(deleteResult.filename, "test-empty-url-delete.txt");
    t.truthy(deleteResult.deleted);
    t.true(Array.isArray(deleteResult.deleted));

    // Should still remove from Redis map even if no actual file to delete
    const removedInfo = await getFileStoreMap(testHash);
    t.falsy(removedInfo);

  } catch (error) {
    // Cleanup in case of error
    try {
      await removeFromFileStoreMap(testHash);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
});

// Container-specific tests
test("should upload file with specific container name", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();
  const service = new StorageService(factory);
  
  // Create a temporary file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
  const testFile = path.join(tempDir, "test.txt");
  fs.writeFileSync(testFile, "test content");
  
  try {
    // Mock environment to have multiple containers
    const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
    process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";
    
    try {
      // Test upload with specific container
      const result = await service.uploadFileWithProviders(
        { log: () => {} }, // mock context
        testFile,
        "test-request",
        null,
        "test2"
      );
      
      t.truthy(result.url);
      t.truthy(result.url.includes("test2") || result.url.includes("/test2/"));
      
      // Cleanup
      await service.deleteFiles("test-request");
    } finally {
      // Restore original env
      if (originalEnv) {
        process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
      } else {
        delete process.env.AZURE_STORAGE_CONTAINER_NAME;
      }
    }
  } finally {
    // Cleanup temp file
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("should use default container when no container specified", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();
  const service = new StorageService(factory);
  
  // Create a temporary file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
  const testFile = path.join(tempDir, "test.txt");
  fs.writeFileSync(testFile, "test content");
  
  try {
    // Test upload without container (should use default)
    const result = await service.uploadFileWithProviders(
      { log: () => {} }, // mock context
      testFile,
      "test-request",
      null,
      null // no container specified
    );
    
    t.truthy(result.url);
    
    // Cleanup
    await service.deleteFiles("test-request");
  } finally {
    // Cleanup temp file
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("should pass container parameter through uploadFile method", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();
  const service = new StorageService(factory);
  
  // Create a temporary file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
  const testFile = path.join(tempDir, "test.txt");
  fs.writeFileSync(testFile, "test content");
  
  try {
    // Mock environment to have multiple containers
    const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
    process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";
    
    try {
      // Test upload using the uploadFile method with container parameter
      const result = await service.uploadFile(
        { log: () => {} }, // context
        testFile,         // filePath
        "test-request",   // requestId
        null,             // hash
        "test3"           // containerName
      );
      
      t.truthy(result.url);
      
      // Cleanup
      await service.deleteFiles("test-request");
    } finally {
      // Restore original env
      if (originalEnv) {
        process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
      } else {
        delete process.env.AZURE_STORAGE_CONTAINER_NAME;
      }
    }
  } finally {
    // Cleanup temp file
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
