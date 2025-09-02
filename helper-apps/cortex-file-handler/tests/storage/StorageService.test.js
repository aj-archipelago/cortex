import test from "ava";
import { StorageService } from "../../src/services/storage/StorageService.js";
import { StorageFactory } from "../../src/services/storage/StorageFactory.js";
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
  const provider = service.getBackupProvider();
  if (!provider) {
    t.log("GCS not configured, skipping test");
    t.pass();
    return;
  }
  const testContent = "test content";
  const buffer = Buffer.from(testContent);

  const result = await service.uploadFileToBackup(buffer, "test.txt");
  t.truthy(result.url);

  // Cleanup
  await service.deleteFileFromBackup(result.url);
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
  const provider = service.getBackupProvider();
  if (!provider) {
    t.log("GCS not configured, skipping test");
    t.pass();
    return;
  }
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
});
