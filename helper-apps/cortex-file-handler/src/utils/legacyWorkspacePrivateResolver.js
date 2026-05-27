import path from "path";
import { Readable } from "stream";

import { constructFolderPath, getMimeTypeFromUrl } from "../blobHandler.js";
import {
  getDefaultContainerName,
  getUserContainerName,
  getUserContainerNameCandidates,
} from "../constants.js";
import { StorageFactory } from "../services/storage/StorageFactory.js";
import { sanitizeFilename } from "./filenameUtils.js";

export function getLegacyWorkspacePrivateContextId({
  userId = null,
  workspaceId = null,
  fileScope = null,
} = {}) {
  if (fileScope !== "workspace-user-legacy" || !userId || !workspaceId) {
    return null;
  }
  return `${workspaceId}:${userId}`;
}

export async function resolveHashRecordWithLegacyWorkspacePrivateFallback({
  hash,
  resolvedContextId = null,
  userId = null,
  workspaceId = null,
  fileScope = null,
  getFileStoreMap,
}) {
  if (!hash || !resolvedContextId || typeof getFileStoreMap !== "function") {
    return null;
  }

  const legacyContextId = getLegacyWorkspacePrivateContextId({
    userId,
    workspaceId,
    fileScope,
  });

  if (!legacyContextId || legacyContextId === resolvedContextId) {
    return null;
  }

  const hashResult = await getFileStoreMap(hash, true, legacyContextId);
  if (!hashResult) {
    return null;
  }

  return {
    hashResult,
    sourceContextId: legacyContextId,
    source: "legacy-workspace-private",
  };
}

function getCanonicalFilename(hashResult, fallback = "file") {
  const preferred =
    hashResult?.displayFilename ||
    hashResult?.filename ||
    (() => {
      try {
        if (!hashResult?.url) return null;
        const url = new URL(hashResult.url);
        return decodeURIComponent(path.basename(url.pathname));
      } catch {
        return null;
      }
    })() ||
    fallback;

  const sanitized = sanitizeFilename(preferred);
  return sanitized || fallback;
}

async function downloadLegacyBuffer(storageService, hashResult) {
  const candidates = [hashResult?.url, hashResult?.gcs].filter(Boolean);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await storageService.downloadFile(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No legacy source available for migration");
}

async function persistResolvedRecord({
  hash,
  hashResult,
  sourceContextId = null,
  resolvedContextId = null,
  setFileStoreMap,
  removeFromFileStoreMap,
}) {
  const normalized = {
    ...hashResult,
    hash: hashResult?.hash || hash,
  };
  delete normalized.shortLivedUrl;

  await setFileStoreMap(hash, normalized, resolvedContextId);
  if (
    sourceContextId &&
    sourceContextId !== resolvedContextId &&
    typeof removeFromFileStoreMap === "function"
  ) {
    await removeFromFileStoreMap(hash, sourceContextId);
  }

  return normalized;
}

export async function migrateHashRecordToScopedStorage({
  context,
  hash,
  hashResult,
  sourceContextId = null,
  resolvedContextId = null,
  userId = null,
  chatId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
  storageService,
  setFileStoreMap,
  removeFromFileStoreMap,
}) {
  if (
    !hash ||
    !hashResult ||
    !resolvedContextId ||
    !userId ||
    sourceContextId === resolvedContextId ||
    typeof setFileStoreMap !== "function"
  ) {
    return hashResult;
  }

  const folderPath = constructFolderPath({
    userId,
    chatId,
    workspaceId,
    appletId,
    contextId: resolvedContextId,
    fileScope,
  });

  if (folderPath === null) {
    return await persistResolvedRecord({
      hash,
      hashResult,
      sourceContextId,
      resolvedContextId,
      setFileStoreMap,
      removeFromFileStoreMap,
    });
  }

  const primaryProvider = await storageService.getPrimaryProvider();
  const isAzureProvider =
    primaryProvider?.constructor?.name === "AzureStorageProvider";

  if (!isAzureProvider) {
    return await persistResolvedRecord({
      hash,
      hashResult,
      sourceContextId,
      resolvedContextId,
      setFileStoreMap,
      removeFromFileStoreMap,
    });
  }

  const buffer = await downloadLegacyBuffer(storageService, hashResult);
  const uploadName = getCanonicalFilename(hashResult, `${hash}.bin`);
  const contentType =
    hashResult?.mimeType || getMimeTypeFromUrl(hashResult?.url || "");
  const targetContainerName = getUserContainerName(
    getDefaultContainerName(),
    userId,
  );
  const targetProvider = await StorageFactory.getInstance().getAzureProvider(
    targetContainerName,
  );
  const uploadResult = await targetProvider.uploadStream(
    context || {},
    uploadName,
    Readable.from([buffer]),
    contentType,
    folderPath,
  );

  const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, "");
  const blobPath = normalizedFolder
    ? `${normalizedFolder}/${uploadName}`
    : uploadName;

  const migrated = {
    ...hashResult,
    url: uploadResult.url,
    blobPath,
    folderPath,
    filename: uploadName,
    hash: hashResult.hash || hash,
  };

  delete migrated.shortLivedUrl;
  delete migrated.converted;

  return await persistResolvedRecord({
    hash,
    hashResult: migrated,
    sourceContextId,
    resolvedContextId,
    setFileStoreMap,
    removeFromFileStoreMap,
  });
}

function getTargetContainerOwnerId({
  resolvedContextId = null,
  userId = null,
  workspaceId = null,
  fileScope = null,
} = {}) {
  if (fileScope === "workspace-shared-legacy" && workspaceId) {
    return workspaceId;
  }
  return userId || resolvedContextId || null;
}

