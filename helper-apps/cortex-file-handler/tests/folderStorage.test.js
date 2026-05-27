import test from "ava";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { constructFolderPath, sanitizeSubPath } from "../src/blobHandler.js";
import { AzureStorageProvider } from "../src/services/storage/AzureStorageProvider.js";
import { GCSStorageProvider } from "../src/services/storage/GCSStorageProvider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// constructFolderPath tests
// ============================================================================

test("constructFolderPath › should return null when userId is missing and scope is not workspace-shared-legacy", (t) => {
  t.is(constructFolderPath({}), null);
  t.is(constructFolderPath({ chatId: "chat123" }), null);
  t.is(constructFolderPath({ workspaceId: "ws123" }), null);
  t.is(constructFolderPath({ fileScope: "global" }), null);
  t.is(constructFolderPath({ fileScope: "chat", chatId: "chat123" }), null);
});

test("constructFolderPath › should return global path for userId only", (t) => {
  const result = constructFolderPath({ userId: "user123" });
  t.is(result, "global");
});

test("sanitizeSubPath › allows safe nested folder paths", (t) => {
  t.is(sanitizeSubPath("versions/applet123"), "versions/applet123");
  t.is(sanitizeSubPath("/versions/applet123/"), "versions/applet123");
});

test("sanitizeSubPath › rejects traversal and unsafe folder paths", (t) => {
  t.is(sanitizeSubPath("../versions/applet123"), null);
  t.is(sanitizeSubPath("versions/../../secret"), null);
  t.is(sanitizeSubPath("versions/applet.123"), null);
});

test("constructFolderPath › should return global path for explicit global scope", (t) => {
  const result = constructFolderPath({ userId: "user123", fileScope: "global" });
  t.is(result, "global");
});

test("constructFolderPath › should return chat path when chatId is provided with chat scope", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    chatId: "chat456",
    fileScope: "chat"
  });
  t.is(result, "chats/chat456");
});

test("constructFolderPath › should fall back to global when chat scope but no chatId", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "chat"
  });
  t.is(result, "global");
});

test("constructFolderPath › should return global for unknown scope with userId", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "unknown-scope"
  });
  t.is(result, "global");
});

test("constructFolderPath › should return empty string for all scope", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "all"
  });
  t.is(result, "");
});

test("constructFolderPath › should handle all parameters together", (t) => {
  // Chat scope takes precedence when chatId is provided
  const chatResult = constructFolderPath({
    userId: "user123",
    chatId: "chat456",
    fileScope: "chat"
  });
  t.is(chatResult, "chats/chat456");
});

test("constructFolderPath › should return workspace-user-legacy path with workspaceId", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    workspaceId: "ws789",
    fileScope: "workspace-user-legacy"
  });
  t.is(result, "applets/ws789");
});

test("constructFolderPath › should fall back to global for workspace-user-legacy scope without workspaceId", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "workspace-user-legacy"
  });
  t.is(result, "global");
});

test("constructFolderPath › should return profile path", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "profile"
  });
  t.is(result, "profile");
});

test("constructFolderPath › should return media path", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "media"
  });
  t.is(result, "media");
});

test("constructFolderPath › media path is suitable for remote-file uploads", (t) => {
  const folderPath = constructFolderPath({
    userId: "user123",
    fileScope: "media"
  });
  const blobName = folderPath ? `${folderPath}/mmlhat5b-shz.webp` : "mmlhat5b-shz.webp";
  t.is(blobName, "media/mmlhat5b-shz.webp");
});

test("constructFolderPath › should return articles path", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "articles"
  });
  t.is(result, "articles");
});

test("constructFolderPath › should return applets path for user-scoped applets scope", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    fileScope: "applets"
  });
  t.is(result, "applets");
});

test("constructFolderPath › should route applet-user scope into an applet-specific folder", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    appletId: "applet456",
    fileScope: "applet-user"
  });
  t.is(result, "applets/applet456");
});

