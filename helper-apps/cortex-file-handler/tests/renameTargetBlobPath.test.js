import test from "ava";

import { setFileStoreMap, getFileStoreMap, removeFromFileStoreMap } from "../src/redis.js";
import { StorageService } from "../src/services/storage/StorageService.js";
import { sanitizeTargetBlobPath } from "../src/utils/targetBlobPathUtils.js";

test("sanitizeTargetBlobPath preserves safe folder segments", (t) => {
  t.is(
    sanitizeTargetBlobPath(
      "users/user-context-1/media/Jarvis Article Demo/demo.png",
    ),
    "users/user-context-1/media/Jarvis Article Demo/demo.png",
  );
});

test("sanitizeTargetBlobPath rejects traversal segments", (t) => {
  t.is(sanitizeTargetBlobPath("users/user-context-1/../demo.png"), "");
});

test("sanitizeTargetBlobPath sanitizes each segment without dropping folders", (t) => {
  t.is(
    sanitizeTargetBlobPath("media/folder:name/file:name.png"),
    "media/folder_name/file_name.png",
  );
});

test("sanitizeTargetBlobPath collapses repeated separators", (t) => {
  t.is(
    sanitizeTargetBlobPath("//media///folder/file.png//"),
    "media/folder/file.png",
  );
});

test("hash rename honors targetBlobPath and persists the moved blob path", async (t) => {
  const testHash = `test-rename-target-${Date.now()}`;
  const targetBlobPath = "users/user-context-1/media/Jarvis Article Demo/new-name.png";
  const realStorageService = new StorageService();
  const uploadedFile = await realStorageService.uploadFile(
    Buffer.from("target path rename test"),
    "old-name.png",
  );
  let renamedUrl = null;

  await setFileStoreMap(testHash, {
    url: uploadedFile.url,
    filename: "old-name.png",
    hash: testHash,
    blobPath: uploadedFile.blobName,
    blobName: uploadedFile.blobName,
    timestamp: new Date().toISOString(),
  });

  try {
    const result = await realStorageService.renameFile(
      testHash,
      "new-name.png",
      { log: () => {} },
      null,
      { targetBlobPath },
    );
    renamedUrl = result.url;

    t.is(result.blobPath, targetBlobPath);
    t.is(result.filename, "new-name.png");

    const storedInfo = await getFileStoreMap(testHash, true);
    t.is(storedInfo.blobPath, targetBlobPath);
    t.is(storedInfo.blobName, targetBlobPath);
    t.is(storedInfo.filename, "new-name.png");
  } finally {
    await removeFromFileStoreMap(testHash);
    await realStorageService.deleteFile(renamedUrl || uploadedFile.url);
  }
});
