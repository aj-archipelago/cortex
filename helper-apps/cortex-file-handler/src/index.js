import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import mime from "mime-types";

import {
  DOC_EXTENSIONS,
  AZURITE_ACCOUNT_NAME,
  getDefaultContainerName,
  getUserContainerName,
  getUserContainerNameCandidates,
} from "./constants.js";
import { easyChunker } from "./docHelper.js";
import { downloadFile, splitMediaFile } from "./fileChunker.js";
import { ensureEncoded, ensureFileExtension, urlExists } from "./helper.js";
import {
  cleanupRedisFileStoreMap,
  getCachedValue,
  getFileStoreMap,
  getAllFilesForContext,
  publishRequestProgress,
  removeFromFileStoreMap,
  setFileStoreMap,
  setCachedValue,
  cleanupRedisFileStoreMapAge,
} from "./redis.js";
import { FileConversionService } from "./services/FileConversionService.js";
import { StorageService } from "./services/storage/StorageService.js";
import {
  uploadBlob,
  getMimeTypeFromUrl,
  constructFolderPath,
  sanitizeSubPath,
  getScopedContainerOwnerId,
  getScopedLogicalContextId,
} from "./blobHandler.js";
import { StorageFactory } from "./services/storage/StorageFactory.js";
import { generateShortId, sanitizeFilename } from "./utils/filenameUtils.js";
import { sanitizeTargetBlobPath } from "./utils/targetBlobPathUtils.js";
import { redactContextId, redactSasToken, sanitizeForLogging } from "./utils/logSecurity.js";
import {
  resolveBlobPathWithLegacyFallback,
} from "./utils/legacyBlobResolver.js";

// Lazy cleanup remains in getFileStoreMap for entries whose backing files are
// actually gone. Age/container cleanup is opt-in because Redis hash records are
// needed to resolve legacy files whose blobs still exist.
let requestCount = 0;
const inFlightListNames = new Map();

function isEnabled(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

/**
 * Extract the container name from an Azure blob URL.
 * Handles both real Azure URLs (/{container}/blob) and Azurite URLs (/devstoreaccount1/{container}/blob).
 */
function extractContainerFromUrl(url) {
  try {
    const urlObj = new URL(url);
    let pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
    // Azurite: /devstoreaccount1/{container}/blob → skip account name
    if (pathParts[0] === AZURITE_ACCOUNT_NAME) {
      pathParts = pathParts.slice(1);
    }
    return pathParts[0] || null;
  } catch { return null; }
}

/**
 * Extract the blob name (everything after the container) from an Azure blob URL.
 */
function extractBlobNameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const decodedPath = decodeURIComponent(urlObj.pathname);
    let pathParts = decodedPath.split('/').filter(p => p.length > 0);
    if (pathParts[0] === AZURITE_ACCOUNT_NAME) {
      pathParts = pathParts.slice(1);
    }
    // First part is container, rest is blob name
    return pathParts.length > 1 ? pathParts.slice(1).join('/') : null;
  } catch { return null; }
}

async function getScopedProvider({
  storageService,
  resolvedContextId = null,
  userId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
} = {}) {
  const containerOwnerId = getScopedContainerOwnerId({
    contextId: resolvedContextId,
    userId,
    workspaceId,
    appletId,
    fileScope,
  });
  const containerName = containerOwnerId
    ? getUserContainerName(getDefaultContainerName(), containerOwnerId)
    : null;
  const useScopedAzureProvider =
    containerName
    && storageService.primaryProvider?.constructor?.name === "AzureStorageProvider";

  return {
    containerOwnerId,
    containerName,
    provider: useScopedAzureProvider
      ? await StorageFactory.getInstance().getAzureProvider(containerName)
      : storageService.primaryProvider,
  };
}

function isNotFoundError(error) {
  const message = error?.message || "";
  return error?.statusCode === 404 || /not found/i.test(message);
}

function getLegacyScopedContainerNames(containerOwnerId = null) {
  if (!containerOwnerId) {
    return [];
  }

  const [, ...legacyContainerNames] = getUserContainerNameCandidates(
    getDefaultContainerName(),
    containerOwnerId,
  );
  return legacyContainerNames;
}

function getListedFileKey(file = {}) {
  return file.hash || file.name || file.url || file.filename || null;
}

function mergeListedFiles(primaryFiles = [], fallbackFiles = []) {
  const merged = [...primaryFiles];
  const seen = new Set(primaryFiles.map((file) => getListedFileKey(file)).filter(Boolean));

  for (const file of fallbackFiles) {
    const key = getListedFileKey(file);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    merged.push(file);
  }

  return merged;
}

function parseBoundedPositiveInt(value, defaultValue, maxValue) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

function trimLeadingTrailingSlashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function sanitizeListNamesSubPath(subPath) {
  if (!subPath || typeof subPath !== 'string') return null;

  const trimmedPath = trimLeadingTrailingSlashes(subPath.split('\\').join('/'));
  const pathSegments = trimmedPath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (pathSegments.length === 0) return null;
  if (pathSegments.some((segment) => (
    segment === '.'
    || segment === '..'
    || /[\x00-\x1F\x7F]/.test(segment)
  ))) {
    return null;
  }

  return pathSegments.join('/');
}

function getListedNameKey(item = []) {
  if (Array.isArray(item)) {
    return item[0] || null;
  }
  return item.blobPath || item.name || null;
}

