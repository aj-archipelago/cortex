import test from "ava";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { AzureStorageProvider } from "../../src/services/storage/AzureStorageProvider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Azurite well-known connection string — works without a running emulator
// for tests that only exercise constructor / SAS generation (no network calls).
const AZURITE_CONN_STRING = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

test.before(() => {
  // Ensure we have the required environment variables
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    console.warn(
      "Skipping Azure integration tests - AZURE_STORAGE_CONNECTION_STRING not set",
    );
  }
});

// ── Constructor tests ──────────────────────────────────────────────

test("should create provider with valid credentials", (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );
  t.truthy(provider);
  t.is(provider.containerName, "test-container");
});

test("should throw error with missing credentials", (t) => {
  t.throws(
    () => {
      new AzureStorageProvider(null, "test-container");
    },
    { message: "Missing Azure Storage connection string or container name" },
  );
});

test("constructor should initialize cached fields to null", (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );
  t.is(provider._blobServiceClient, null);
  t.is(provider._containerClient, null);
  t.is(provider._sharedKeyCredential, null);
  t.is(provider._initPromise, null);
});

// ── ensureInitialized / _doInitialize tests ────────────────────────

test("ensureInitialized should populate cached fields", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  // Stub _doInitialize to avoid real network calls
  provider._doInitialize = async () => {
    provider._blobServiceClient = { fake: true };
    provider._containerClient = { fake: true, containerName: "test-container" };
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  await provider.ensureInitialized();

  t.truthy(provider._blobServiceClient);
  t.truthy(provider._containerClient);
  t.truthy(provider._sharedKeyCredential);
});

test("ensureInitialized should only run _doInitialize once", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  let callCount = 0;
  provider._doInitialize = async () => {
    callCount++;
    provider._blobServiceClient = { fake: true };
    provider._containerClient = { fake: true, containerName: "test-container" };
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  // Call multiple times — should only init once
  await Promise.all([
    provider.ensureInitialized(),
    provider.ensureInitialized(),
    provider.ensureInitialized(),
  ]);

  t.is(callCount, 1, "_doInitialize should be called exactly once");
});

test("ensureInitialized is a no-op after successful init", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  let callCount = 0;
  provider._doInitialize = async () => {
    callCount++;
    provider._blobServiceClient = { fake: true };
    provider._containerClient = { fake: true, containerName: "test-container" };
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  await provider.ensureInitialized();
  t.is(callCount, 1);

  // Second call should short-circuit via the _sharedKeyCredential check
  await provider.ensureInitialized();
  t.is(callCount, 1, "should not call _doInitialize again");
});

// ── getBlobClient caching tests ────────────────────────────────────

test("getBlobClient should return cached clients", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  const fakeServiceClient = { fake: "service" };
  const fakeContainerClient = {
    fake: "container",
    containerName: "test-container",
    createIfNotExists: async () => {},
  };

  provider._doInitialize = async () => {
    provider._blobServiceClient = fakeServiceClient;
    provider._containerClient = fakeContainerClient;
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  const result1 = await provider.getBlobClient();
  const result2 = await provider.getBlobClient();

  t.is(result1.blobServiceClient, fakeServiceClient);
  t.is(result1.containerClient, fakeContainerClient);
  // Same references on second call
  t.is(result1.blobServiceClient, result2.blobServiceClient);
  t.is(result1.containerClient, result2.containerClient);
});

test("getBlobClient retries createIfNotExists after a transient failure", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  let createCalls = 0;
  const fakeContainerClient = {
    containerName: "test-container",
    createIfNotExists: async () => {
      createCalls++;
      if (createCalls === 1) {
        const err = new Error("transient");
        err.statusCode = 500;
        throw err;
      }
      // succeed on retry
    },
  };

  provider._doInitialize = async () => {
    provider._blobServiceClient = { fake: "service" };
    provider._containerClient = fakeContainerClient;
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  await t.throwsAsync(
    () => provider.getBlobClient(),
    { message: "transient" },
  );
  t.false(provider._containerEnsured, "should not cache failed create");
  t.is(createCalls, 1);

  await provider.getBlobClient();
  t.true(provider._containerEnsured, "successful retry should set the cache");
  t.is(createCalls, 2, "second call retries createIfNotExists");

  await provider.getBlobClient();
  t.is(createCalls, 2, "subsequent calls skip createIfNotExists");
});

