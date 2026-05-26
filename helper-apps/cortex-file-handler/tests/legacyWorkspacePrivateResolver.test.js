import test from "ava";

import {
  getLegacyWorkspacePrivateContextId,
  migrateHashRecordToScopedStorage,
  resolveBlobPathWithLegacyFallback,
  resolveHashRecordWithLegacyWorkspacePrivateFallback,
} from "../src/utils/legacyWorkspacePrivateResolver.js";
import {
  listLegacyScopedFolderFiles,
  resolveLegacyScopedBlobClient,
} from "../src/index.js";
import { StorageFactory } from "../src/services/storage/StorageFactory.js";
import {
  getDefaultContainerName,
  getLegacyUserContainerName,
  getUserContainerName,
} from "../src/constants.js";

const originalGetInstance = StorageFactory.getInstance;

test.afterEach.always(() => {
  StorageFactory.getInstance = originalGetInstance;
  StorageFactory.resetInstance();
});

test("getLegacyWorkspacePrivateContextId returns the legacy compound context for workspace-user-legacy scope", (t) => {
  t.is(
    getLegacyWorkspacePrivateContextId({
      userId: "user-123",
      workspaceId: "workspace-456",
      fileScope: "workspace-user-legacy",
    }),
    "workspace-456:user-123",
  );

  t.is(
    getLegacyWorkspacePrivateContextId({
      userId: "user-123",
      workspaceId: "workspace-456",
      fileScope: "chat",
    }),
    null,
  );
});

test("resolveHashRecordWithLegacyWorkspacePrivateFallback probes the legacy compound context", async (t) => {
  const calls = [];
  const result = await resolveHashRecordWithLegacyWorkspacePrivateFallback({
    hash: "hash-123",
    resolvedContextId: "user-123",
    userId: "user-123",
    workspaceId: "workspace-456",
    fileScope: "workspace-user-legacy",
    getFileStoreMap: async (...args) => {
      calls.push(args);
      return {
        url: "https://legacy.example/file.pdf",
        filename: "file.pdf",
      };
    },
  });

  t.deepEqual(calls, [["hash-123", true, "workspace-456:user-123"]]);
  t.deepEqual(result, {
    hashResult: {
      url: "https://legacy.example/file.pdf",
      filename: "file.pdf",
    },
    sourceContextId: "workspace-456:user-123",
    source: "legacy-workspace-private",
  });
});