function getCanonicalTargetBlobPath(blobPath, {
  contextId = null,
  userId = null,
  chatId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
} = {}) {
  const normalizedName = sanitizeFilename(path.basename(blobPath || ""));
  if (!normalizedName) {
    return null;
  }

  const folderPath = constructFolderPath({
    userId,
    chatId,
    workspaceId,
    appletId,
    contextId,
    fileScope,
  });

  if (folderPath === null) {
    return normalizedName;
  }

  const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, "");
  return normalizedFolder
    ? `${normalizedFolder}/${normalizedName}`
    : normalizedName;
}

async function getAzureProviderForContainer(containerName) {
  return await StorageFactory.getInstance().getAzureProvider(containerName);
}

async function findExistingLegacyBlob(blobPath, providers = []) {
  for (const entry of providers) {
    if (!entry?.provider || !entry?.blobPath) {
      continue;
    }

    await entry.provider.ensureInitialized();
    const { containerClient } = await entry.provider.getBlobClient();
    const blockBlobClient = containerClient.getBlockBlobClient(entry.blobPath);
    const exists = await blockBlobClient.exists();
    if (exists) {
      return {
        ...entry,
        containerClient,
        blockBlobClient,
      };
    }
  }

  return null;
}

async function buildLegacyBlobCandidates({
  blobPath,
  userId = null,
  workspaceId = null,
  fileScope = null,
} = {}) {
  if (!blobPath) {
    return [];
  }

  const defaultContainerName = getDefaultContainerName();
  const candidates = [
    {
      label: "default-root",
      provider: await getAzureProviderForContainer(defaultContainerName),
      blobPath,
    },
  ];

  const legacyContextId = getLegacyWorkspacePrivateContextId({
    userId,
    workspaceId,
    fileScope,
  });

  if (legacyContextId) {
    const legacyContainerNames = getUserContainerNameCandidates(
      defaultContainerName,
      legacyContextId,
    ).filter((containerName) => containerName !== defaultContainerName);
    for (const legacyContainerName of legacyContainerNames) {
      candidates.push({
        label: "legacy-compound-container",
        provider: await getAzureProviderForContainer(legacyContainerName),
        blobPath,
      });
    }
  }

  return candidates;
}

export async function resolveBlobPathWithLegacyFallback({
  context,
  hash = null,
  blobPath,
  resolvedContextId = null,
  userId = null,
  chatId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
  storageService,
  setFileStoreMap,
} = {}) {
  if (!blobPath) {
    return null;
  }

  const source = await findExistingLegacyBlob(
    blobPath,
    await buildLegacyBlobCandidates({
      blobPath,
      userId,
      workspaceId,
      fileScope,
    }),
  );

  if (!source) {
    return null;
  }

  const targetOwnerId = getTargetContainerOwnerId({
    resolvedContextId,
    userId,
    workspaceId,
    fileScope,
  });
  const targetContainerName = targetOwnerId
    ? getUserContainerName(getDefaultContainerName(), targetOwnerId)
    : getDefaultContainerName();
  const targetProvider = await getAzureProviderForContainer(targetContainerName);
  const targetBlobPath = getCanonicalTargetBlobPath(blobPath, {
    contextId: resolvedContextId,
    userId,
    chatId,
    workspaceId,
    appletId,
    fileScope,
  }) || blobPath;

  await targetProvider.ensureInitialized();
  const { containerClient: targetContainerClient } =
    await targetProvider.getBlobClient();
  const targetBlobClient =
    targetContainerClient.getBlockBlobClient(targetBlobPath);

  if (
    source.provider.containerName !== targetProvider.containerName ||
    source.blobPath !== targetBlobPath
  ) {
    const sourceSas = source.provider.generateShortLivedSASToken(
      source.blobPath,
      10,
    );
    const sourceUrl = `${source.blockBlobClient.url}?${sourceSas}`;
    const copyPoller = await targetBlobClient.beginCopyFromURL(sourceUrl);
    await copyPoller.pollUntilDone();
    context?.log?.(
      `Legacy blob self-healed: ${blobPath} -> ${targetBlobPath} (${source.label})`,
    );
  } else {
    context?.log?.(`Legacy blob found in-place: ${blobPath} (${source.label})`);
  }

  const sasToken = targetProvider.generateSASToken(targetBlobPath);
  const shortLivedSasToken = targetProvider.generateShortLivedSASToken(
    targetBlobPath,
    5,
  );
  const url = `${targetBlobClient.url}?${sasToken}`;
  const shortLivedUrl = `${targetBlobClient.url}?${shortLivedSasToken}`;
  const filename = sanitizeFilename(path.basename(targetBlobPath));

  const result = {
    url,
    shortLivedUrl,
    blobPath: targetBlobPath,
    filename,
    ...(hash ? { hash } : {}),
  };

  try {
    const withBackup = await storageService?.ensureGCSUpload?.(context || {}, {
      ...result,
      blobName: targetBlobPath,
    });
    if (withBackup?.gcs) {
      result.gcs = withBackup.gcs;
    }
  } catch (error) {
    context?.log?.(
      `Warning: Could not ensure GCS backup for ${targetBlobPath}: ${error.message}`,
    );
  }

  if (hash && resolvedContextId && typeof setFileStoreMap === "function") {
    await setFileStoreMap(
      hash,
      {
        url,
        blobPath: targetBlobPath,
        filename,
        hash,
        ...(result.gcs ? { gcs: result.gcs } : {}),
      },
      resolvedContextId,
    );
  }

  return result;
}