function mergeListedNameItems(primaryItems = [], fallbackItems = [], maxResults = 10000) {
  const merged = [];
  const seen = new Set();

  for (const item of [...primaryItems, ...fallbackItems]) {
    const key = getListedNameKey(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(Array.isArray(item)
      ? item
      : [item.blobPath || item.name, item.size ?? null, item.lastModified || item.updatedAt || null]);
    if (merged.length >= maxResults) {
      break;
    }
  }

  return merged;
}

function listNamesCacheKey({
  providerType = 'unknown',
  containerName = null,
  folderPath = '',
  maxResults = 10000,
} = {}) {
  const normalizedProvider = providerType || 'unknown';
  const normalizedContainer = containerName || 'default';
  const normalizedFolder = folderPath || '';
  return `CFH:listNames:v2:${normalizedProvider}:${normalizedContainer}:${normalizedFolder}:${maxResults}`;
}

async function listNamesWithCache(provider, folderPath, options = {}) {
  const maxResults = parseBoundedPositiveInt(options.maxResults, 10000, 50000);
  const ttlSeconds = parseBoundedPositiveInt(
    process.env.CFH_LIST_NAMES_CACHE_TTL_SECONDS,
    30,
    300,
  );
  const cacheKey = listNamesCacheKey({
    providerType: provider?.constructor?.name || 'unknown',
    containerName: provider?.containerName || provider?.bucketName || null,
    folderPath,
    maxResults,
  });
  const cached = await getCachedValue(cacheKey);
  if (cached?.items && Array.isArray(cached.items)) {
    return { ...cached, cacheHit: true };
  }

  if (inFlightListNames.has(cacheKey)) {
    const result = await inFlightListNames.get(cacheKey);
    return { ...result, cacheHit: true, inFlightHit: true };
  }

  const loadPromise = (async () => {
    const result = await provider.listNames(folderPath, { ...options, maxResults });
    await setCachedValue(cacheKey, result, ttlSeconds);
    return result;
  })();

  inFlightListNames.set(cacheKey, loadPromise);
  try {
    const result = await loadPromise;
    return { ...result, cacheHit: false };
  } finally {
    inFlightListNames.delete(cacheKey);
  }
}

async function listAzureFolderIfContainerExists(provider, folderPath) {
  if (!provider?.ensureInitialized) {
    return [];
  }

  try {
    await provider.ensureInitialized();
    const containerClient = provider._containerClient;
    if (!containerClient) {
      return [];
    }

    const prefix = folderPath === '' ? undefined : (folderPath.endsWith('/') ? folderPath : `${folderPath}/`);
    const results = [];

    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
      const rawFilename = blob.name.split('/').pop();
      let filename;
      try {
        filename = decodeURIComponent(rawFilename);
      } catch {
        filename = rawFilename;
      }

      const hashMatch = filename.match(/^([a-f0-9]+)_/i);
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      const sasToken = provider.generateShortLivedSASToken(blob.name, 60);

      results.push({
        name: blob.name,
        filename: hashMatch ? filename.replace(/^[a-f0-9]+_/i, '') : filename,
        hash: hashMatch ? hashMatch[1] : null,
        lastModified: blob.properties.lastModified,
        contentType: blob.properties.contentType,
        size: blob.properties.contentLength,
        url: `${blockBlobClient.url}?${sasToken}`,
      });
    }

    return results;
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function listAzureFolderNamesIfContainerExists(provider, folderPath, options = {}) {
  if (typeof provider?.listNames !== "function") {
    return { items: [], truncated: false };
  }

  try {
    return await listNamesWithCache(provider, folderPath, options);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { items: [], truncated: false };
    }
    throw error;
  }
}

export async function listLegacyScopedFolderFiles(containerOwnerId, folderPath) {
  const files = [];
  for (const containerName of getLegacyScopedContainerNames(containerOwnerId)) {
    try {
      const provider = await StorageFactory.getInstance().getAzureProvider(
        containerName,
      );
      const legacyFiles = await listAzureFolderIfContainerExists(
        provider,
        folderPath,
      );
      files.push(...legacyFiles);
    } catch (error) {
      if (/Missing Azure Storage connection string or container name/i.test(error?.message || "")) {
        return files;
      }
      throw error;
    }
  }
  return files;
}

export async function listLegacyScopedFolderNames(containerOwnerId, folderPath, options = {}) {
  const items = [];
  let truncated = false;
  let cacheHit = false;
  let inFlightHit = false;
  for (const containerName of getLegacyScopedContainerNames(containerOwnerId)) {
    try {
      const provider = await StorageFactory.getInstance().getAzureProvider(
        containerName,
      );
      const legacyResult = await listAzureFolderNamesIfContainerExists(
        provider,
        folderPath,
        options,
      );
      items.push(...(legacyResult.items || []));
      truncated = truncated || legacyResult.truncated === true;
      cacheHit = cacheHit || legacyResult.cacheHit === true;
      inFlightHit = inFlightHit || legacyResult.inFlightHit === true;
    } catch (error) {
      if (/Missing Azure Storage connection string or container name/i.test(error?.message || "")) {
        return { items, truncated, cacheHit, inFlightHit };
      }
      throw error;
    }
  }
  return { items, truncated, cacheHit, inFlightHit };
}

export async function resolveLegacyScopedBlobClient(containerOwnerId, blobPath) {
  if (!containerOwnerId || !blobPath) {
    return null;
  }

  for (const containerName of getLegacyScopedContainerNames(containerOwnerId)) {
    let provider;
    try {
      provider = await StorageFactory.getInstance().getAzureProvider(
        containerName,
      );
    } catch (error) {
      if (/Missing Azure Storage connection string or container name/i.test(error?.message || "")) {
        return null;
      }
      throw error;
    }

    try {
      await provider.ensureInitialized();
      const containerClient = provider._containerClient;
      if (!containerClient) {
        continue;
      }

      const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
      if (await blockBlobClient.exists()) {
        return {
          containerName,
          provider,
          containerClient,
          blockBlobClient,
        };
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

/**
 * Delete up to `limit` empty per-user blob containers.
 * Per-user containers follow the naming pattern `{baseName}-{userId}`.
 * Fire-and-forget — errors are logged, never thrown.
 */
async function cullEmptyContainers(context, limit = 20) {
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) return;

  const baseName = getDefaultContainerName();
  const prefix = `${baseName}-`;
  const blobService = BlobServiceClient.fromConnectionString(connStr);

  let deleted = 0;
  for await (const container of blobService.listContainers({ prefix })) {
    if (deleted >= limit) break;
    try {
      const client = blobService.getContainerClient(container.name);
      const iter = client.listBlobsFlat().byPage({ maxPageSize: 1 });
      const page = await iter.next();
      const hasBlobs = page.value?.segment?.blobItems?.length > 0;
      if (!hasBlobs) {
        await client.delete();
        deleted++;
        context.log(`Culled empty container: ${container.name}`);
      }
    } catch (err) {
      if (err.statusCode !== 404) {
        console.log(`Container cull error (${container.name}): ${err.message}`);
      }
    }
  }
  if (deleted > 0) {
    context.log(`Container cull: deleted ${deleted} empty container(s)`);
  }
}

/**
 * Lightweight age-based cleanup - removes old cache entries to prevent bloat
 * Only removes entries older than 7 days and only checks a small sample
 * Runs every 100 requests to avoid performance impact
 */
async function cleanupInactive(context) {
  try {
    requestCount++;
    if (
      isEnabled(process.env.CFH_ENABLE_FILESTORE_AGE_CLEANUP)
      && requestCount % 100 === 0
    ) {
      const cleaned = await cleanupRedisFileStoreMapAge(7, 10); // 7 days, max 10 entries
      if (cleaned.length > 0) {
        context.log(`Age cleanup: Removed ${cleaned.length} old cache entries`);
      }
    }
    // Empty-container culling is opt-in; it can race with newly created upload containers.
    if (
      isEnabled(process.env.CFH_ENABLE_EMPTY_CONTAINER_CULL)
      && requestCount % 100 === 0
    ) {
      cullEmptyContainers(context).catch(() => {});
    }
  } catch (error) {
    console.log("Error occurred during age-based cleanup:", error);
  }
}

async function CortexFileHandler(context, req) {
  // Parse body if it's a string (Azure Functions sometimes doesn't auto-parse DELETE bodies)
  let parsedBody = req.body;
  if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      // If parsing fails, treat as empty object
      parsedBody = {};
    }
  }

  // For GET requests, prioritize query string. For other methods, check body first, then query
  // Also check if parsedBody actually has content (not just empty object)
  const hasBodyContent = parsedBody && typeof parsedBody === 'object' && Object.keys(parsedBody).length > 0;
  const bodySource = hasBodyContent ? (parsedBody.params || parsedBody) : {};
  const querySource = req.query || {};

  // Merge sources: for GET, query takes priority; for others, body takes priority
  const isGet = req.method?.toLowerCase() === 'get';
  const source = isGet ? { ...bodySource, ...querySource } : { ...querySource, ...bodySource };

  const {
    uri,
    requestId,
    save,
    hash,
    checkHash,
    clearHash,
    shortLivedMinutes,
    fetch,
    load,
    restore,
    rename,
    newFilename,
    filename: clientFilename,
    contextId,
    chunkOverlapSeconds,
    blobPath,
    // Folder-based storage parameters
    listFolder,
    listNames,
    maxResults,
    userId,
    chatId,
    workspaceId,
    appletId,
    fileScope,
    subPath,
  } = source;
  const logicalContextId = getScopedLogicalContextId({
    contextId: contextId || null,
    userId,
    workspaceId,
    appletId,
    fileScope,
  });
  const storageOwnerId = getScopedContainerOwnerId({
    contextId: logicalContextId,
    userId,
    workspaceId,
    appletId,
    fileScope,
  });

  // Normalize boolean parameters
  const shouldSave = save === true || save === "true";
  const shouldCheckHash = checkHash === true || checkHash === "true";
  const shouldClearHash = clearHash === true || clearHash === "true";
  const shortLivedDuration = parseInt(shortLivedMinutes) || 5; // Default to 5 minutes
  const shouldFetchRemote = fetch || load || restore;



  const shouldRename = rename === true || rename === "true" ||
                        (req.query?.operation === "rename") || (parsedBody?.operation === "rename");
  const shouldListFolder = listFolder === true || listFolder === "true" ||
                            (req.query?.operation === "listFolder") || (parsedBody?.operation === "listFolder");
  const shouldListNames = listNames === true || listNames === "true" ||
                            (req.query?.operation === "listNames") || (parsedBody?.operation === "listNames");

  // Determine operation using explicit if-else chain
  let operation;
  if (shouldSave) {
    operation = "save";
  } else if (shouldCheckHash) {
    operation = "checkHash";
  } else if (shouldClearHash) {
    operation = "clearHash";
  } else if (shouldRename) {
    operation = "rename";
  } else if (shouldListNames) {
    operation = "listNames";
  } else if (shouldListFolder) {
    operation = "listFolder";
  } else if (shouldFetchRemote) {
    operation = "remoteFile";
  } else if (req.method.toLowerCase() === "delete" ||
             (req.query?.operation === "delete") || (parsedBody?.operation === "delete")) {
    operation = "delete";
  } else if (uri) {
    if (DOC_EXTENSIONS.some((ext) => uri.toLowerCase().endsWith(ext))) {
      operation = "document_processing";
    } else {
      operation = "media_chunking";
    }
  } else if (blobPath && isGet) {
    operation = "blobLookup";
  } else if (hash && isGet) {
    operation = "hashLookup";
  } else {
    operation = "upload";
  }

  context.log(
    `Processing ${req.method} request - ${requestId ? `requestId: ${requestId}, ` : ""}${uri ? `uri: ${redactSasToken(uri)}, ` : ""}${hash ? `hash: ${hash}, ` : ""}${blobPath ? `blobPath: ${blobPath}, ` : ""}${logicalContextId ? `contextId: ${redactContextId(logicalContextId)}, ` : ""}operation: ${operation}`,
  );

  // Trigger lightweight age-based cleanup (runs every 100 requests)
  cleanupInactive(context);

  // Initialize services
  const storageService = new StorageService();
  await storageService._initialize(); // Ensure providers are initialized
  const conversionService = new FileConversionService(
    context,
    storageService.primaryProvider.constructor.name === "AzureStorageProvider",
    null,
  );

  // Validate URL for document processing and media chunking operations
  if (operation === "document_processing" || operation === "media_chunking") {
    try {
      const urlObj = new URL(uri);
      if (!["http:", "https:", "gs:"].includes(urlObj.protocol)) {
        context.res = {
          status: 400,
          body: "Invalid URL protocol - only HTTP, HTTPS, and GCS URLs are supported",
        };
        return;
      }
      // Check if the pathname is too long (e.g., > 1024 characters)
      if (urlObj.pathname.length > 1024) {
        context.res = {
          status: 400,
          body: "URL pathname is too long",
        };
        return;
      }
    } catch (error) {
      context.res = {
        status: 400,
        body: "Invalid URL format",
      };
      return;
    }
  }

  // Clean up files when request delete which means processing marked completed
  // Supports two modes:
  // 1. Delete multiple files by requestId (existing behavior)
  // 2. Delete single file by hash (new behavior)
  if (operation === "delete") {
    // Check both query string and body params for delete parameters
    // Handle both req.body.params.hash and req.body.hash formats
    const deleteRequestId = req.query.requestId || parsedBody?.params?.requestId || parsedBody?.requestId || requestId;
    const deleteHash = req.query.hash || parsedBody?.params?.hash || parsedBody?.hash || hash;

    // If only hash is provided, delete single file by hash
    if (deleteHash && !deleteRequestId) {
      try {
        const deleted = await storageService.deleteFileByHash(deleteHash, logicalContextId);
        if (deleted.alreadyDeleted) {
          context.res = {
            status: 404,
            body: `File with hash ${deleteHash} not found`,
          };
          return;
        }
        context.res = {
          status: 200,
          body: {
            message: `File with hash ${deleteHash} deleted successfully`,
            deleted
          },
        };
        return;
      } catch (error) {
        context.res = {
          status: 404,
          body: error.message,
        };
        return;
      }
    }

    // Delete by blobPath: directly delete the blob from storage without Redis lookup
    const deleteBlobPath = req.query.blobPath || parsedBody?.params?.blobPath || parsedBody?.blobPath || blobPath;
    if (deleteBlobPath && !deleteRequestId) {
      try {
        const { provider } = await getScopedProvider({
          storageService,
          resolvedContextId: logicalContextId,
          userId,
          workspaceId,
          appletId,
          fileScope,
        });
        const { containerClient } = await provider.getBlobClient();
        const blockBlobClient = containerClient.getBlockBlobClient(deleteBlobPath);
        await blockBlobClient.delete();
        context.log(`Deleted blob by blobPath: ${deleteBlobPath}`);
        context.res = {
          status: 200,
          body: {
            message: `File deleted successfully`,
            blobPath: deleteBlobPath,
          },
        };
        return;
      } catch (error) {
        if (isNotFoundError(error)) {
          try {
            const legacyBlob = await resolveLegacyScopedBlobClient(
              logicalContextId || storageOwnerId,
              deleteBlobPath,
            );
            if (legacyBlob) {
              await legacyBlob.blockBlobClient.delete();
              context.log(`Deleted legacy blob by blobPath: ${deleteBlobPath} (${legacyBlob.containerName})`);
              context.res = {
                status: 200,
                body: {
                  message: `File deleted successfully`,
                  blobPath: deleteBlobPath,
                },
              };
              return;
            }
          } catch (legacyError) {
            context.res = {
              status: legacyError.statusCode === 404 ? 404 : 500,
              body: `Error deleting blob ${deleteBlobPath}: ${legacyError.message}`,
            };
            return;
          }
        }
        context.res = {
          status: error.statusCode === 404 ? 404 : 500,
          body: `Error deleting blob ${deleteBlobPath}: ${error.message}`,
        };
        return;
      }
    }

    // If requestId is provided, use the existing multi-file delete flow
    if (!deleteRequestId) {
      context.res = {
        status: 400,
        body: "Please pass either a requestId, hash, or blobPath in the query string or request body",
      };
      return;
    }

    // First, get the hash from the map if it exists
    if (deleteHash) {
      const hashResult = await getFileStoreMap(deleteHash, false, logicalContextId);
      if (hashResult) {
        context.log(`Found hash in map for deletion: ${deleteHash}${logicalContextId ? ` (contextId: ${redactContextId(logicalContextId)})` : ""}`);
        await removeFromFileStoreMap(deleteHash, logicalContextId);
      }
    }

    const deleted = await storageService.deleteFiles(deleteRequestId);
    context.res = {
      status: 200,
      body: { body: deleted },
    };
    return;
  }

  // Rename a file (rename blob in cloud storage + update Redis)
  if (operation === "rename") {
    const fileHash = req.query.hash || parsedBody?.params?.hash || parsedBody?.hash || hash;
    const fileBlobPath = req.query.blobPath || parsedBody?.params?.blobPath || parsedBody?.blobPath || blobPath;
    const targetFilename = req.query.newFilename || parsedBody?.params?.newFilename || parsedBody?.newFilename || newFilename;
    const targetBlobPath = req.query.targetBlobPath || parsedBody?.params?.targetBlobPath || parsedBody?.targetBlobPath;
    const sanitizedTargetBlobPath = targetBlobPath
      ? sanitizeTargetBlobPath(targetBlobPath)
      : "";

    if (!fileHash && !fileBlobPath) {
      context.res = {
        status: 400,
        body: "Missing identifier. Please provide hash or blobPath in query string or request body.",
      };
      return;
    }

    if (!targetFilename || !targetFilename.trim()) {
      context.res = {
        status: 400,
        body: "Missing newFilename parameter. Please provide newFilename in query string or request body.",
      };
      return;
    }

    if (targetBlobPath && !sanitizedTargetBlobPath) {
      context.res = {
        status: 400,
        body: "Invalid targetBlobPath parameter.",
      };
      return;
    }

    const renameDirectlyByBlobPath = async () => {
      try {
        const { provider } = await getScopedProvider({
          storageService,
          resolvedContextId: logicalContextId,
          userId,
          workspaceId,
          appletId,
          fileScope,
        });

        const sanitized = sanitizeFilename(targetFilename.trim());
        const newBlobName = sanitizedTargetBlobPath
          || storageService._computeNewBlobName(fileBlobPath, sanitized);

        context.log(`Renaming blob by blobPath: ${fileBlobPath} → ${newBlobName}`);
        const result = await provider.renameBlob(fileBlobPath, newBlobName);

        context.res = {
          status: 200,
          body: {
            blobPath: newBlobName,
            filename: sanitized,
            url: result.url,
            shortLivedUrl: result.shortLivedUrl || result.url,
            message: `File renamed to "${targetFilename.trim()}"`,
          },
        };
        return;
      } catch (error) {
        if (isNotFoundError(error)) {
          try {
            const legacyBlob = await resolveLegacyScopedBlobClient(
              logicalContextId || storageOwnerId,
              fileBlobPath,
            );
            if (legacyBlob?.provider?.renameBlob) {
              const sanitized = sanitizeFilename(targetFilename.trim());
              const newBlobName = sanitizedTargetBlobPath
                || storageService._computeNewBlobName(
                  fileBlobPath,
                  sanitized,
                );

              context.log(`Renaming legacy blob by blobPath: ${fileBlobPath} → ${newBlobName} (${legacyBlob.containerName})`);
              const result = await legacyBlob.provider.renameBlob(
                fileBlobPath,
                newBlobName,
              );

              context.res = {
                status: 200,
                body: {
                  blobPath: newBlobName,
                  filename: sanitized,
                  url: result.url,
                  shortLivedUrl: result.shortLivedUrl || result.url,
                  message: `File renamed to "${targetFilename.trim()}"`,
                },
              };
              return;
            }
          } catch (legacyError) {
            context.log(`Error renaming legacy blob by blobPath: ${legacyError.message}`);
            context.res = {
              status: legacyError.message.includes("not found") || legacyError.statusCode === 404 ? 404 : 500,
              body: `Error renaming file: ${legacyError.message}`,
            };
            return;
          }
        }
        context.log(`Error renaming blob by blobPath: ${error.message}`);
        context.res = {
          status: error.message.includes("not found") || error.statusCode === 404 ? 404 : 500,
          body: `Error renaming file: ${error.message}`,
        };
      }
    };

    // Prefer blobPath when provided; hash is retained for legacy callers and Redis updates.
    if (fileBlobPath) {
      if (fileHash) {
        try {
          const result = await storageService.renameFile(
            fileHash,
            targetFilename,
            context,
            logicalContextId,
            {
              sourceBlobPath: fileBlobPath,
              targetBlobPath: sanitizedTargetBlobPath,
            },
          );

          context.log(`Renamed blob ${fileBlobPath} to "${targetFilename.trim()}" via hash ${fileHash}${logicalContextId ? ` (contextId: ${redactContextId(logicalContextId)})` : ""}`);

          context.res = {
            status: 200,
            body: result,
          };
          return;
        } catch (error) {
          if (!isNotFoundError(error)) {
            context.log(`Error renaming file: ${error.message}`);
            context.res = {
              status: 500,
              body: `Error renaming file: ${error.message}`,
            };
            return;
          }
          context.log(`Hash-based rename failed for ${fileHash}, trying blobPath: ${fileBlobPath}`);
        }
      }
      await renameDirectlyByBlobPath();
      return;
    }

    // Legacy hash-only rename path.
    if (fileHash) {
      try {
        const result = await storageService.renameFile(
          fileHash,
          targetFilename,
          context,
          logicalContextId,
          { targetBlobPath: sanitizedTargetBlobPath },
        );

        context.log(`Renamed file ${fileHash} to "${targetFilename.trim()}"${logicalContextId ? ` (contextId: ${redactContextId(logicalContextId)})` : ""}`);

        context.res = {
          status: 200,
          body: result,
        };
        return;
      } catch (error) {
        context.log(`Error renaming file: ${error.message}`);
        const status = error.message.includes("not found") ? 404 : 500;
        context.res = {
          status,
          body: `Error renaming file: ${error.message}`,
        };
        return;
      }
    }
  }

  // Fast compact blob-name listing (folder-based storage). This intentionally
  // skips URL signing, Redis enrichment, and GCS backup checks.
  if (operation === "listNames") {
    let folderPath = constructFolderPath({
      userId,
      chatId,
      workspaceId,
      appletId,
      contextId: logicalContextId,
      fileScope,
    });

    if (subPath && folderPath !== null) {
      const sanitizedSub = sanitizeListNamesSubPath(subPath);
      if (!sanitizedSub) {
        context.res = {
          status: 400,
          body: "Invalid subPath for listNames",
        };
        return;
      }
      folderPath = folderPath ? `${folderPath}/${sanitizedSub}` : sanitizedSub;
    }

    if (folderPath === null) {
      context.res = {
        status: 400,
        body: "Missing required parameters. Provide contextId or userId with optional chatId/workspaceId/appletId/fileScope, or workspaceId with fileScope='workspace-shared-legacy'",
      };
      return;
    }

    try {
      const { provider, containerOwnerId } = await getScopedProvider({
        storageService,
        resolvedContextId: logicalContextId,
        userId,
        workspaceId,
        appletId,
        fileScope,
      });

      if (!provider || typeof provider.listNames !== 'function') {
        context.res = {
          status: 500,
          body: "Storage provider does not support fast name listing",
        };
        return;
      }

      const requestedMaxResults = parseBoundedPositiveInt(maxResults, 10000, 50000);
      const primaryResult = await listNamesWithCache(provider, folderPath, {
        maxResults: requestedMaxResults,
      });
      let items = primaryResult.items || [];
      let truncated = primaryResult.truncated === true;
      let cacheHit = primaryResult.cacheHit === true;
      let inFlightHit = primaryResult.inFlightHit === true;

      if (containerOwnerId && items.length < requestedMaxResults) {
        const legacyResult = await listLegacyScopedFolderNames(containerOwnerId, folderPath, {
          maxResults: requestedMaxResults - items.length,
        });
        items = mergeListedNameItems(
          items,
          legacyResult.items || [],
          requestedMaxResults,
        );
        truncated = truncated || legacyResult.truncated === true;
        cacheHit = cacheHit || legacyResult.cacheHit === true;
        inFlightHit = inFlightHit || legacyResult.inFlightHit === true;
      }

      context.res = {
        status: 200,
        body: {
          folderPath,
          items,
          count: items.length,
          truncated,
          maxResults: requestedMaxResults,
          cacheHit,
          inFlightHit,
        },
      };
      return;
    } catch (error) {
      context.log(`Error listing blob names: ${error.message}`);
      context.res = {
        status: 500,
        body: `Error listing blob names: ${error.message}`,
      };
      return;
    }
  }

  // List files in a folder (folder-based storage)
  if (operation === "listFolder") {
    // Construct folder path from provided parameters
    let folderPath = constructFolderPath({
      userId,
      chatId,
      workspaceId,
      appletId,
      contextId: logicalContextId,
      fileScope,
    });

    // Optional subPath appends a subdirectory within the fileScope folder.
    if (subPath && folderPath !== null) {
      const sanitizedSub = sanitizeSubPath(subPath);
      if (sanitizedSub) {
        folderPath = folderPath ? `${folderPath}/${sanitizedSub}` : sanitizedSub;
      }
    }

    if (folderPath === null) {
      context.res = {
        status: 400,
        body: "Missing required parameters. Provide contextId or userId with optional chatId/workspaceId/appletId/fileScope, or workspaceId with fileScope='workspace-shared-legacy'",
      };
      return;
    }

    try {
      // Derive the correct per-user or per-workspace container
      const { provider, containerOwnerId } = await getScopedProvider({
        storageService,
        resolvedContextId: logicalContextId,
        userId,
        workspaceId,
        appletId,
        fileScope,
      });

      if (!provider || typeof provider.listFolder !== 'function') {
        context.res = {
          status: 500,
          body: "Storage provider does not support folder listing",
        };
        return;
      }

      let files = await provider.listFolder(folderPath);
      if (containerOwnerId) {
        files = mergeListedFiles(
          files,
          await listLegacyScopedFolderFiles(containerOwnerId, folderPath),
        );
      }

      // Enrich listing with hash, gcs, and displayFilename from Redis
      const enrichContextId = logicalContextId || containerOwnerId || storageOwnerId;
      if (enrichContextId) {
        // Load all Redis records for this context to match files without hashes
        const allRedisRecords = await getAllFilesForContext(enrichContextId);

        // Build a filename→{hash, record} lookup from Redis for matching hashless files
        const redisFilenameMap = new Map();
        for (const [hash, record] of Object.entries(allRedisRecords)) {
          if (record && record.filename) {
            redisFilenameMap.set(record.filename.toLowerCase(), { hash, record });
          }
        }

        for (const file of files) {
          // If file has no hash from blob name, try to find it in Redis by filename
          if (!file.hash && file.filename) {
            const match = redisFilenameMap.get(file.filename.toLowerCase());
            if (match) {
              file.hash = match.hash;
              if (match.record.gcs) {
                file.gcs = match.record.gcs;
              }
            }
          }

          // Enrich files that have a hash (either from blob name or Redis match above)
          if (file.hash) {
            try {
              const stored = allRedisRecords[file.hash] || await getFileStoreMap(file.hash, true, enrichContextId);
              if (stored) {
                if (stored.displayFilename) {
                  file.displayFilename = stored.displayFilename;
                }
                if (stored.gcs && !file.gcs) {
                  file.gcs = stored.gcs;
                }
              }
            } catch { /* skip enrichment for this file */ }
          }
        }
      }

      context.res = {
        status: 200,
        body: {
          folderPath,
          files,
          count: files.length
        },
      };
      return;
    } catch (error) {
      context.log(`Error listing folder: ${error.message}`);
      context.res = {
        status: 500,
        body: `Error listing folder: ${error.message}`,
      };
      return;
    }
  }

  const remoteUrl = shouldFetchRemote;
  if (req.method.toLowerCase() === "get" && remoteUrl) {
    context.log(`Remote file: ${redactSasToken(remoteUrl)}`);
    let filename;
    try {
      // Validate URL format and accessibility
      const urlCheck = await urlExists(remoteUrl);
      if (!urlCheck.valid) {
        context.res = {
          status: 400,
          body: "Invalid or inaccessible URL",
        };
        return;
      }

      // Check if file already exists (using hash or URL as the key)
      // Always respect contextId if provided, even for URL-based lookups
      const exists = hash
        ? await getFileStoreMap(hash, false, logicalContextId)
        : await getFileStoreMap(remoteUrl, false, logicalContextId);
      if (exists) {
        context.res = {
          status: 200,
          body: exists,
        };
        //update redis timestamp with current time
        if (hash) {
          await setFileStoreMap(hash, exists, logicalContextId);
        } else {
          await setFileStoreMap(remoteUrl, exists, logicalContextId);
        }
        return;
      }

      // Download the file first
      const urlObj = new URL(remoteUrl);
      const fileExtension = path.extname(urlObj.pathname) || ".mp3";
      // Use client-provided filename when available (for folder-based storage);
      // fall back to shortId-based name for legacy flat storage
      const folderPath = constructFolderPath({
        userId,
        chatId,
        workspaceId,
        appletId,
        contextId: logicalContextId,
        fileScope,
      });
      const tempFileName = (folderPath && clientFilename)
        ? sanitizeFilename(clientFilename)
        : `${generateShortId()}${fileExtension}`;
      filename = path.join(os.tmpdir(), tempFileName);
      await downloadFile(remoteUrl, filename);

      const finalFilename = path.basename(filename);
      const { provider, containerOwnerId } = await getScopedProvider({
        storageService,
        resolvedContextId: logicalContextId,
        userId,
        workspaceId,
        appletId,
        fileScope,
      });
      const fileStream = fs.createReadStream(filename);
      // Prefer the content type from the remote server's HEAD response;
      // uploadStream falls back to mime.lookup(filename) if null.
      const remoteContentType = urlCheck.contentType || null;
      const primaryUploadResult = await provider.uploadStream(
        context,
        finalFilename,
        fileStream,
        remoteContentType,
        folderPath,
      );

      let backupUploadUrl = null;
      if (
        storageService.backupProvider &&
        typeof storageService.backupProvider.uploadStream === "function"
      ) {
        // Prefix GCS backup path with the scoped container owner to preserve
        // isolation in the shared bucket backend.
        const gcsFolderPath = containerOwnerId
          ? `${containerOwnerId}/${folderPath || ''}`.replace(/\/+$/, '')
          : folderPath;
        const backupStream = fs.createReadStream(filename);
        backupUploadUrl = await storageService.backupProvider.uploadStream(
          context,
          finalFilename,
          backupStream,
          remoteContentType,
          gcsFolderPath,
        );
      }

      const primaryBlobName =
        provider?.extractBlobNameFromUrl?.(primaryUploadResult.url) ||
        primaryUploadResult.blobName ||
        null;
      const res = {
        ...primaryUploadResult,
        ...(primaryBlobName && { blobName: primaryBlobName }),
        ...(primaryBlobName && { blobPath: primaryBlobName }),
        ...(backupUploadUrl && { gcs: backupUploadUrl.url || backupUploadUrl }),
      };

      //Update Redis (using hash or URL as the key)
      // Always respect contextId if provided, even for URL-based lookups
      if (hash) {
        await setFileStoreMap(hash, res, logicalContextId);
      } else {
        await setFileStoreMap(remoteUrl, res, logicalContextId);
      }

      // Return the file URL
      context.res = {
        status: 200,
        body: res,
      };
    } catch (error) {
      context.log("Error processing remote file request:", error);
      context.res = {
        status: 500,
        body: `Error processing file: ${error.message}`,
      };
    } finally {
      // Cleanup temp file if it exists
      try {
        if (filename && fs.existsSync(filename)) {
          fs.unlinkSync(filename);
        }
      } catch (err) {
        context.log("Error cleaning up temp file:", err);
      }
    }
    return;
  }

  if (hash && clearHash) {
    try {
      const hashValue = await getFileStoreMap(hash, false, logicalContextId);
      if (hashValue) {
        await removeFromFileStoreMap(hash, logicalContextId);
        context.res = {
          status: 200,
          body: `Hash ${hash} removed`,
        };
      } else {
        context.res = {
          status: 404,
          body: `Hash ${hash} not found`,
        };
      }
    } catch (error) {
      context.res = {
        status: 500,
        body: `Error occurred during hash cleanup: ${error}`,
      };
      console.log("Error occurred during hash cleanup:", error);
    }
    return;
  }

  if (hash && checkHash) {
    let mapContextId = logicalContextId || null;
    let hashResult = await getFileStoreMap(hash, true, mapContextId); // Skip lazy cleanup to handle it ourselves

    if (hashResult) {
      context.log(`File exists in map: ${hash}${mapContextId ? ` (contextId: ${redactContextId(mapContextId)})` : ""}`);

      // Log the URL retrieved from Redis before checking existence
      context.log(`Checking existence of URL from Redis: ${redactSasToken(hashResult?.url || '')}`);

      try {
        // Check primary storage first
        const primaryExists = hashResult?.url
          ? await storageService.fileExists(hashResult.url)
          : false;
        const gcsExists = hashResult?.gcs
          ? await storageService.fileExists(hashResult.gcs)
          : false;

        // If neither storage has the file, remove from map and return not found
        if (!primaryExists && !gcsExists) {
          context.log(
            `File not found in any storage. Removing from map: ${hash}`,
          );
          await removeFromFileStoreMap(hash, mapContextId);
          context.res = {
            status: 404,
            body: `Hash ${hash} not found in storage`,
          };
          return;
        }

        // If GCS is missing but primary exists, restore to GCS
        if (primaryExists && !gcsExists && hashResult?.url) {
          context.log(`GCS file missing, restoring from primary: ${hash}`);
          try {
            hashResult = await storageService.ensureGCSUpload(
              context,
              hashResult,
            );
          } catch (error) {
            context.log(`Error restoring to GCS: ${error}`);
            // If restoration fails, remove the hash from the map
            await removeFromFileStoreMap(hash, mapContextId);
            context.res = {
              status: 404,
              body: `Hash ${hash} not found`,
            };
            return;
          }
        }

        // If primary is missing but GCS exists, restore from GCS
        if (
          !primaryExists &&
          gcsExists &&
          hashResult?.gcs &&
          storageService.backupProvider?.isConfigured()
        ) {
          context.log(
            `Primary storage file missing, restoring from GCS: ${hash}`,
          );
          try {
            // Create a temporary file to store the downloaded content
            const tempDir = path.join(os.tmpdir(), `${uuidv4()}`);
            fs.mkdirSync(tempDir);
            const downloadedFile = path.join(
              tempDir,
              path.basename(hashResult.gcs),
            );

            // Download from GCS
            await storageService.downloadFile(hashResult.gcs, downloadedFile);

            // Restore to the ORIGINAL container and folder path (not the default container).
            // Extract container name and blob path from the original URL stored in Redis.
            let res;
            const originalUrl = hashResult.url;
            if (originalUrl && originalUrl.startsWith('http')) {
              const containerName = storageService._extractContainerFromUrl(originalUrl);
              const provider = containerName
                ? await StorageFactory.getInstance().getAzureProvider(containerName)
                : storageService.primaryProvider;
              const originalBlobName = provider.extractBlobNameFromUrl(originalUrl);

              // Extract folder path and filename from the original blob name
              const lastSlash = originalBlobName ? originalBlobName.lastIndexOf('/') : -1;
              const folderPath = lastSlash >= 0 ? originalBlobName.substring(0, lastSlash) : null;
              const originalFilePart = lastSlash >= 0 ? originalBlobName.substring(lastSlash + 1) : originalBlobName;
              // Use the original filename (with hash prefix) for the restored blob
              const filename = originalFilePart || hashResult.filename || path.basename(hashResult.gcs);

              const stream = fs.createReadStream(downloadedFile);
              res = await provider.uploadStream(context, filename, stream, null, folderPath);
            } else {
              // Fallback: no original URL, restore to default container
              res = await storageService.uploadFile(
                context,
                downloadedFile,
                hash,
                null,
                null,
              );
            }

            // Update the hash result with the new primary storage URL
            hashResult.url = res.url;

            // Clean up temp file
            try {
              if (downloadedFile && fs.existsSync(downloadedFile)) {
                fs.unlinkSync(downloadedFile);
              }
              if (tempDir && fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true });
              }
            } catch (err) {
              console.log("Error cleaning up temp files:", err);
            }
          } catch (error) {
            console.error("Error restoring from GCS:", error);
            // If restoration fails, remove the hash from the map
            await removeFromFileStoreMap(hash, mapContextId);
            context.res = {
              status: 404,
              body: `Hash ${hash} not found`,
            };
            return;
          }
        }

        // Final check to ensure we have at least one valid storage location
        const finalPrimaryCheck = hashResult?.url
          ? await storageService.fileExists(hashResult.url)
          : false;
        const finalGCSCheck = hashResult?.gcs
          ? await storageService.fileExists(hashResult.gcs)
          : false;
        if (!finalPrimaryCheck && !finalGCSCheck) {
          context.log(`Failed to restore file. Removing from map: ${hash}`);
          await removeFromFileStoreMap(hash, mapContextId);
          context.res = {
            status: 404,
            body: `Hash ${hash} not found`,
          };
          return;
        }

        // Reconstruct missing filename from URL if needed (before creating response)
        if (!hashResult.filename && hashResult.url) {
          try {
            const urlObj = new URL(hashResult.url);
            const pathSegments = urlObj.pathname.split('/').filter(segment => segment.length > 0);
            if (pathSegments.length > 0) {
              // Extract filename from URL path (last segment)
              const blobName = pathSegments[pathSegments.length - 1];
              // Remove query params if any got included
              hashResult.filename = blobName.split('?')[0];
            }
          } catch (error) {
            context.log(`Error extracting filename from URL: ${error.message}`);
          }
        }

        // Ensure hash/blobPath are set if missing
        if (!hashResult.hash) {
          hashResult.hash = hash;
        }
        if (!hashResult.blobPath && hashResult.url) {
          const inferredBlobPath = extractBlobNameFromUrl(hashResult.url);
          if (inferredBlobPath) {
            hashResult.blobPath = inferredBlobPath;
          }
        }

        // === Lazy migration: move old shared-container files to per-user container ===
        if (userId && hashResult.url) {
          try {
            const defaultContainer = getDefaultContainerName();
            const urlContainer = extractContainerFromUrl(hashResult.url);
            const perUserContainer = getUserContainerName(defaultContainer, userId);

            // Only migrate if file is in old shared container, not already in per-user
            if (urlContainer === defaultContainer && perUserContainer !== defaultContainer) {
              context.log(`Migrating file from shared to per-user container: ${hash}`);
              const factory = StorageFactory.getInstance();
              const perUserProvider = await factory.getAzureProvider(perUserContainer);
              const { containerClient: destContainerClient } = await perUserProvider.getBlobClient();

              const oldBlobName = extractBlobNameFromUrl(hashResult.url);
              if (oldBlobName) {
                // Strip "users/{id}/" prefix to get new blob name
                const newBlobName = oldBlobName.replace(/^users\/[^/]+\//, '');

                // Download from old URL (has valid SAS) and upload to per-user container
                const downloadResp = await globalThis.fetch(hashResult.url);
                if (!downloadResp.ok) throw new Error(`Download failed: ${downloadResp.status}`);
                const blobBuffer = Buffer.from(await downloadResp.arrayBuffer());
                const contentType = downloadResp.headers.get('content-type');
                const destBlob = destContainerClient.getBlockBlobClient(newBlobName);
                await destBlob.upload(blobBuffer, blobBuffer.length, {
                  blobHTTPHeaders: {
                    ...(contentType ? { blobContentType: contentType } : {}),
                    blobCacheControl: 'public, max-age=2592000, immutable',
                  },
                });

                // Generate new long-lived SAS token and update URL
                const newSasToken = perUserProvider.generateSASToken(destContainerClient, newBlobName);
                hashResult.url = `${destBlob.url}?${newSasToken}`;
                hashResult.blobPath = newBlobName;
                hashResult.blobName = newBlobName;

                // Migrate converted file if it exists
                if (hashResult.converted?.url) {
                  const oldConvertedBlob = extractBlobNameFromUrl(hashResult.converted.url);
                  if (oldConvertedBlob) {
                    const newConvertedBlob = oldConvertedBlob.replace(/^users\/[^/]+\//, '');
                    const convResp = await globalThis.fetch(hashResult.converted.url);
                    if (convResp.ok) {
                      const convBuffer = Buffer.from(await convResp.arrayBuffer());
                      const convContentType = convResp.headers.get('content-type');
                      const destConvBlob = destContainerClient.getBlockBlobClient(newConvertedBlob);
                      await destConvBlob.upload(convBuffer, convBuffer.length, {
                        blobHTTPHeaders: {
                          ...(convContentType ? { blobContentType: convContentType } : {}),
                          blobCacheControl: 'public, max-age=2592000, immutable',
                        },
                      });
                      const convSasToken = perUserProvider.generateSASToken(destContainerClient, newConvertedBlob);
                      hashResult.converted.url = `${destConvBlob.url}?${convSasToken}`;
                      hashResult.converted.blobPath = newConvertedBlob;
                      hashResult.converted.blobName = newConvertedBlob;
                    }
                  }
                }

                // Strip users/ prefix from GCS path if present
                if (hashResult.gcs) {
                  hashResult.gcs = hashResult.gcs.replace(/\/users\/[^/]+\//, '/');
                }

                // Persist updated record to Redis
                await setFileStoreMap(hash, hashResult, mapContextId);
                context.log(`Migration complete for hash: ${hash}`);
              }
            }
          } catch (migrationError) {
            context.log(`Migration failed (using existing URL): ${migrationError.message}`);
          }
        }

        // === Copy blob to target folder if checkHash matched from a different folder ===
        if (hashResult.url) {
          try {
            const targetFolder = constructFolderPath({
              userId,
              chatId,
              workspaceId,
              appletId,
              contextId: logicalContextId,
              fileScope,
            });
            if (targetFolder !== null) {
              const currentBlobName = extractBlobNameFromUrl(hashResult.url);
              if (currentBlobName) {
                // Extract the current folder and filename from the blob name
                const lastSlash = currentBlobName.lastIndexOf('/');
                const currentFolder = lastSlash >= 0 ? currentBlobName.substring(0, lastSlash) : '';
                const filenameOnly = lastSlash >= 0 ? currentBlobName.substring(lastSlash + 1) : currentBlobName;

                // Normalize for comparison (empty string means root)
                const normalizedTarget = targetFolder.replace(/^\/+|\/+$/g, '');

                if (currentFolder !== normalizedTarget) {
                  context.log(`Copying blob from folder "${currentFolder}" to "${normalizedTarget}" for hash: ${hash}`);

                  const urlContainer = extractContainerFromUrl(hashResult.url);
                  const factory = StorageFactory.getInstance();
                  const provider = urlContainer
                    ? await factory.getAzureProvider(urlContainer)
                    : storageService.primaryProvider;

                  await provider.ensureInitialized();
                  const { containerClient } = await provider.getBlobClient();

                  const newBlobName = normalizedTarget ? `${normalizedTarget}/${filenameOnly}` : filenameOnly;
                  const srcBlobClient = containerClient.getBlockBlobClient(currentBlobName);
                  const destBlobClient = containerClient.getBlockBlobClient(newBlobName);

                  // Copy using short-lived SAS for source auth
                  const sourceSas = provider.generateShortLivedSASToken(currentBlobName, 10);
                  const sourceUrl = `${srcBlobClient.url}?${sourceSas}`;
                  const copyPoller = await destBlobClient.beginCopyFromURL(sourceUrl);
                  await copyPoller.pollUntilDone();

                  // Generate new long-lived SAS for the copied blob
                  const newSasToken = provider.generateSASToken(newBlobName);
                  hashResult.url = `${destBlobClient.url}?${newSasToken}`;
                  hashResult.blobPath = newBlobName;
                  hashResult.blobName = newBlobName;

                  // Copy converted file if it exists and is in a different folder too
                  if (hashResult.converted?.url) {
                    const convBlobName = extractBlobNameFromUrl(hashResult.converted.url);
                    if (convBlobName) {
                      const convLastSlash = convBlobName.lastIndexOf('/');
                      const convFilename = convLastSlash >= 0 ? convBlobName.substring(convLastSlash + 1) : convBlobName;
                      const newConvBlobName = normalizedTarget ? `${normalizedTarget}/${convFilename}` : convFilename;

                      const srcConvClient = containerClient.getBlockBlobClient(convBlobName);
                      const destConvClient = containerClient.getBlockBlobClient(newConvBlobName);
                      const convSas = provider.generateShortLivedSASToken(convBlobName, 10);
                      const convSourceUrl = `${srcConvClient.url}?${convSas}`;
                      const convPoller = await destConvClient.beginCopyFromURL(convSourceUrl);
                      await convPoller.pollUntilDone();

                      const convSasToken = provider.generateSASToken(newConvBlobName);
                      hashResult.converted.url = `${destConvClient.url}?${convSasToken}`;
                      hashResult.converted.blobPath = newConvBlobName;
                      hashResult.converted.blobName = newConvBlobName;
                    }
                  }

                  // Persist updated record to Redis
                  await setFileStoreMap(hash, hashResult, mapContextId);
                  context.log(`Folder copy complete for hash: ${hash}`);
                }
              }
            }
          } catch (folderCopyError) {
            context.log(`Folder copy failed (using existing URL): ${folderCopyError.message}`);
          }
        }

        // Create the response object
        const response = {
          message: `File '${hashResult.filename || 'unknown'}' uploaded successfully.`,
          filename: hashResult.filename,
          url: hashResult.url,
          gcs: hashResult.gcs,
          hash: hashResult.hash || hash,
          ...(hashResult.blobPath ? { blobPath: hashResult.blobPath } : {}),
          timestamp: new Date().toISOString(),
        };

        // Include displayFilename if it exists in Redis record
        if (hashResult.displayFilename) {
          response.displayFilename = hashResult.displayFilename;
        }

        // Ensure converted version exists and is synced across storage providers
        try {
          hashResult = await conversionService.ensureConvertedVersion(
            hashResult,
            requestId,
          );
        } catch (error) {
          context.log(`Error ensuring converted version: ${error}`);
        }

        // Add mimeType to converted block if it exists but doesn't have mimeType yet
        if (hashResult.converted && !hashResult.converted.mimeType) {
          hashResult.converted.mimeType = getMimeTypeFromUrl(hashResult.converted.url);
        }

        // Generate short-lived URLs for both original and converted files (if converted exists)
        // Helper function to generate short-lived URL for a given URL
        const generateShortLivedUrlForUrl = async (urlToProcess) => {
          if (!urlToProcess) return null;

          try {
            // Extract blob name from the URL to generate new SAS token
            let blobName;
            try {
              const url = new URL(urlToProcess);
              let path = url.pathname.substring(1);

              // For Azurite URLs, the path includes account name: devstoreaccount1/container/blob
              // For real Azure URLs, the path is: container/blob
              if (path.startsWith(`${AZURITE_ACCOUNT_NAME}/`)) {
                path = path.substring(`${AZURITE_ACCOUNT_NAME}/`.length);
              }

              // Decode each segment so double-encoded names (e.g. %2520 → %20)
              // resolve to the actual blob name used in Azure storage.
              const pathSegments = path.split('/').filter(segment => segment.length > 0)
                .map(s => decodeURIComponent(s));
              if (pathSegments.length >= 2) {
                blobName = pathSegments.slice(1).join('/');
              } else if (pathSegments.length === 1) {
                blobName = pathSegments[0];
              }
            } catch (urlError) {
              context.log(`Error parsing URL for short-lived generation: ${urlError}`);
              return null;
            }

            if (blobName) {
              // Use correct provider based on URL container
              const urlContainer = extractContainerFromUrl(urlToProcess);
              const defaultContainer = getDefaultContainerName();
              let provider;
              if (urlContainer && urlContainer !== defaultContainer) {
                provider = await StorageFactory.getInstance().getAzureProvider(urlContainer);
              } else {
                provider = storageService.primaryProvider;
              }

              if (provider && provider.generateShortLivedSASToken) {
                await provider.ensureInitialized();

                const sasToken = provider.generateShortLivedSASToken(
                  blobName,
                  shortLivedDuration
                );

                // Build URL from the blob client so path encoding matches
                // the decoded blobName used for SAS generation.
                const { containerClient } = await provider.getBlobClient();
                const blockBlobClient = containerClient.getBlockBlobClient(blobName);
                return `${blockBlobClient.url}?${sasToken}`;
              }
            }
          } catch (error) {
            context.log(`Error generating short-lived URL: ${error}`);
          }

          return null;
        };

        // Generate short-lived URLs for response (not stored in Redis)
        // Generate short-lived URL for converted file if it exists
        let convertedShortLivedUrl = null;
        if (hashResult.converted?.url) {
          convertedShortLivedUrl = await generateShortLivedUrlForUrl(hashResult.converted.url);
          if (!convertedShortLivedUrl) {
            // Fallback to regular URL
            convertedShortLivedUrl = hashResult.converted.url;
          }
          context.log(`Generated shortLivedUrl for converted file`);
        }

        // Generate short-lived URL for original file (for main response)
        const urlForShortLived = hashResult.converted?.url || hashResult.url;
        const mainShortLivedUrl = await generateShortLivedUrlForUrl(urlForShortLived);
        if (mainShortLivedUrl) {
          response.shortLivedUrl = mainShortLivedUrl;
          response.expiresInMinutes = shortLivedDuration;
          const urlType = hashResult.converted?.url ? 'converted' : 'original';
          context.log(`Generated short-lived URL for hash: ${hash} using ${urlType} URL (expires in ${shortLivedDuration} minutes)`);
        } else {
          // Fallback for storage providers that don't support short-lived tokens
          response.shortLivedUrl = urlForShortLived;
          response.expiresInMinutes = shortLivedDuration;
          const urlType = hashResult.converted?.url ? 'converted' : 'original';
          context.log(`Storage provider doesn't support short-lived tokens, using ${urlType} URL`);
        }

        // Attach converted info to response if present (include shortLivedUrl in response only)
        if (hashResult.converted) {
          const convertedBlobPath = hashResult.converted.blobPath
            || extractBlobNameFromUrl(hashResult.converted.url || "");
          response.converted = {
            url: hashResult.converted.url,
            shortLivedUrl: convertedShortLivedUrl || hashResult.converted.url,
            gcs: hashResult.converted.gcs,
            mimeType: hashResult.converted.mimeType || null,
            ...(convertedBlobPath ? { blobPath: convertedBlobPath } : {}),
          };
        }

        // Update redis timestamp with current time
        // Note: setFileStoreMap will remove shortLivedUrl fields before storing
        // hashResult has already been enriched with filename/hash above if missing
        await setFileStoreMap(hash, hashResult, mapContextId);

        context.res = {
          status: 200,
          body: response,
        };
        return;
      } catch (error) {
        context.log(`Error checking file existence: ${error}`);
        // If there's an error checking file existence, remove the hash from the map
        await removeFromFileStoreMap(hash, mapContextId);
        context.res = {
          status: 404,
          body: `Hash ${hash} not found`,
        };
        return;
      }
    }

    // If blobPath is available, fall through to blobPath-based lookup
    // instead of returning 404 — the file may still exist in storage
    // even though its hash expired from Redis.
    if (!blobPath) {
      context.res = {
        status: 404,
        body: `Hash ${hash} not found`,
      };
      return;
    }

    try {
      const legacyBlobResult = await resolveBlobPathWithLegacyFallback({
        context,
        hash,
        blobPath,
        resolvedContextId: logicalContextId,
        userId,
        chatId,
        workspaceId,
        appletId,
        fileScope,
        storageService,
        setFileStoreMap,
      });
      if (legacyBlobResult?.url) {
        context.res = {
          status: 200,
          body: {
            url: legacyBlobResult.url,
            shortLivedUrl: legacyBlobResult.shortLivedUrl || legacyBlobResult.url,
            hash: legacyBlobResult.hash || hash,
            blobPath: legacyBlobResult.blobPath || blobPath,
            filename: legacyBlobResult.filename || null,
            message: "File found by legacy blobPath fallback",
          },
        };
        return;
      }
    } catch (legacyBlobError) {
      context.log(`Legacy blobPath fallback failed for ${blobPath}: ${legacyBlobError.message}`);
    }

    context.log(`Hash ${hash} not found in Redis, falling back to blobPath: ${blobPath}`);
  }

  // Handle blobPath-based lookups: generate a short-lived SAS URL directly
  // from the blob path, without needing a hash in Redis.
  if (blobPath) {
    try {
      const { provider, containerOwnerId } = await getScopedProvider({
        storageService,
        resolvedContextId: logicalContextId,
        userId,
        workspaceId,
        appletId,
        fileScope,
      });

      // Azure storage: use SDK to check existence and generate SAS token
      if (provider && provider.getBlobClient && provider.generateShortLivedSASToken) {
        const { containerClient } = await provider.getBlobClient();
        const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

        const exists = await blockBlobClient.exists();
        if (exists) {
          const sasToken = provider.generateShortLivedSASToken(blobPath, shortLivedDuration);
          const shortLivedUrl = `${blockBlobClient.url}?${sasToken}`;
          let gcsUrl = null;

          try {
            const ensuredFile = await storageService.ensureGCSUpload(context, {
              url: shortLivedUrl,
              blobName: blobPath,
              blobPath,
              containerOwnerId,
            }, {
              waitForInFlightMs: 5000,
            });
            gcsUrl = ensuredFile?.gcs || null;
          } catch (ensureGcsError) {
            context.log(
              `Warning: Could not ensure GCS backup for blobPath ${blobPath}: ${ensureGcsError.message}`,
            );
          }

          context.log(`Generated short-lived URL for blobPath: ${blobPath} (expires in ${shortLivedDuration} minutes)`);
          context.res = {
            status: 200,
            body: {
              url: shortLivedUrl,
              shortLivedUrl: shortLivedUrl,
              ...(gcsUrl ? { gcs: gcsUrl } : {}),
              ...(hash ? { hash } : {}),
              blobPath,
              expiresInMinutes: shortLivedDuration,
              message: "File found by blobPath",
            },
          };
          return;
        }
      } else if (provider && provider.fileExists) {
        // Local/other storage: check if a file with this path exists
        const localUrl = `http://localhost:${process.env.PORT || 7071}/files/${blobPath}`;
        const exists = await provider.fileExists(localUrl);
        if (exists) {
          context.log(`Found local file for blobPath: ${blobPath}`);
          context.res = {
            status: 200,
            body: {
              url: localUrl,
              shortLivedUrl: localUrl,
              message: "File found by blobPath",
            },
          };
          return;
        }
      }

      try {
        const legacyBlobResult = await resolveBlobPathWithLegacyFallback({
          context,
          hash,
          blobPath,
          resolvedContextId: logicalContextId,
          userId,
          chatId,
          workspaceId,
          appletId,
          fileScope,
          storageService,
          setFileStoreMap,
        });
        if (legacyBlobResult?.url) {
          context.res = {
            status: 200,
            body: {
              url: legacyBlobResult.shortLivedUrl || legacyBlobResult.url,
              shortLivedUrl: legacyBlobResult.shortLivedUrl || legacyBlobResult.url,
              ...(legacyBlobResult.hash ? { hash: legacyBlobResult.hash } : {}),
              blobPath: legacyBlobResult.blobPath || blobPath,
              filename: legacyBlobResult.filename || null,
              expiresInMinutes: shortLivedDuration,
              message: "File found by legacy blobPath fallback",
            },
          };
          return;
        }
      } catch (legacyBlobError) {
        context.log(`Legacy blobPath fallback failed for ${blobPath}: ${legacyBlobError.message}`);
      }

      context.log(`Blob not found for blobPath: ${blobPath}`);
      context.res = {
        status: 404,
        body: `Blob not found: ${blobPath}`,
      };
      return;
    } catch (error) {
      context.log(`Error looking up blobPath ${blobPath}: ${error}`);
      context.res = {
        status: 404,
        body: `Blob not found: ${blobPath}`,
      };
      return;
    }
  }

  if (req.method.toLowerCase() === "post") {
    // Determine if we should save to local storage based on primary provider
    const saveToLocal =
      storageService.primaryProvider.constructor.name ===
      "LocalStorageProvider";
    // Use uploadBlob to handle multipart/form-data
    const result = await uploadBlob(context, req, saveToLocal, null, hash);
    if (result?.hash && context?.res?.body) {
      // Use the explicit scoped context when available, otherwise derive it
      // from the folder-storage routing inputs so uploads and lookups share
      // the same Redis namespace.
      const uploadContextId =
        result.contextId
        || getScopedLogicalContextId({
          contextId: null,
          userId: result.userId || null,
          workspaceId: result.workspaceId || null,
          appletId: result.appletId || null,
          fileScope: result.fileScope || null,
        })
        || logicalContextId;
      // Store contextId alongside the entry for debugging/traceability
      if (uploadContextId && typeof context.res.body === "object" && context.res.body) {
        context.res.body.contextId = uploadContextId;
      }
      await setFileStoreMap(result.hash, context.res.body, uploadContextId);
    }
    return;
  }

  if (!uri || !requestId) {
    context.res = {
      status: 400,
      body: "Please pass a uri and requestId on the query string or in the request body",
    };
    return;
  }

  let totalCount = 0;
  let completedCount = 0;
  let numberOfChunks;

  const file = ensureEncoded(uri); // encode url to handle special characters

  const result = [];

  const sendProgress = async (data = null) => {
    completedCount++;
    const progress = completedCount / totalCount;
    await publishRequestProgress({
      requestId,
      progress,
      completedCount,
      totalCount,
      numberOfChunks,
      data,
    });
  };

  try {
    // Parse URL and get pathname without query parameters for extension check
    const urlObj = new URL(uri);
    const pathWithoutQuery = urlObj.pathname;

    if (
      DOC_EXTENSIONS.some((ext) => pathWithoutQuery.toLowerCase().endsWith(ext))
    ) {
      const extension = path.extname(pathWithoutQuery).toLowerCase();
      const tempDir = path.join(os.tmpdir(), `${uuidv4()}`);
      fs.mkdirSync(tempDir);
      const downloadedFile = path.join(tempDir, `${uuidv4()}${extension}`);
      await downloadFile(uri, downloadedFile);

      try {
        if (shouldSave) {
          // Check if file needs conversion first
          if (conversionService.needsConversion(downloadedFile)) {
            // Convert the file
            const conversion = await conversionService.convertFile(
              downloadedFile,
              uri,
            );
            if (!conversion.converted) {
              throw new Error("File conversion failed");
            }

            // Save the converted file
            const convertedSaveResult =
              await conversionService._saveConvertedFile(
                conversion.convertedPath,
                requestId,
                null,
              );

            // Return the converted file URL
            context.res = {
              status: 200,
              body: {
                url: convertedSaveResult.url,
                blobName: path.basename(convertedSaveResult.url),
              },
            };
          } else {
            // File doesn't need conversion, save the original file
            const saveResult = await conversionService._saveConvertedFile(
              downloadedFile,
              requestId,
              null,
            );

            // Return the original file URL
            context.res = {
              status: 200,
              body: {
                url: saveResult.url,
                blobName: path.basename(saveResult.url),
              },
            };
          }
          return;
        } else {
          let text;
          if (conversionService.needsConversion(downloadedFile)) {
            text = await conversionService.convertFile(
              downloadedFile,
              uri,
              true,
            );
          } else {
            // For files that don't need conversion, read the file contents directly
            text = await fs.promises.readFile(downloadedFile, "utf-8");
          }
          result.push(...easyChunker(text));
        }
      } catch (err) {
        console.log(
          `Error saving file ${uri} with request id ${requestId}:`,
          err,
        );
        throw err; // Re-throw to handle in outer catch
      } finally {
        try {
          // delete temporary files
          if (downloadedFile && fs.existsSync(downloadedFile)) {
            fs.unlinkSync(downloadedFile);
            console.log(`Cleaned temp file ${downloadedFile}`);
          }
        } catch (err) {
          console.log(`Error cleaning temp file ${downloadedFile}:`, err);
        }

        // Delete uploaded files only if we're NOT saving the converted version.
        // When save=true we need to keep the converted file (which is stored under the same requestId prefix),
        // so skip the cleanup in that case.
        if (!shouldSave) {
          await storageService.deleteFiles(requestId);
          console.log(`Cleaned temp files for request id ${requestId}`);
        } else {
          console.log(
            `Skip cleanup for request id ${requestId} because save flag is set`,
          );
        }
      }
    } else {
      const { chunkPromises, chunkOffsets, uniqueOutputPath, chunkBaseName } =
        await splitMediaFile(file, 500, requestId, chunkOverlapSeconds);

      numberOfChunks = chunkPromises.length; // for progress reporting
      totalCount += chunkPromises.length * 4; // 4 steps for each chunk (download and upload)

      // sequential download of chunks
      const chunks = [];
      for (const chunkPromise of chunkPromises) {
        const chunkPath = await chunkPromise;
        chunks.push(chunkPath);
        await sendProgress();
      }

      // sequential processing of chunks
      for (let index = 0; index < chunks.length; index++) {
        const chunkPath = chunks[index];
        // Use the same base filename for all chunks to ensure consistency
        const chunkFilename = `chunk-${index + 1}-${chunkBaseName}`;
        const chunkResult = await storageService.uploadFile(
          context,
          chunkPath,
          requestId,
          null,
          chunkFilename,
        );

        const chunkOffset = chunkOffsets[index];
        result.push({
          uri: chunkResult.url,
          offset: chunkOffset,
          gcs: chunkResult.gcs,
        });
        // Redact SAS tokens for secure logging
        const { redactSasToken } = await import('./utils/logSecurity.js');
        const redactedUrl = redactSasToken(chunkResult.url);
        const redactedGcs = chunkResult.gcs ? redactSasToken(chunkResult.gcs) : '';
        console.log(
          `Saved chunk as: ${redactedUrl}${redactedGcs ? ` and ${redactedGcs}` : ""}`,
        );
        await sendProgress();
      }

      // Cleanup the temp directory
      try {
        if (uniqueOutputPath && fs.existsSync(uniqueOutputPath)) {
          fs.rmSync(uniqueOutputPath, { recursive: true });
          console.log(`Cleaned temp directory: ${uniqueOutputPath}`);
        }
      } catch (err) {
        console.log(`Error cleaning temp directory ${uniqueOutputPath}:`, err);
      }
    }
  } catch (error) {
    console.error("An error occurred:", error);
    context.res = {
      status: 500,
      body: error.message || error,
    };
    return;
  }

  // Sanitize result before logging to redact SAS tokens and contextIds
  const sanitizedResult = sanitizeForLogging(result);
  console.log(
    "result:",
    sanitizedResult
      .map((item) =>
        typeof item === "object" ? JSON.stringify(item, null, 2) : item,
      )
      .join("\n"),
  );

  context.res = {
    body: result,
  };
}

export default CortexFileHandler;