test("migrateHashRecordToScopedStorage rewrites a legacy workspace-user-private record into the new scoped container", async (t) => {
  const uploaded = [];
  StorageFactory.getInstance = () => ({
    getAzureProvider: async (containerName) => ({
      containerName,
      uploadStream: async (
        context,
        filename,
        stream,
        contentType,
        retention,
        folderPath,
      ) => {
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        uploaded.push({
          context,
          filename,
          contentType,
          retention,
          folderPath,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        return {
          url: `https://example.blob.core.windows.net/${containerName}/${folderPath}/${filename}`,
        };
      },
    }),
  });

  const setCalls = [];
  const removeCalls = [];
  const hash = "hash-123";
  const resolvedContextId = "user-123";
  const sourceContextId = "workspace-456:user-123";
  const context = { log: () => {} };

  const result = await migrateHashRecordToScopedStorage({
    context,
    hash,
    hashResult: {
      url: "https://legacy.example/file.pdf",
      filename: "file.pdf",
      displayFilename: "file.pdf",
      mimeType: "application/pdf",
      permanent: true,
    },
    sourceContextId,
    resolvedContextId,
    userId: "user-123",
    workspaceId: "workspace-456",
    fileScope: "workspace-user-legacy",
    storageService: {
      getPrimaryProvider: async () => ({
        constructor: { name: "AzureStorageProvider" },
      }),
      downloadFile: async () => Buffer.from("legacy pdf bytes"),
    },
    setFileStoreMap: async (...args) => {
      setCalls.push(args);
    },
    removeFromFileStoreMap: async (...args) => {
      removeCalls.push(args);
    },
  });

  const targetContainerName = getUserContainerName(
    getDefaultContainerName(),
    resolvedContextId,
  );

  t.is(uploaded.length, 1);
  t.deepEqual(uploaded[0], {
    context,
    filename: "file.pdf",
    contentType: "application/pdf",
    retention: "permanent",
    folderPath: "applets/workspace-456",
    body: "legacy pdf bytes",
  });

  t.is(result.hash, hash);
  t.is(result.filename, "file.pdf");
  t.is(result.blobPath, "applets/workspace-456/file.pdf");
  t.is(
    result.url,
    `https://example.blob.core.windows.net/${targetContainerName}/applets/workspace-456/file.pdf`,
  );

  t.is(setCalls.length, 1);
  t.is(setCalls[0][0], hash);
  t.is(setCalls[0][2], resolvedContextId);
  t.is(setCalls[0][1].blobPath, "applets/workspace-456/file.pdf");
  t.is(setCalls[0][1].url, result.url);

  t.deepEqual(removeCalls, [[hash, sourceContextId]]);
});

test("resolveBlobPathWithLegacyFallback ensures a fresh GCS backup and persists it", async (t) => {
  const defaultContainerName = getDefaultContainerName();
  const legacyContextId = "workspace-456:user-123";
  const targetContextId = "user-123";
  const legacyContainerName = getLegacyUserContainerName(
    defaultContainerName,
    legacyContextId,
  );
  const targetContainerName = getUserContainerName(
    defaultContainerName,
    targetContextId,
  );
  const blobPath = "applets/workspace-456/file.pdf";

  const sourceBlobClient = {
    url: `https://example.blob.core.windows.net/${legacyContainerName}/${blobPath}`,
    exists: async () => true,
  };
  const targetBlobClient = {
    url: `https://example.blob.core.windows.net/${targetContainerName}/${blobPath}`,
    beginCopyFromURL: async () => ({
      pollUntilDone: async () => {},
    }),
  };

  const providers = new Map([
    [
      defaultContainerName,
      {
        containerName: defaultContainerName,
        ensureInitialized: async () => {},
        getBlobClient: async () => ({
          containerClient: {
            getBlockBlobClient: () => ({
              exists: async () => false,
            }),
          },
        }),
      },
    ],
    [
      legacyContainerName,
      {
        containerName: legacyContainerName,
        ensureInitialized: async () => {},
        getBlobClient: async () => ({
          containerClient: {
            getBlockBlobClient: () => sourceBlobClient,
          },
        }),
        generateShortLivedSASToken: () => "legacy-sas",
      },
    ],
    [
      targetContainerName,
      {
        containerName: targetContainerName,
        ensureInitialized: async () => {},
        getBlobClient: async () => ({
          containerClient: {
            getBlockBlobClient: () => targetBlobClient,
          },
        }),
        generateSASToken: () => "long-sas",
        generateShortLivedSASToken: () => "short-sas",
      },
    ],
  ]);

  StorageFactory.getInstance = () => ({
    getAzureProvider: async (containerName) => providers.get(containerName),
  });

  const setCalls = [];
  const result = await resolveBlobPathWithLegacyFallback({
    context: { log: () => {} },
    hash: "hash-123",
    blobPath,
    resolvedContextId: targetContextId,
    userId: "user-123",
    workspaceId: "workspace-456",
    fileScope: "workspace-user-legacy",
    storageService: {
      ensureGCSUpload: async (context, existingFile) => ({
        ...existingFile,
        gcs: "gs://cortextempfiles/fresh-file.pdf",
      }),
    },
    setFileStoreMap: async (...args) => {
      setCalls.push(args);
    },
  });

  t.is(
    result.url,
    `https://example.blob.core.windows.net/${targetContainerName}/${blobPath}?long-sas`,
  );
  t.is(
    result.shortLivedUrl,
    `https://example.blob.core.windows.net/${targetContainerName}/${blobPath}?short-sas`,
  );
  t.is(result.gcs, "gs://cortextempfiles/fresh-file.pdf");
  t.is(setCalls.length, 1);
  t.is(setCalls[0][0], "hash-123");
  t.is(setCalls[0][2], targetContextId);
  t.is(setCalls[0][1].gcs, "gs://cortextempfiles/fresh-file.pdf");
});

test("listLegacyScopedFolderFiles returns files from the legacy scoped container name", async (t) => {
  const containerOwnerId = "shared:user_123";
  const defaultContainerName = getDefaultContainerName();
  const legacyContainerName = getLegacyUserContainerName(
    defaultContainerName,
    containerOwnerId,
  );
  const blobName = "global/abc123_shared-file.txt";

  StorageFactory.getInstance = () => ({
    getAzureProvider: async (containerName) => ({
      ensureInitialized: async () => {},
      _containerClient: {
        listBlobsFlat: async function* ({ prefix }) {
          t.is(containerName, legacyContainerName);
          t.is(prefix, "global/");
          yield {
            name: blobName,
            properties: {
              lastModified: new Date("2024-01-01T00:00:00Z"),
              contentType: "text/plain",
              contentLength: 42,
            },
          };
        },
        getBlockBlobClient: (currentBlobName) => ({
          url: `https://example.blob.core.windows.net/${containerName}/${currentBlobName}`,
        }),
      },
      generateShortLivedSASToken: () => "legacy-short-sas",
    }),
  });

  const files = await listLegacyScopedFolderFiles(containerOwnerId, "global");

  t.is(files.length, 1);
  t.is(files[0].hash, "abc123");
  t.is(files[0].filename, "shared-file.txt");
  t.true(files[0].url.includes(legacyContainerName));
});

test("resolveLegacyScopedBlobClient finds blobs in the legacy scoped container name", async (t) => {
  const containerOwnerId = "shared:user_123";
  const defaultContainerName = getDefaultContainerName();
  const legacyContainerName = getLegacyUserContainerName(
    defaultContainerName,
    containerOwnerId,
  );
  const blobPath = "global/abc123_shared-file.txt";

  StorageFactory.getInstance = () => ({
    getAzureProvider: async (containerName) => ({
      ensureInitialized: async () => {},
      _containerClient: {
        getBlockBlobClient: (currentBlobPath) => ({
          url: `https://example.blob.core.windows.net/${containerName}/${currentBlobPath}`,
          exists: async () => {
            t.is(currentBlobPath, blobPath);
            return true;
          },
        }),
      },
    }),
  });

  const result = await resolveLegacyScopedBlobClient(
    containerOwnerId,
    blobPath,
  );

  t.truthy(result);
  t.is(result.containerName, legacyContainerName);
  t.truthy(result.blockBlobClient);
  t.true(result.blockBlobClient.url.includes(legacyContainerName));
});
