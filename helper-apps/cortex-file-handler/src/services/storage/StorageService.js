import { StorageFactory } from "./StorageFactory.js";
import path from "path";
import os from "os";
import fs from "fs";
import { generateShortId } from "../../utils/filenameUtils.js";

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
            2) uploadFile(context, filePath, requestId, hash?, filename?, containerName?) – legacy internal use
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
        const { url } = await this.primaryProvider.uploadFile(
          {},
          tempFile,
          filename,
        );
        return { url };
      } finally {
        if (fs.existsSync(tempFile)) {
          await fs.promises.unlink(tempFile).catch(() => {});
        }
      }
    }

    // Fallback to legacy (context, filePath, requestId, hash?, filename?, containerName?)
    const [context, filePath, requestId, hash, filename, containerName] = args;
    return this.uploadFileWithProviders(context, filePath, requestId, hash, filename, containerName);
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
    
    if (typeof this.primaryProvider.deleteFile === "function") {
      return await this.primaryProvider.deleteFile(url);
    }
    // Fallback for providers that only have deleteFiles
    return await this.primaryProvider.deleteFiles([url]);
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
   * Delete a single file by its hash from both primary and backup storage
   * @param {string} hash - The hash of the file to delete
   * @param {string} containerName - Optional container name for scoping the hash
   * @returns {Promise<Object>} Object containing deletion results and file info
   */
  async deleteFileByHash(hash, containerName = null) {
    await this._initialize();
    
    if (!hash) {
      throw new Error("Missing hash parameter");
    }

    const results = [];

    // Get and remove file information from Redis map (non-atomic operations)
    const { getFileStoreMap, removeFromFileStoreMap, getScopedHashKey, getDefaultContainerName } = await import("../../redis.js");
    const { getDefaultContainerName: getDefaultContainerNameFromConstants } = await import("../../constants.js");
    const scopedHash = getScopedHashKey(hash, containerName);
    const hashResult = await getFileStoreMap(scopedHash);
    
    if (hashResult) {
      // Remove from scoped key
      await removeFromFileStoreMap(scopedHash);
      
      // Also check and remove legacy key (unscoped) if this is the default container
      // This handles backwards compatibility with old entries stored without container scoping
      const defaultContainerName = getDefaultContainerNameFromConstants();
      const effectiveContainer = containerName || defaultContainerName;
      if (effectiveContainer === defaultContainerName && scopedHash.includes(':')) {
        const [legacyHash] = scopedHash.split(':', 2);
        // Try to remove legacy key - only attempt if it exists to avoid unnecessary "does not exist" logs
        const legacyExists = await getFileStoreMap(legacyHash);
        if (legacyExists) {
          await removeFromFileStoreMap(legacyHash);
        }
      }
    }
    
    if (!hashResult) {
      throw new Error(`File with hash ${hash} not found`);
    }

    // Delete from primary storage
    if (hashResult.url) {
      try {
        // Log the URL being deleted for debugging
        console.log(`Deleting file from primary storage - hash: ${hash}, url: ${hashResult.url}`);
        const primaryResult = await this.deleteFile(hashResult.url);
        if (primaryResult) {
          console.log(`Successfully deleted from primary storage - hash: ${hash}, result: ${primaryResult}`);
          results.push({ provider: 'primary', result: primaryResult });
        } else {
          // deleteFile returned null, which means the URL was invalid
          console.warn(`Invalid or empty URL for hash ${hash}: ${hashResult.url}`);
          results.push({ provider: 'primary', error: 'Invalid URL (container-only or empty blob name)' });
        }
      } catch (error) {
        console.error(`Error deleting file from primary storage:`, error);
        results.push({ provider: 'primary', error: error.message });
      }
    }

    // Delete from backup storage (GCS)
    if (hashResult.gcs && this.backupProvider) {
      try {
        console.log(`Deleting file from backup storage - hash: ${hash}, gcs: ${hashResult.gcs}`);
        const backupResult = await this.deleteFileFromBackup(hashResult.gcs);
        if (backupResult) {
          console.log(`Successfully deleted from backup storage - hash: ${hash}, result: ${backupResult}`);
          results.push({ provider: 'backup', result: backupResult });
        } else {
          console.warn(`Backup deletion returned null for hash ${hash}: ${hashResult.gcs}`);
          results.push({ provider: 'backup', error: 'Deletion returned null' });
        }
      } catch (error) {
        console.error(`Error deleting file from backup storage:`, error);
        results.push({ provider: 'backup', error: error.message });
      }
    } else {
      if (!hashResult.gcs) {
        console.log(`No GCS URL found for hash ${hash}, skipping backup deletion`);
      } else if (!this.backupProvider) {
        console.log(`Backup provider not configured, skipping backup deletion for hash ${hash}`);
      }
    }

    // Note: Hash was already removed from Redis atomically at the beginning
    // No need to remove again

    return {
      hash,
      deleted: results,
      filename: hashResult.filename
    };
  }

  async uploadFileWithProviders(context, filePath, requestId, hash = null, filename = null, containerName = null) {
    await this._initialize();
    
    // Use provided filename or generate one
    const finalFilename = filename || (() => {
      const fileExtension = path.extname(filePath);
      const shortId = generateShortId();
      return `${shortId}${fileExtension}`;
    })();

    // Get the appropriate provider for the container
    const primaryProvider = containerName ? 
      await this.factory.getAzureProvider(containerName) : 
      this.primaryProvider;

    const primaryResult = await primaryProvider.uploadFile(
      context,
      filePath,
      requestId,
      hash,
      finalFilename,
    );

    let gcsResult = null;
    if (this.backupProvider) {
      gcsResult = await this.backupProvider.uploadFile(
        context,
        filePath,
        requestId,
        hash,
        finalFilename,
      );
    }

    return { ...primaryResult, gcs: gcsResult?.url };
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

  async ensureGCSUpload(context, existingFile) {
    await this._initialize();
    
    if (
      !this.backupProvider ||
      !existingFile.url ||
      !this.backupProvider.isConfigured()
    ) {
      return existingFile;
    }

    // If we already have a GCS URL, check if it exists
    if (existingFile.gcs) {
      const exists = await this.backupProvider.fileExists(existingFile.gcs);
      if (exists) {
        return existingFile;
      }
    }

    // Download from primary storage
    const tempFile = path.join(os.tmpdir(), path.basename(existingFile.url));
    try {
      await this.primaryProvider.downloadFile(existingFile.url, tempFile);

      // Upload to GCS
      const requestId = path.dirname(existingFile.blobName) || "restore";
      const gcsResult = await this.backupProvider.uploadFile(
        context,
        tempFile,
        requestId,
      );

      return {
        ...existingFile,
        gcs: gcsResult.url,
      };
    } finally {
      // Cleanup temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
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