test("constructFolderPath › should derive the applet-user folder from scoped contextId", (t) => {
  const result = constructFolderPath({
    contextId: "applet-user:applet456:user123",
    fileScope: "applet-user"
  });
  t.is(result, "applets/applet456");
});

test("constructFolderPath › workspace-shared-legacy scope should return empty string (root)", (t) => {
  const result = constructFolderPath({
    workspaceId: "ws789",
    fileScope: "workspace-shared-legacy"
  });
  t.is(result, "");
});

test("constructFolderPath › workspace-shared-legacy scope should return null without workspaceId", (t) => {
  const result = constructFolderPath({
    fileScope: "workspace-shared-legacy"
  });
  t.is(result, null);
});

test("constructFolderPath › workspace-shared-legacy scope should not require userId", (t) => {
  // workspace-shared-legacy scopes the container by workspaceId, not userId
  const result = constructFolderPath({
    workspaceId: "ws789",
    fileScope: "workspace-shared-legacy"
  });
  t.is(result, "");
});

test("constructFolderPath › should reject invalid workspaceId for workspace-shared-legacy", (t) => {
  const result = constructFolderPath({
    workspaceId: "../escape",
    fileScope: "workspace-shared-legacy"
  });
  t.is(result, null);
});

test("constructFolderPath › should reject invalid workspaceId for workspace-user-legacy scope", (t) => {
  const result = constructFolderPath({
    userId: "user123",
    workspaceId: "bad/path",
    fileScope: "workspace-user-legacy"
  });
  t.is(result, null);
});

// ============================================================================
// Azure listFolder tests
// ============================================================================

test("Azure listFolder › should list files in a folder", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const testFolder = `test-folder-${Date.now()}`;
  const testFiles = [];

  try {
    // Upload some test files to a folder
    for (let i = 0; i < 3; i++) {
      const content = `Test content ${i}`;
      const stream = Readable.from([content]);
      const filename = `file${i}.txt`;
      const folderPath = testFolder;

      await provider.uploadStream(
        { log: () => {} },
        filename,
        stream,
        "text/plain",
        "temporary",
        folderPath
      );
      testFiles.push(`${testFolder}/${filename}`);
    }

    // List the folder
    const files = await provider.listFolder(testFolder);

    t.is(files.length, 3);
    for (const file of files) {
      t.true(file.name.startsWith(testFolder + "/"));
      t.truthy(file.filename);
      t.truthy(file.lastModified);
      t.is(file.contentType, "text/plain; charset=utf-8");
      t.truthy(file.size);
    }
  } finally {
    // Cleanup: delete the test folder contents
    const { containerClient } = await provider.getBlobClient();
    for await (const blob of containerClient.listBlobsFlat({ prefix: testFolder })) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete().catch(() => {});
    }
  }
});

test("Azure listFolder › should return empty array for non-existent folder", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const files = await provider.listFolder("non-existent-folder-12345");
  t.deepEqual(files, []);
});

test("Azure listFolder › should extract hash from filename with hash prefix", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const testFolder = `test-hash-folder-${Date.now()}`;

  try {
    // Upload a file with hash prefix format: {hash}_{filename}
    const content = "Test content with hash";
    const stream = Readable.from([content]);
    const hashPrefix = "abc123def456";
    const originalFilename = "document.pdf";
    const filename = `${hashPrefix}_${originalFilename}`;

    await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "application/pdf",
      "temporary",
      testFolder
    );

    // List the folder and verify hash extraction
    const files = await provider.listFolder(testFolder);

    t.is(files.length, 1);
    t.is(files[0].hash, hashPrefix);
    t.is(files[0].filename, originalFilename);
  } finally {
    // Cleanup
    const { containerClient } = await provider.getBlobClient();
    for await (const blob of containerClient.listBlobsFlat({ prefix: testFolder })) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete().catch(() => {});
    }
  }
});

