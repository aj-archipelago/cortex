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
