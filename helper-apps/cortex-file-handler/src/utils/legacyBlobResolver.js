import { getStorageGrant } from '../security/storageGrant.js';
import { assertGrantedStorageUrl } from '../security/grantRequest.js';
import { assertLegacySharedRead } from '../security/legacyRead.js';
import path from "path";

import { constructFolderPath } from "../blobHandler.js";
import {
  getDefaultContainerName,
  getUserContainerName,
} from "../constants.js";
import { StorageFactory } from "../services/storage/StorageFactory.js";
import { sanitizeFilename } from "./filenameUtils.js";

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

  let start = 0;
  let end = folderPath.length;
  while (start < end && folderPath[start] === "/") start += 1;
  while (end > start && folderPath[end - 1] === "/") end -= 1;
  const normalizedFolder = folderPath.slice(start, end);
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
    try {
      assertGrantedStorageUrl(blockBlobClient.url);
    } catch (error) {
      if (error.status === 403) continue;
      throw error;
    }
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

async function buildLegacyBlobCandidates({ blobPath, owner, rootOnly = false } = {}) {
  if (!blobPath) {
    return [];
  }

  const defaultContainerName = getDefaultContainerName();
  if (getStorageGrant()) {
    if (!owner) return [];
    const provider = await getAzureProviderForContainer(defaultContainerName);
    const candidates = rootOnly ? [] : [{ label: 'owner-prefixed', provider,
      blobPath: blobPath.startsWith(`users/${owner}/`) ? blobPath : `users/${owner}/${blobPath}` }];
    try {
      assertLegacySharedRead(blobPath, owner);
      candidates.push({ label: 'default-root', provider, blobPath });
    } catch (error) {
      if (error.status !== 403) throw error;
    }
    return candidates;
  }
  return [
    {
      label: "default-root",
      provider: await getAzureProviderForContainer(defaultContainerName),
      blobPath,
    },
  ];
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
  rootOnly = false,
} = {}) {
  if (!blobPath) {
    return null;
  }

  const source = await findExistingLegacyBlob(
    blobPath,
    await buildLegacyBlobCandidates({ blobPath, rootOnly, owner: getTargetContainerOwnerId({ resolvedContextId, userId, workspaceId, fileScope }) }),
  );

  if (!source) {
    return null;
  }

  if (getStorageGrant()) {
    const sas = source.provider.generateShortLivedSASToken(source.blobPath, 5);
    const url = `${source.blockBlobClient.url}?${sas}`;
    return { url, shortLivedUrl: url, blobPath, filename: path.basename(blobPath), ...(hash ? { hash } : {}) };
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
  assertGrantedStorageUrl(targetBlobClient.url, "upload");

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
