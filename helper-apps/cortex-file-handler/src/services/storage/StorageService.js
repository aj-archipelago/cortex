import { StorageFactory } from "./StorageFactory.js";
import path from "path";
import os from "os";
import fs from "fs";
import axios from "axios";
import { generateShortId, sanitizeFilename } from "../../utils/filenameUtils.js";
import { sanitizeTargetBlobPath } from "../../utils/targetBlobPathUtils.js";
import { AZURITE_ACCOUNT_NAME, getDefaultContainerName, getUserContainerName } from "../../constants.js";

const GCS_ENSURE_LOCK_TTL_SECONDS = Number.parseInt(
  process.env.GCS_ENSURE_LOCK_TTL_SECONDS || "1800",
  10,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class StorageService {
  constructor(factory) {
    this.factory = factory || StorageFactory.getInstance();
    this.primaryProvider = null;
    this.backupProvider = null;
    this._initialized = false;
  }

  async _initialize() {
    if (!this._initialized) {
      this.primaryProvider = await this.factory.getPrimaryProvider();
      this.backupProvider = this.factory.getGCSProvider();
      this._initialized = true;
    }
  }

  async getPrimaryProvider() {
    await this._initialize();
    return this.primaryProvider;
  }

  async getBackupProvider() {
    await this._initialize();
    return this.backupProvider;
  }



  async uploadFile(...args) {
    /*
            Supported call shapes:
            1) uploadFile(buffer, filename)
            2) uploadFile(context, filePath, requestId, hash?, filename?) – legacy internal use
        */

    await this._initialize();

    // Shape (buffer, filename)
    if (
      args.length === 2 &&
      Buffer.isBuffer(args[0]) &&
      typeof args[1] === "string"
    ) {
      const buffer = args[0];
      const filename = args[1];
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
      await fs.promises.writeFile(tempFile, buffer);
      try {
        const result = await this.primaryProvider.uploadFile(
          {},
          tempFile,
          filename,
          null, // hash
          null // filename (will use provided filename)
        );
        // Ensure shortLivedUrl is included
        const response = {
          url: result.url,
          shortLivedUrl: result.shortLivedUrl || result.url,
          blobName: result.blobName
        };
        return response;
      } finally {
        if (fs.existsSync(tempFile)) {
          await fs.promises.unlink(tempFile).catch(() => {});
        }
      }
    }

    // Fallback to legacy (context, filePath, requestId, hash?, filename?)
    // Container parameter is ignored - always uses default container from env var
    const [context, filePath, requestId, hash, filename] = args;
    return this.uploadFileWithProviders(context, filePath, requestId, hash, filename);
  }

  async uploadFileToBackup(fileOrBuffer, filename) {
    await this._initialize();
    
    if (!this.backupProvider) {
      throw new Error("Backup provider not configured");
    }

    if (Buffer.isBuffer(fileOrBuffer)) {
      const tempFile = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
      await fs.promises.writeFile(tempFile, fileOrBuffer);
      try {
        const result = await this.backupProvider.uploadFile(
          {},
          tempFile,
          filename,
        );
        return { url: result.url };
      } finally {
        if (fs.existsSync(tempFile)) {
          await fs.promises.unlink(tempFile).catch(() => {});
        }
      }
    }

    const result = await this.backupProvider.uploadFile(
      {},
      fileOrBuffer,
      filename,
    );
    return { url: result.url };
  }

  async downloadFile(url, destinationPath = null) {
    await this._initialize();
    
    const useBackup = url.startsWith("gs://");

    if (useBackup && !this.backupProvider) {
      throw new Error("Backup provider not configured");
    }

    // If caller supplied a destination path, stream to disk and return void
    if (destinationPath) {
      if (useBackup) {
        await this.backupProvider.downloadFile(url, destinationPath);
      } else {
        await this.primaryProvider.downloadFile(url, destinationPath);
      }
      return;
    }

    // Otherwise download to a temp file and return Buffer
    const tempFile = path.join(os.tmpdir(), path.basename(url));
    try {
      if (useBackup) {
        await this.backupProvider.downloadFile(url, tempFile);
      } else {
        await this.primaryProvider.downloadFile(url, tempFile);
      }
      return await fs.promises.readFile(tempFile);
    } finally {
      if (fs.existsSync(tempFile)) {
        await fs.promises.unlink(tempFile).catch(() => {});
      }
    }
  }

  async deleteFile(url) {
    await this._initialize();

    // Get the correct provider for the URL's container (may be per-user)
    const containerName = this._extractContainerFromUrl(url);
    const provider = containerName
      ? await StorageFactory.getInstance().getAzureProvider(containerName)
      : this.primaryProvider;

    if (typeof provider.deleteFile === "function") {
      return await provider.deleteFile(url);
    }
    // Fallback for providers that only have deleteFiles
    return await provider.deleteFiles([url]);
  }

  async deleteFileFromBackup(url) {
    await this._initialize();
    
    if (!this.backupProvider) {
      throw new Error("Backup provider not configured");
    }
    if (typeof this.backupProvider.deleteFile === "function") {
      return await this.backupProvider.deleteFile(url);
    }
    // Fallback for providers that only have deleteFiles
    return await this.backupProvider.deleteFiles([url]);
  }

  /**
   * Scan cloud storage for orphaned blobs matching a hash and delete them.
   * Used when the Redis entry is gone but the blob may still exist.
   * Blobs are named {hash}_{filename}, so we list the user's folder tree
   * and match by hash prefix.
   */
  async _deleteOrphanedBlobs(hash, contextId) {
    const deleted = [];

    // Determine which Azure provider + folder prefix to scan.
    // Per-user containers (getUserContainerName) store files at the container
    // root (e.g., chats/{chatId}/{hash}_{file}), so we list everything ('').
    // Legacy shared containers store files under users/{contextId}/.
    const baseName = getDefaultContainerName();
    const perUserContainer = getUserContainerName(baseName, contextId);
    const isPerUser = perUserContainer !== baseName;

    const azureProvider = isPerUser
      ? await StorageFactory.getInstance().getAzureProvider(perUserContainer)
      : this.primaryProvider;
    const folderPrefix = isPerUser ? '' : `users/${contextId}`;

    // Scan Azure storage for orphaned blobs matching this hash
    if (azureProvider && typeof azureProvider.listFolder === 'function') {
      try {
        const files = await azureProvider.listFolder(folderPrefix);
        for (const file of files) {
          if (file.hash === hash) {
            try {
              const result = await azureProvider.deleteFile(file.url);
              if (result) {
                console.log(`Deleted orphaned primary blob: ${file.name}`);
                deleted.push({ provider: 'primary', result: file.name });
              } else {
                console.warn(`Primary blob not found for orphan cleanup: ${file.name}`);
              }
            } catch (err) {
              console.error(`Failed to delete orphaned primary blob ${file.name}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`Error scanning primary storage for orphaned blobs: ${err.message}`);
      }
    }

    // Scan backup storage (GCS) — listFolder returns signed HTTPS URLs,
    // but deleteFile expects gs:// URLs, so construct from file.name
    if (this.backupProvider && typeof this.backupProvider.listFolder === 'function') {
      try {
        const files = await this.backupProvider.listFolder(folderPrefix);
        for (const file of files) {
          if (file.hash === hash) {
            try {
              // Construct gs:// URL from the blob name since listFolder returns signed HTTPS URLs
              const gcsUrl = `gs://${this.backupProvider.bucketName}/${file.name}`;
              const result = await this.backupProvider.deleteFile(gcsUrl);
              if (result) {
                console.log(`Deleted orphaned backup blob: ${file.name}`);
                deleted.push({ provider: 'backup', result: file.name });
              } else {
                console.warn(`Backup blob not found for orphan cleanup: ${file.name}`);
              }
            } catch (err) {
              console.error(`Failed to delete orphaned backup blob ${file.name}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`Error scanning backup storage for orphaned blobs: ${err.message}`);
      }
    }

    return deleted;
  }

  /**
   * Delete a single file by its hash from both primary and backup storage
   * @param {string} hash - The hash of the file to delete
   * @param {string|null} contextId - Optional context ID for context-scoped files
   * @returns {Promise<Object>} Object containing deletion results and file info
   */
  async deleteFileByHash(hash, contextId = null) {
    await this._initialize();

    if (!hash) {
      throw new Error("Missing hash parameter");
    }

    const results = [];

    // Get file information from Redis (skip lazy cleanup — we're deleting, not reading)
    const { getFileStoreMap, removeFromFileStoreMap } = await import("../../redis.js");
    const hashResult = await getFileStoreMap(hash, true, contextId);

    if (!hashResult) {
      // No URL info in Redis — but the blob may still exist in cloud storage
      // (e.g., previous delete removed Redis entry but failed to delete the blob).
      // Scan the user's folder for orphaned blobs matching this hash and clean them up.
      await removeFromFileStoreMap(hash, contextId);

      if (contextId) {
        const orphansDeleted = await this._deleteOrphanedBlobs(hash, contextId);
        if (orphansDeleted.length > 0) {
          console.log(`Cleaned up ${orphansDeleted.length} orphaned blob(s) for hash ${hash}`);
          return { hash, deleted: orphansDeleted, orphanCleanup: true, results: orphansDeleted };
        }
      }

      return { hash, alreadyDeleted: true, results };
    }

    // Delete from primary storage FIRST (before removing from Redis)
    // This ensures we can retry if cloud deletion fails
    let primaryDeleted = false;
    if (hashResult.url) {
      try {
        const { redactSasToken } = await import('../../utils/logSecurity.js');
        console.log(`Deleting file from primary storage - hash: ${hash}, url: ${redactSasToken(hashResult.url)}`);

        // Get the correct provider for the URL's container (may be per-user)
        const containerName = this._extractContainerFromUrl(hashResult.url);
        const provider = containerName
          ? await StorageFactory.getInstance().getAzureProvider(containerName)
          : this.primaryProvider;
        const primaryResult = await provider.deleteFile(hashResult.url);
        if (primaryResult) {
          console.log(`Successfully deleted from primary storage - hash: ${hash}, result: ${primaryResult}`);
          results.push({ provider: 'primary', result: primaryResult });
          primaryDeleted = true;
        } else {
          // deleteFile returned null — blob not found, treat as already deleted
          console.warn(`Primary blob not found for hash ${hash}: ${redactSasToken(hashResult.url)}`);
          results.push({ provider: 'primary', result: 'not_found' });
          primaryDeleted = true; // Not found = already gone, safe to remove from Redis
        }
      } catch (error) {
        console.error(`Error deleting file from primary storage:`, error);
        results.push({ provider: 'primary', error: error.message });
        // primaryDeleted stays false — don't remove from Redis so delete can be retried
      }
    } else {
      primaryDeleted = true; // No URL to delete
    }

    // Delete from backup storage (GCS)
    let backupDeleted = false;
    if (hashResult.gcs && this.backupProvider) {
      try {
        console.log(`Deleting file from backup storage - hash: ${hash}, gcs: ${hashResult.gcs}`);
        const backupResult = await this.deleteFileFromBackup(hashResult.gcs);
        if (backupResult) {
          console.log(`Successfully deleted from backup storage - hash: ${hash}, result: ${backupResult}`);
          results.push({ provider: 'backup', result: backupResult });
        } else {
          console.warn(`Backup deletion returned null for hash ${hash}: ${hashResult.gcs}`);
          results.push({ provider: 'backup', result: 'not_found' });
        }
        backupDeleted = true;
      } catch (error) {
        console.error(`Error deleting file from backup storage:`, error);
        results.push({ provider: 'backup', error: error.message });
      }
    } else {
      backupDeleted = true; // Nothing to delete
    }

    // Only remove from Redis after cloud deletion succeeds (or blobs confirmed gone)
    // This prevents orphaned blobs that can never be cleaned up via hash-based delete
    if (primaryDeleted) {
      await removeFromFileStoreMap(hash, contextId);
    } else {
      console.warn(`Keeping Redis entry for hash ${hash} — primary storage deletion failed, retry will be possible`);
    }

    return {
      hash,
      deleted: results,
      filename: hashResult.filename,
      ...(hashResult.displayFilename && { displayFilename: hashResult.displayFilename })
    };
  }

  /**
   * Rename a file in cloud storage and update Redis.
   * Copies the blob to a new name (preserving folder path and hash prefix),
   * deletes the old blob, and updates the Redis entry.
   * @param {string} hash - The file hash (Redis key)
   * @param {string} newFilename - The new display filename
   * @param {Object} context - Context object for logging
   * @param {string|null} contextId - Optional context ID for scoped file storage
   * @param {Object} options - Optional source/target blob path overrides
   * @returns {Promise<Object>} Updated file info
   */
  async renameFile(hash, newFilename, context = {}, contextId = null, options = {}) {
    await this._initialize();

    if (!hash) throw new Error("Missing hash parameter");
    if (!newFilename || !newFilename.trim()) throw new Error("Missing newFilename parameter");

    const {
      sourceBlobPath = "",
      targetBlobPath = "",
    } = typeof options === "string"
      ? { targetBlobPath: options }
      : options || {};
    const sanitizedTargetBlobPath = targetBlobPath
      ? sanitizeTargetBlobPath(targetBlobPath)
      : "";
    if (targetBlobPath && !sanitizedTargetBlobPath) {
      throw new Error("Invalid targetBlobPath parameter");
    }

    const { getFileStoreMap, setFileStoreMap } = await import("../../redis.js");
    const hashResult = await getFileStoreMap(hash, false, contextId);
    if (!hashResult) throw new Error(`File with hash ${hash} not found`);

    const trimmedName = newFilename.trim();
    const sanitized = sanitizeFilename(trimmedName);

    // --- Rename in primary (Azure) storage ---
    let newUrl = hashResult.url;
    let newShortLivedUrl = hashResult.shortLivedUrl || hashResult.url;
    let newPrimaryBlobName = hashResult.blobPath || hashResult.blobName || "";

    if (hashResult.url && hashResult.url.startsWith('http')) {
      // Get the correct provider for the URL's container (may be per-user)
      const containerName = this._extractContainerFromUrl(hashResult.url);
      const provider = containerName
        ? await StorageFactory.getInstance().getAzureProvider(containerName)
        : this.primaryProvider;

      const oldBlobName = sourceBlobPath || provider.extractBlobNameFromUrl(hashResult.url);
      if (oldBlobName) {
        const newBlobName = sanitizedTargetBlobPath
          || this._computeNewBlobName(oldBlobName, sanitized);
        context.log?.(`Renaming blob: ${oldBlobName} → ${newBlobName}`);
        const result = await provider.renameBlob(oldBlobName, newBlobName);
        newUrl = result.url;
        newShortLivedUrl = result.shortLivedUrl || result.url;
        newPrimaryBlobName = newBlobName;
      }
    }

    // --- Rename in backup (GCS) storage ---
    let newGcs = hashResult.gcs;
    if (hashResult.gcs && this.backupProvider && typeof this.backupProvider.renameBlob === 'function') {
      try {
        const gcsUrl = this.backupProvider.ensureUnencodedGcsUrl
          ? this.backupProvider.ensureUnencodedGcsUrl(hashResult.gcs)
          : hashResult.gcs;
        const oldGcsBlobName = gcsUrl.replace("gs://", "").split("/").slice(1).join("/");
        const newGcsBlobName = sanitizedTargetBlobPath
          || this._computeNewBlobName(oldGcsBlobName, sanitized);

        context.log?.(`Renaming GCS blob: ${oldGcsBlobName} → ${newGcsBlobName}`);
        const gcsResult = await this.backupProvider.renameBlob(oldGcsBlobName, newGcsBlobName);
        newGcs = gcsResult.url;
      } catch (err) {
        context.log?.(`Warning: GCS rename failed: ${err.message}`);
      }
    }

    // --- Update Redis ---
    const updatedInfo = {
      ...hashResult,
      url: newUrl,
      gcs: newGcs,
      filename: sanitized,
      ...(newPrimaryBlobName ? {
        blobPath: newPrimaryBlobName,
        blobName: newPrimaryBlobName,
      } : {}),
      timestamp: new Date().toISOString(),
    };
    // Remove displayFilename — the blob name is now the source of truth
    delete updatedInfo.displayFilename;
    delete updatedInfo.shortLivedUrl;
    await setFileStoreMap(hash, updatedInfo, contextId);

    return {
      hash,
      filename: sanitized,
      url: newUrl,
      shortLivedUrl: newShortLivedUrl,
      gcs: newGcs,
      ...(newPrimaryBlobName ? { blobPath: newPrimaryBlobName } : {}),
      message: `File renamed to "${trimmedName}"`,
    };
  }

  /**
   * Extract container name from an Azure blob URL.
   * Handles both real Azure and Azurite URL formats.
   */
  _extractContainerFromUrl(url) {
    try {
      const urlObj = new URL(url);
      let pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
      if (pathParts[0] === AZURITE_ACCOUNT_NAME) {
        pathParts = pathParts.slice(1);
      }
      return pathParts[0] || null;
    } catch { return null; }
  }

  _extractBlobNameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      let pathParts = decodeURIComponent(urlObj.pathname).split('/').filter(p => p.length > 0);
      if (pathParts[0] === AZURITE_ACCOUNT_NAME) {
        pathParts = pathParts.slice(1);
      }
      return pathParts.length > 1 ? pathParts.slice(1).join('/') : null;
    } catch { return null; }
  }

  _extractContainerOwnerIdFromUrl(url) {
    const containerName = this._extractContainerFromUrl(url);
    const defaultContainer = getDefaultContainerName();
    const prefix = `${defaultContainer}-`;
    if (!containerName || !containerName.startsWith(prefix)) {
      return null;
    }
    return containerName.slice(prefix.length) || null;
  }

  _normalizeGCSBlobName(blobName) {
    if (!blobName || typeof blobName !== "string") {
      return "";
    }
    if (this.backupProvider?.normalizeBlobName) {
      return this.backupProvider.normalizeBlobName(blobName);
    }
    return blobName
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .join("/");
  }

  _getExpectedGCSBlobName(existingFile = {}) {
    const sourceBlobName = this._normalizeGCSBlobName(
      existingFile.gcsBlobName
      || existingFile.blobName
      || existingFile.blobPath
      || existingFile.name
      || this.primaryProvider?.extractBlobNameFromUrl?.(existingFile.url)
      || this._extractBlobNameFromUrl(existingFile.url)
    );

    if (!sourceBlobName) {
      return null;
    }

    const containerOwnerId = this._normalizeGCSBlobName(
      existingFile.containerOwnerId
      || existingFile.gcsPrefix
      || this._extractContainerOwnerIdFromUrl(existingFile.url)
    );

    if (containerOwnerId && !sourceBlobName.startsWith(`${containerOwnerId}/`)) {
      return `${containerOwnerId}/${sourceBlobName}`;
    }

    return sourceBlobName;
  }

  async getExpectedGCSUrl(existingFile = {}) {
    await this._initialize();
    if (!this.backupProvider?.bucketName) {
      return null;
    }
    const blobName = this._getExpectedGCSBlobName(existingFile);
    if (!blobName) {
      return null;
    }
    if (this.backupProvider.buildUrlForBlobName) {
      return this.backupProvider.buildUrlForBlobName(blobName);
    }
    return `gs://${this.backupProvider.bucketName}/${blobName}`;
  }

  /**
   * Compute a new blob name by replacing the filename portion while preserving
   * the folder path and hash prefix.
   * @param {string} oldBlobName - Current blob name (e.g., "chats/abc/hash_old.png")
   * @param {string} sanitizedNewName - Sanitized new filename (e.g., "new name.png")
   * @param {boolean} urlEncode - Whether to encodeURIComponent the filename (Azure yes, GCS no)
   */
  _computeNewBlobName(oldBlobName, sanitizedNewName) {
    const lastSlash = oldBlobName.lastIndexOf('/');
    const folderPath = lastSlash >= 0 ? oldBlobName.substring(0, lastSlash) : '';
    const oldFilePart = lastSlash >= 0 ? oldBlobName.substring(lastSlash + 1) : oldBlobName;

    // Inspect the hash prefix from the blob name
    const hashMatch = oldFilePart.match(/^([a-f0-9]+)_/i);
    const hashPrefix = hashMatch ? hashMatch[1] : null;

    // Blob names are stored unencoded; Azure SDK handles URL-encoding.
    // Do NOT encodeURIComponent here — that would double-encode.
    const newFileBase = hashPrefix ? `${hashPrefix}_${sanitizedNewName}` : sanitizedNewName;
    return folderPath ? `${folderPath}/${newFileBase}` : newFileBase;
  }

  async uploadFileWithProviders(context, filePath, requestId, hash = null, filename = null, gcsFolderPath = null) {
    await this._initialize();

    // Use provided filename or generate one
    const finalFilename = filename || (() => {
      const fileExtension = path.extname(filePath);
      const shortId = generateShortId();
      return `${shortId}${fileExtension}`;
    })();

    // Always use the default provider (container parameter ignored)
    const primaryProvider = this.primaryProvider;

    const primaryResult = await primaryProvider.uploadFile(
      context,
      filePath,
      requestId,
      hash,
      finalFilename
    );

    let gcsResult = null;
    if (this.backupProvider) {
      gcsResult = await this.backupProvider.uploadFile(
        context,
        filePath,
        requestId,
        hash,
        finalFilename,
        gcsFolderPath,
      );
    }

    // Ensure shortLivedUrl is always included
    const result = { ...primaryResult, gcs: gcsResult?.url };
    if (!result.shortLivedUrl && result.url) {
      // Fallback: generate short-lived URL if not provided
      if (primaryProvider.generateShortLivedSASToken) {
        try {
          await primaryProvider.ensureInitialized();
          const blobName = primaryResult.blobName || primaryProvider.extractBlobNameFromUrl(result.url);
          if (blobName) {
            const shortLivedSasToken = primaryProvider.generateShortLivedSASToken(blobName, 5);
            const urlObj = new URL(result.url);
            const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
            result.shortLivedUrl = `${baseUrl}?${shortLivedSasToken}`;
          }
        } catch (error) {
          context.log?.(`Warning: Could not generate shortLivedUrl: ${error.message}`);
        }
      }
      // If still no shortLivedUrl, use the regular URL as fallback
      if (!result.shortLivedUrl) {
        result.shortLivedUrl = result.url;
      }
    }

    return result;
  }

  async deleteFiles(requestId) {
    await this._initialize();
    
    if (!requestId) {
      throw new Error("Missing requestId parameter");
    }

    const results = [];

    // Delete from primary storage
    try {
      const primaryResult = await this.primaryProvider.deleteFiles(requestId);
      if (primaryResult && primaryResult.length > 0) {
        results.push(...primaryResult);
      }
    } catch (error) {
      console.error(
        `Error deleting files from primary storage for ${requestId}:`,
        error,
      );
    }

    // If GCS is configured, delete from there too
    if (this.backupProvider) {
      try {
        const gcsResult = await this.backupProvider.deleteFiles(requestId);
        if (gcsResult && gcsResult.length > 0) {
          results.push(...gcsResult);
        }
      } catch (error) {
        console.error(`Error deleting files from GCS for ${requestId}:`, error);
      }
    }

    return results;
  }

  async fileExists(url) {
    await this._initialize();
    
    if (!url) {
      return false;
    }

    try {
      if (url.startsWith("gs://")) {
        return this.backupProvider
          ? await this.backupProvider.fileExists(url)
          : false;
      }
      return await this.primaryProvider.fileExists(url);
    } catch (error) {
      console.error(`Error checking file existence for ${url}:`, error);
      return false;
    }
  }

  async cleanup(urls) {
    await this._initialize();
    
    if (!urls || !urls.length) return;

    const results = [];

    // Split URLs by type
    const primaryUrls = [];
    const gcsUrls = [];

    for (const url of urls) {
      if (url.startsWith("gs://")) {
        gcsUrls.push(url);
      } else {
        primaryUrls.push(url);
      }
    }

    // Clean up primary storage
    if (primaryUrls.length > 0) {
      const primaryResult = await this.primaryProvider.cleanup(primaryUrls);
      results.push(...primaryResult);
    }

    // Clean up GCS if configured
    if (gcsUrls.length > 0 && this.backupProvider) {
      const gcsResult = await this.backupProvider.cleanup(gcsUrls);
      results.push(...gcsResult);
    }

    return results;
  }

  async ensureGCSUpload(context, existingFile, options = {}) {
    await this._initialize();
    
    if (
      !this.backupProvider ||
      !existingFile.url ||
      !this.backupProvider.isConfigured()
    ) {
      return existingFile;
    }

    const expectedGCSBlobName = this._getExpectedGCSBlobName(existingFile);
    const expectedGCSUrl = expectedGCSBlobName
      ? (
        this.backupProvider.buildUrlForBlobName
          ? this.backupProvider.buildUrlForBlobName(expectedGCSBlobName)
          : `gs://${this.backupProvider.bucketName}/${expectedGCSBlobName}`
      )
      : null;

    // If we already have a GCS URL, check if it exists
    if (existingFile.gcs) {
      const exists = await this.backupProvider.fileExists(existingFile.gcs);
      if (exists) {
        return existingFile;
      }
    }

    if (expectedGCSUrl) {
      const expectedExists = await this.backupProvider.fileExists(expectedGCSUrl);
      if (expectedExists) {
        return {
          ...existingFile,
          gcs: expectedGCSUrl,
        };
      }
    }

    if (!expectedGCSBlobName) {
      return existingFile;
    }

    const lockKey = `gcs-ensure:${expectedGCSUrl || expectedGCSBlobName}`;
    const { acquireLock, releaseLock } = await import("../../redis.js");
    const lockAcquired = await acquireLock(lockKey, GCS_ENSURE_LOCK_TTL_SECONDS);
    if (!lockAcquired) {
      context.log?.(`GCS backup already being ensured: ${expectedGCSUrl || expectedGCSBlobName}`);
      const waitForInFlightMs = Number(options.waitForInFlightMs || 0);
      if (expectedGCSUrl && waitForInFlightMs > 0) {
        const deadline = Date.now() + waitForInFlightMs;
        const pollEveryMs = Math.max(50, Number(options.pollEveryMs || 250));
        while (Date.now() < deadline) {
          if (await this.backupProvider.fileExists(expectedGCSUrl)) {
            return {
              ...existingFile,
              gcs: expectedGCSUrl,
            };
          }
          await sleep(Math.min(pollEveryMs, Math.max(0, deadline - Date.now())));
        }
      }
      return {
        ...existingFile,
      };
    }

    try {
      if (expectedGCSUrl) {
        const existsAfterLock = await this.backupProvider.fileExists(expectedGCSUrl);
        if (existsAfterLock) {
          return {
            ...existingFile,
            gcs: expectedGCSUrl,
          };
        }
      }

      const response = await axios({
        method: "get",
        url: existingFile.url,
        responseType: "stream",
      });
      const contentType = existingFile.mimeType || response.headers?.["content-type"] || null;

      const gcsResult = this.backupProvider.uploadStreamToBlobName
        ? await this.backupProvider.uploadStreamToBlobName(
          context,
          expectedGCSBlobName,
          response.data,
          contentType,
        )
        : await this.backupProvider.uploadStream(
          context,
          path.basename(expectedGCSBlobName),
          response.data,
          contentType,
          path.dirname(expectedGCSBlobName) === "." ? null : path.dirname(expectedGCSBlobName),
        );

      return {
        ...existingFile,
        gcs: gcsResult.url || gcsResult,
      };
    } finally {
      await releaseLock(lockKey);
    }
  }

  async downloadFileFromBackup(url, destinationPath = null) {
    await this._initialize();
    
    if (!this.backupProvider) {
      throw new Error("Backup provider not configured");
    }
    // Delegate to the unified downloadFile handler
    return await this.downloadFile(url, destinationPath);
  }
}