test("Azure listFolder › should handle files without hash prefix", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const testFolder = `test-no-hash-folder-${Date.now()}`;

  try {
    // Upload a file without hash prefix
    const content = "Test content no hash";
    const stream = Readable.from([content]);
    const filename = "simple-file.txt";

    await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "text/plain",
      "temporary",
      testFolder
    );

    // List the folder
    const files = await provider.listFolder(testFolder);

    t.is(files.length, 1);
    t.is(files[0].hash, null);
    t.is(files[0].filename, filename);
  } finally {
    // Cleanup
    const { containerClient } = await provider.getBlobClient();
    for await (const blob of containerClient.listBlobsFlat({ prefix: testFolder })) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete().catch(() => {});
    }
  }
});

test("Azure uploadStream › should create folder hierarchy with folderPath", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const chatId = "chat456";
  const folderPath = `chats/${chatId}`;
  const testFolder = `chats`;

  try {
    const content = "Test file in folder hierarchy";
    const stream = Readable.from([content]);
    const filename = "nested-file.txt";

    const result = await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "text/plain",
      "temporary",
      folderPath
    );

    t.truthy(result.url);
    // URL should contain the folder path components (may be URL-encoded)
    t.true(result.url.includes("chats"));

    // Verify file is in the correct folder
    const files = await provider.listFolder(folderPath);
    t.true(files.length >= 1);
    t.true(files.some(f => f.filename === filename));
  } finally {
    // Cleanup
    const { containerClient } = await provider.getBlobClient();
    for await (const blob of containerClient.listBlobsFlat({ prefix: testFolder })) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete().catch(() => {});
    }
  }
});

// ============================================================================
// GCS listFolder tests
// ============================================================================

test("GCS listFolder › should list files in a folder", async (t) => {
  if (
    !process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 &&
    !process.env.GCP_SERVICE_ACCOUNT_KEY
  ) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const credentials = JSON.parse(
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
      ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, "base64").toString()
      : process.env.GCP_SERVICE_ACCOUNT_KEY
  );

  const provider = new GCSStorageProvider(
    credentials,
    process.env.GCS_BUCKETNAME || "cortextempfiles"
  );

  const testFolder = `test-folder-${Date.now()}`;

  try {
    // Upload some test files to a folder
    for (let i = 0; i < 3; i++) {
      const content = `Test content ${i}`;
      const stream = Readable.from([content]);
      const filename = `file${i}.txt`;

      await provider.uploadStream(
        { log: () => {} },
        filename,
        stream,
        "text/plain",
        "temporary",
        testFolder
      );
    }

    // List the folder
    const files = await provider.listFolder(testFolder);

    t.is(files.length, 3);
    for (const file of files) {
      t.true(file.name.startsWith(testFolder + "/"));
      t.truthy(file.filename);
      t.true(file.contentType.startsWith("text/plain"));
    }
  } finally {
    // Cleanup
    await provider.deleteFiles(testFolder);
  }
});

test("GCS listFolder › should return empty array for non-existent folder", async (t) => {
  if (
    !process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 &&
    !process.env.GCP_SERVICE_ACCOUNT_KEY
  ) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const credentials = JSON.parse(
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
      ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, "base64").toString()
      : process.env.GCP_SERVICE_ACCOUNT_KEY
  );

  const provider = new GCSStorageProvider(
    credentials,
    process.env.GCS_BUCKETNAME || "cortextempfiles"
  );

  const files = await provider.listFolder("non-existent-folder-12345");
  t.deepEqual(files, []);
});

test("GCS listFolder › should extract hash from filename with hash prefix", async (t) => {
  if (
    !process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 &&
    !process.env.GCP_SERVICE_ACCOUNT_KEY
  ) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const credentials = JSON.parse(
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
      ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, "base64").toString()
      : process.env.GCP_SERVICE_ACCOUNT_KEY
  );

  const provider = new GCSStorageProvider(
    credentials,
    process.env.GCS_BUCKETNAME || "cortextempfiles"
  );

  const testFolder = `test-hash-folder-${Date.now()}`;

  try {
    // Upload a file with hash prefix format: {hash}_{filename}
    const content = "Test content with hash";
    const stream = Readable.from([content]);
    const hashPrefix = "abc123def456";
    const originalFilename = "document.pdf";
    const filename = `${hashPrefix}_${originalFilename}`;

    await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "application/pdf",
      "temporary",
      testFolder
    );

    // List the folder and verify hash extraction
    const files = await provider.listFolder(testFolder);

    t.is(files.length, 1);
    t.is(files[0].hash, hashPrefix);
    t.is(files[0].filename, originalFilename);
  } finally {
    // Cleanup
    await provider.deleteFiles(testFolder);
  }
});