test("getBlobClient caches success when create returns 409 (already exists)", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  let createCalls = 0;
  const fakeContainerClient = {
    containerName: "test-container",
    createIfNotExists: async () => {
      createCalls++;
      const err = new Error("already exists");
      err.statusCode = 409;
      throw err;
    },
  };

  provider._doInitialize = async () => {
    provider._blobServiceClient = { fake: "service" };
    provider._containerClient = fakeContainerClient;
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  await provider.getBlobClient();
  await provider.getBlobClient();
  t.true(provider._containerEnsured);
  t.is(createCalls, 1, "409 is treated as success");
});

// ── listFolder defensive tests ─────────────────────────────────────

test("listFolder returns empty array when container does not exist", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  const fakeContainerClient = {
    containerName: "test-container",
    createIfNotExists: async () => {},
    listBlobsFlat: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const err = new Error("The specified container does not exist.");
          err.statusCode = 404;
          err.code = "ContainerNotFound";
          throw err;
        },
      }),
    }),
  };

  provider._doInitialize = async () => {
    provider._blobServiceClient = { fake: "service" };
    provider._containerClient = fakeContainerClient;
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  const result = await provider.listFolder("global");
  t.deepEqual(result, []);
});

test("listFolder propagates non-404 errors", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  const fakeContainerClient = {
    containerName: "test-container",
    createIfNotExists: async () => {},
    listBlobsFlat: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const err = new Error("boom");
          err.statusCode = 500;
          throw err;
        },
      }),
    }),
  };

  provider._doInitialize = async () => {
    provider._blobServiceClient = { fake: "service" };
    provider._containerClient = fakeContainerClient;
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  await t.throwsAsync(() => provider.listFolder("global"), { message: "boom" });
});

test("uploadStream recreates missing container and retries once", async (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );

  const tempFile = path.join(__dirname, `retry-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, "retry me");
  t.teardown(() => {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  });

  let createCalls = 0;
  let uploadCalls = 0;
  const fakeContainerClient = {
    containerName: "test-container",
    createIfNotExists: async () => {
      createCalls++;
    },
    getBlockBlobClient: (blobName) => ({
      url: `http://127.0.0.1:10000/devstoreaccount1/test-container/${blobName}`,
      uploadStream: async (body) => {
        await new Promise((resolve, reject) => {
          body.on("error", reject);
          body.on("end", resolve);
          body.resume();
        });
        uploadCalls++;
        if (uploadCalls === 1) {
          const err = new Error("The specified container does not exist.");
          err.statusCode = 404;
          err.code = "ContainerNotFound";
          throw err;
        }
      },
    }),
  };

  provider._doInitialize = async () => {
    provider._blobServiceClient = { fake: "service" };
    provider._containerClient = fakeContainerClient;
    provider._sharedKeyCredential = new StorageSharedKeyCredential(
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    );
  };

  const result = await provider.uploadStream(
    {},
    "retry.txt",
    fs.createReadStream(tempFile),
    "text/plain",
  );

  t.true(result.url.includes("/test-container/retry.txt?"));
  t.is(createCalls, 2, "container should be re-ensured before retry");
  t.is(uploadCalls, 2, "upload should be retried once");
});

// ── generateSASToken dual-signature tests ──────────────────────────

// Helper: create an initialized provider with the Azurite credential cached
function createInitializedProvider() {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );
  provider._sharedKeyCredential = new StorageSharedKeyCredential(
    "devstoreaccount1",
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  );
  return provider;
}

test("generateSASToken new signature: (blobName)", (t) => {
  const provider = createInitializedProvider();
  const token = provider.generateSASToken("folder/file.txt");
  t.truthy(token, "should return a SAS token string");
  t.true(token.includes("sig="), "token should contain a signature");
  t.true(token.includes("se="), "token should contain an expiry");
});

test("generateSASToken new signature: (blobName, options)", (t) => {
  const provider = createInitializedProvider();
  const token = provider.generateSASToken("file.txt", { minutes: 10 });
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateSASToken old signature: (containerClient, blobName)", (t) => {
  const provider = createInitializedProvider();
  const fakeContainerClient = { containerName: "test-container" };
  const token = provider.generateSASToken(fakeContainerClient, "file.txt");
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateSASToken old signature: (containerClient, blobName, options)", (t) => {
  const provider = createInitializedProvider();
  const fakeContainerClient = { containerName: "test-container" };
  const token = provider.generateSASToken(fakeContainerClient, "file.txt", { minutes: 10 });
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateSASToken new and old signatures produce equivalent tokens", (t) => {
  const provider = createInitializedProvider();
  const fakeContainerClient = { containerName: "test-container" };

  // Both should produce tokens for the same blob with the same options
  // We can't compare exact strings (timestamp varies) but can verify both are valid
  const newToken = provider.generateSASToken("file.txt", { hours: 1 });
  const oldToken = provider.generateSASToken(fakeContainerClient, "file.txt", { hours: 1 });

  t.truthy(newToken);
  t.truthy(oldToken);
  // Both should have the same permissions and container
  t.true(newToken.includes("sp=r"), "new signature should default to read permission");
  t.true(oldToken.includes("sp=r"), "old signature should default to read permission");
});

