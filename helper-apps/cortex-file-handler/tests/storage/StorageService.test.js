import test from "ava";
import nock from "nock";
import { StorageService } from "../../src/services/storage/StorageService.js";
import { StorageFactory } from "../../src/services/storage/StorageFactory.js";
import { acquireLock, getFileStoreMap, setFileStoreMap, removeFromFileStoreMap, releaseLock } from "../../src/redis.js";
import path from "path";
import os from "os";
import fs from "fs";

test("should create storage service with factory", (t) => {
  const factory = new StorageFactory();
  const service = new StorageService(factory);
  t.truthy(service);
});

test("_extractContainerFromUrl ignores local file handler URLs", (t) => {
  const service = new StorageService({
    getPrimaryProvider: async () => ({}),
    getGCSProvider: () => null,
  });

  t.is(service._extractContainerFromUrl("http://localhost:3100/files/request/file.png"), null);
  t.is(service._extractContainerFromUrl("http://127.0.0.1:7071/files/request/file.png"), null);
});

test("_extractContainerFromUrl extracts Azure and Azurite containers", (t) => {
  const service = new StorageService({
    getPrimaryProvider: async () => ({}),
    getGCSProvider: () => null,
  });

  t.is(
    service._extractContainerFromUrl("https://acct.blob.core.windows.net/user-container/path/file.png?sas=1"),
    "user-container",
  );
  t.is(
    service._extractContainerFromUrl("http://127.0.0.1:10000/devstoreaccount1/azurite-container/path/file.png"),
    "azurite-container",
  );
});

test("getExpectedGCSUrl derives deterministic per-owner GCS path", async (t) => {
  const service = new StorageService({
    getPrimaryProvider: async () => ({}),
    getGCSProvider: () => ({
      bucketName: "backup-bucket",
      normalizeBlobName: (blobName) => blobName.replace(/^\/+/, ""),
      buildUrlForBlobName: (blobName) => `gs://backup-bucket/${blobName.replace(/^\/+/, "")}`,
    }),
  });

  const result = await service.getExpectedGCSUrl({
    blobName: "chats/chat-1/image.png",
    containerOwnerId: "user-1",
  });

  t.is(result, "gs://backup-bucket/user-1/chats/chat-1/image.png");
});

test("ensureGCSUpload reuses inferred GCS object when it exists", async (t) => {
  const expectedUrl = "gs://backup-bucket/user-1/chats/chat-1/image.png";
  const fileExistsCalls = [];
  const service = new StorageService({
    getPrimaryProvider: async () => ({}),
    getGCSProvider: () => ({
      bucketName: "backup-bucket",
      isConfigured: () => true,
      normalizeBlobName: (blobName) => blobName.replace(/^\/+/, ""),
      buildUrlForBlobName: (blobName) => `gs://backup-bucket/${blobName.replace(/^\/+/, "")}`,
      fileExists: async (url) => {
        fileExistsCalls.push(url);
        return url === expectedUrl;
      },
      uploadStreamToBlobName: async () => {
        t.fail("should not upload when inferred GCS object exists");
      },
    }),
  });

  const result = await service.ensureGCSUpload({}, {
    url: "https://azure.test/container/chats/chat-1/image.png?sas=1",
    blobName: "chats/chat-1/image.png",
    containerOwnerId: "user-1",
  });

  t.deepEqual(fileExistsCalls, [expectedUrl]);
  t.is(result.gcs, expectedUrl);
});

test("ensureGCSUpload copies Azure stream to deterministic GCS object", async (t) => {
  const expectedUrl = "gs://backup-bucket/user-1/chats/chat-1/image.png";
  const service = new StorageService({
    getPrimaryProvider: async () => ({}),
    getGCSProvider: () => ({
      bucketName: "backup-bucket",
      isConfigured: () => true,
      normalizeBlobName: (blobName) => blobName.replace(/^\/+/, ""),
      buildUrlForBlobName: (blobName) => `gs://backup-bucket/${blobName.replace(/^\/+/, "")}`,
      fileExists: async () => false,
      uploadStreamToBlobName: async (context, blobName, stream, contentType) => {
        t.is(blobName, "user-1/chats/chat-1/image.png");
        t.is(contentType, "image/png");
        let body = "";
        for await (const chunk of stream) {
          body += chunk.toString();
        }
        t.is(body, "image-bytes");
        return { url: expectedUrl, blobName };
      },
    }),
  });

  nock("https://azure.test")
    .get("/container/chats/chat-1/image.png")
    .query(true)
    .reply(200, "image-bytes", { "content-type": "image/png" });

  const result = await service.ensureGCSUpload({}, {
    url: "https://azure.test/container/chats/chat-1/image.png?sas=1",
    blobName: "chats/chat-1/image.png",
    containerOwnerId: "user-1",
  });

  t.is(result.gcs, expectedUrl);
  t.true(nock.isDone());
});

test("ensureGCSUpload does not claim missing GCS object while Redis lock is held", async (t) => {
  const expectedUrl = "gs://backup-bucket/user-1/chats/chat-1/large-video.mp4";
  const lockKey = `gcs-ensure:${expectedUrl}`;
  await releaseLock(lockKey);
  const acquired = await acquireLock(lockKey, 30);
  t.true(acquired);

  const service = new StorageService({
    getPrimaryProvider: async () => ({}),
    getGCSProvider: () => ({
      bucketName: "backup-bucket",
      isConfigured: () => true,
      normalizeBlobName: (blobName) => blobName.replace(/^\/+/, ""),
      buildUrlForBlobName: (blobName) => `gs://backup-bucket/${blobName.replace(/^\/+/, "")}`,
      fileExists: async () => false,
      uploadStreamToBlobName: async () => {
        t.fail("should not upload while another worker holds the GCS ensure lock");
      },
    }),
  });

  try {
    const result = await service.ensureGCSUpload({ log: () => {} }, {
      url: "https://azure.test/container/chats/chat-1/large-video.mp4?sas=1",
      blobName: "chats/chat-1/large-video.mp4",
      containerOwnerId: "user-1",
    });

    t.is(result.gcs, undefined);
  } finally {
    await releaseLock(lockKey);
  }
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

  const result = await service.deleteFileByHash(nonExistentHash);
  t.true(result.alreadyDeleted, "Should indicate file was already deleted");
  t.is(result.hash, nonExistentHash);
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

// Container-specific tests - now using single container only
test("should upload file using default container", async (t) => {
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
    // Test upload - container parameter is ignored, always uses default
    const result = await service.uploadFileWithProviders(
      { log: () => {} }, // mock context
      testFile,
      "test-request",
      null,
      null
    );
    
    t.truthy(result.url);
    t.truthy(result.shortLivedUrl);
    
    // Cleanup
    await service.deleteFiles("test-request");
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

test("should upload file using uploadFile method (container parameter ignored)", async (t) => {
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
    // Test upload using the uploadFile method - container parameter is ignored
    const result = await service.uploadFile(
      { log: () => {} }, // context
      testFile,         // filePath
      "test-request",   // requestId
      null,             // hash
      null              // filename (containerName parameter removed)
    );
    
    t.truthy(result.url);
    t.truthy(result.shortLivedUrl);
    
    // Cleanup
    await service.deleteFiles("test-request");
  } finally {
    // Cleanup temp file
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