test("GCS uploadStream › should create folder hierarchy with folderPath", async (t) => {
  if (
    !process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 &&
    !process.env.GCP_SERVICE_ACCOUNT_KEY
  ) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const credentials = JSON.parse(
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
      ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, "base64").toString()
      : process.env.GCP_SERVICE_ACCOUNT_KEY
  );

  const provider = new GCSStorageProvider(
    credentials,
    process.env.GCS_BUCKETNAME || "cortextempfiles"
  );

  const chatId = "chat456";
  const folderPath = `chats/${chatId}`;
  const testFolder = `chats`;

  try {
    const content = "Test file in folder hierarchy";
    const stream = Readable.from([content]);
    const filename = "nested-file.txt";

    const result = await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "text/plain",
      "temporary",
      folderPath
    );

    t.truthy(result);
    t.true(result.includes("gs://"));
    t.true(result.includes(folderPath));

    // Verify file is in the correct folder
    const files = await provider.listFolder(folderPath);
    t.true(files.length >= 1);
    t.true(files.some(f => f.filename === filename));
  } finally {
    // Cleanup
    await provider.deleteFiles(testFolder);
  }
});

// ============================================================================
// Edge case tests
// ============================================================================

test("Azure listFolder › should handle nested folder paths", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const baseFolder = `test-nested-${Date.now()}`;
  const nestedFolder = `${baseFolder}/level1/level2/level3`;

  try {
    // Upload file to deeply nested folder
    const content = "Deeply nested content";
    const stream = Readable.from([content]);
    const filename = "deep-file.txt";

    await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "text/plain",
      "temporary",
      nestedFolder
    );

    // List should find file at exact path
    const exactFiles = await provider.listFolder(nestedFolder);
    t.is(exactFiles.length, 1);
    t.is(exactFiles[0].filename, filename);

    // Blob storage prefix matching finds all files with that prefix (including nested)
    // This is expected behavior - listFolder returns all files under the folder path
    const baseFiles = await provider.listFolder(baseFolder);
    t.is(baseFiles.length, 1); // File is found via prefix match

    // Verify the full blob name shows the nested path
    t.true(baseFiles[0].name.includes("level1/level2/level3"));
  } finally {
    // Cleanup
    const { containerClient } = await provider.getBlobClient();
    for await (const blob of containerClient.listBlobsFlat({ prefix: baseFolder })) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete().catch(() => {});
    }
  }
});

test("Azure listFolder › should normalize folder paths with leading/trailing slashes", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    process.env.AZURE_STORAGE_CONTAINER_NAME || "test-container"
  );

  const testFolder = `test-normalize-${Date.now()}`;

  try {
    // Upload a file
    const content = "Normalization test";
    const stream = Readable.from([content]);
    const filename = "norm-file.txt";

    await provider.uploadStream(
      { log: () => {} },
      filename,
      stream,
      "text/plain",
      "temporary",
      testFolder
    );

    // List with trailing slash
    const filesWithSlash = await provider.listFolder(`${testFolder}/`);
    t.is(filesWithSlash.length, 1);

    // List without trailing slash
    const filesWithoutSlash = await provider.listFolder(testFolder);
    t.is(filesWithoutSlash.length, 1);
  } finally {
    // Cleanup
    const { containerClient } = await provider.getBlobClient();
    for await (const blob of containerClient.listBlobsFlat({ prefix: testFolder })) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete().catch(() => {});
    }
  }
});