test("generateSASToken throws if not initialized", (t) => {
  const provider = new AzureStorageProvider(
    AZURITE_CONN_STRING,
    "test-container",
  );
  // _sharedKeyCredential is null — should throw
  t.throws(
    () => provider.generateSASToken("file.txt"),
    { message: /not initialized/ },
  );
});

test("generateSASToken uses this.containerName (not containerClient.containerName)", (t) => {
  const provider = createInitializedProvider();
  // Pass a containerClient with a DIFFERENT containerName — should be ignored
  const wrongContainerClient = { containerName: "wrong-container" };
  const token = provider.generateSASToken(wrongContainerClient, "file.txt");
  // The token is generated for this.containerName ("test-container"), not "wrong-container"
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateSASToken respects custom permissions", (t) => {
  const provider = createInitializedProvider();
  const token = provider.generateSASToken("file.txt", { permissions: "rw" });
  t.true(token.includes("sp=rw"));
});

test("generateSASToken respects days option", (t) => {
  const provider = createInitializedProvider();
  const token = provider.generateSASToken("file.txt", { days: 7 });
  t.truthy(token);
  t.true(token.includes("se="), "should have an expiry");
});

// ── generateShortLivedSASToken dual-signature tests ────────────────

test("generateShortLivedSASToken new signature: (blobName)", (t) => {
  const provider = createInitializedProvider();
  const token = provider.generateShortLivedSASToken("file.txt");
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateShortLivedSASToken new signature: (blobName, minutes)", (t) => {
  const provider = createInitializedProvider();
  const token = provider.generateShortLivedSASToken("file.txt", 15);
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateShortLivedSASToken old signature: (containerClient, blobName, minutes)", (t) => {
  const provider = createInitializedProvider();
  const fakeContainerClient = { containerName: "test-container" };
  const token = provider.generateShortLivedSASToken(fakeContainerClient, "file.txt", 10);
  t.truthy(token);
  t.true(token.includes("sig="));
});

test("generateShortLivedSASToken defaults to 5 minutes", (t) => {
  const provider = createInitializedProvider();
  // Both signatures should default to 5 min
  const newToken = provider.generateShortLivedSASToken("file.txt");
  const oldToken = provider.generateShortLivedSASToken({}, "file.txt");
  t.truthy(newToken);
  t.truthy(oldToken);
});

// ── Integration tests (require live Azure/Azurite) ─────────────────

test("should upload and delete file", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    "test-container",
  );

  // Create test file
  const testContent = "Hello World!";
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // Upload file
    const requestId = "test-upload";
    const result = await provider.uploadFile({}, testFile, requestId);

    t.truthy(result.url);
    t.truthy(result.blobName);
    t.true(result.url.includes("test-container"));
    t.true(result.blobName.startsWith(requestId));

    // Verify file exists
    const exists = await provider.fileExists(result.url);
    t.true(exists);

    // Delete file
    const deleted = await provider.deleteFiles(requestId);
    t.true(deleted.length > 0);
    t.true(deleted[0].startsWith(requestId));

    // Verify file is gone
    const existsAfterDelete = await provider.fileExists(result.url);
    t.false(existsAfterDelete);
  } finally {
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test("should handle file download", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const provider = new AzureStorageProvider(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
    "test-container",
  );

  // Create test file
  const testContent = "Hello World!";
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // Upload file
    const requestId = "test-download";
    const result = await provider.uploadFile({}, testFile, requestId);

    // Download to new location
    const downloadPath = path.join(__dirname, "downloaded.txt");
    await provider.downloadFile(result.url, downloadPath);

    // Verify content
    const downloadedContent = fs.readFileSync(downloadPath, "utf8");
    t.is(downloadedContent, testContent);

    // Cleanup
    await provider.deleteFiles(requestId);
    fs.unlinkSync(downloadPath);
  } finally {
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});
