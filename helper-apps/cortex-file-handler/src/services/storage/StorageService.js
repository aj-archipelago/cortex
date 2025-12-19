import { StorageFactory } from "./StorageFactory.js";
import path from "path";
import os from "os";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
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
          null, // filename (will use provided filename)
          'temporary' // retention
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
    
    // Always use primary provider - single container only
    const provider = this.primaryProvider;
    
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

    // Get and remove file information from Redis map
    const { getFileStoreMap, removeFromFileStoreMap } = await import("../../redis.js");
    const hashResult = await getFileStoreMap(hash, false, contextId);
    
    if (hashResult) {
      // Remove from Redis
      await removeFromFileStoreMap(hash, contextId);
    }
    
    if (!hashResult) {
      throw new Error(`File with hash ${hash} not found`);
    }

    // Delete from primary storage
    if (hashResult.url) {
      try {
        // Log the URL being deleted for debugging (redact SAS token for security)
        const { redactSasToken } = await import('../../utils/logSecurity.js');
        console.log(`Deleting file from primary storage - hash: ${hash}, url: ${redactSasToken(hashResult.url)}`);
        
        // Always use primary provider - single container only
        const provider = this.primaryProvider;
        
        const primaryResult = await provider.deleteFile(hashResult.url);
        if (primaryResult) {
          console.log(`Successfully deleted from primary storage - hash: ${hash}, result: ${primaryResult}`);
          results.push({ provider: 'primary', result: primaryResult });
        } else {
          // deleteFile returned null, which means the URL was invalid or blob not found
          console.warn(`Invalid or empty URL for hash ${hash}: ${redactSasToken(hashResult.url)}`);
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
      filename: hashResult.filename,
      ...(hashResult.displayFilename && { displayFilename: hashResult.displayFilename })
    };
  }

  /**
   * Set the retention tag for a file (temporary or permanent)
   * This is a simple tag update operation - no file copying occurs
   * @param {string} hash - The hash of the file
   * @param {string} retention - The retention value ('temporary' or 'permanent')
   * @param {Object} context - Context object for logging
   * @param {string|null} contextId - Optional context ID for scoped file storage
   * @returns {Promise<Object>} Object containing updated file info
   */
  async setRetention(hash, retention, context = {}, contextId = null) {
    await this._initialize();
    
    if (!hash) {
      throw new Error("Missing hash parameter");
    }
    
    if (retention !== 'temporary' && retention !== 'permanent') {
      throw new Error("Retention must be 'temporary' or 'permanent'");
    }

    // Get Redis functions
    const { getFileStoreMap, setFileStoreMap } = await import("../../redis.js");
    
    // Look up file by hash - getFileStoreMap handles context-scoped maps automatically
    const hashResult = await getFileStoreMap(hash, false, contextId);
    
    if (!hashResult) {
      throw new Error(`File with hash ${hash} not found`);
    }

    context.log?.(`Setting retention tag for file ${hash} to ${retention}`);

    // Extract blob name from URL
    if (!hashResult.url) {
      throw new Error(`File with hash ${hash} has no valid URL`);
    }

    // Always use primary provider - single container only
    const provider = this.primaryProvider;
    
    // Check if provider supports blob tag operations (Azure only)
    const supportsBlobTags = typeof provider.extractBlobNameFromUrl === 'function' && 
                             typeof provider.updateBlobTags === 'function' &&
                             typeof provider.getBlobClient === 'function' &&
                             typeof provider.generateShortLivedSASToken === 'function';
    
    let shortLivedUrl = hashResult.shortLivedUrl || hashResult.url;
    let convertedResult = hashResult.converted || null;

    if (supportsBlobTags) {
      // Extract blob name from URL
      const blobName = provider.extractBlobNameFromUrl(hashResult.url);
      if (!blobName) {
        throw new Error(`Could not extract blob name from URL: ${hashResult.url}`);
      }

      // Update blob index tag
      // Note: This may fail in Azurite (local emulator) which doesn't fully support blob tags
      // We'll continue with the operation even if tag update fails
      context.log?.(`Updating blob index tag for ${blobName} to ${retention}`);
      try {
        await provider.updateBlobTags(blobName, retention);
      } catch (error) {
        // Log warning but continue - blob tags may not be supported in test environments (e.g., Azurite)
        context.log?.(`Warning: Failed to update blob tags for ${blobName}: ${error.message}. Continuing with operation.`);
      }

      // Generate new short-lived URL
      const { containerClient } = await provider.getBlobClient();
      const shortLivedSasToken = provider.generateShortLivedSASToken(containerClient, blobName, 5);
      const urlObj = new URL(hashResult.url);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
      shortLivedUrl = `${baseUrl}?${shortLivedSasToken}`;

      // Handle converted file if it exists
      if (hashResult.converted?.url) {
        context.log?.(`Updating blob index tag for converted file to ${retention}`);
        const convertedBlobName = provider.extractBlobNameFromUrl(hashResult.converted.url);
        if (convertedBlobName) {
          try {
            await provider.updateBlobTags(convertedBlobName, retention);
            const convertedUrlObj = new URL(hashResult.converted.url);
            const convertedBaseUrl = `${convertedUrlObj.protocol}//${convertedUrlObj.host}${convertedUrlObj.pathname}`;
            const convertedShortLivedSasToken = provider.generateShortLivedSASToken(containerClient, convertedBlobName, 5);
            const convertedShortLivedUrl = `${convertedBaseUrl}?${convertedShortLivedSasToken}`;
            convertedResult = {
              url: hashResult.converted.url,
              shortLivedUrl: convertedShortLivedUrl,
              gcs: hashResult.converted.gcs
            };
          } catch (error) {
            context.log?.(`Warning: Failed to update converted file tag: ${error.message}`);
            convertedResult = hashResult.converted;
          }
        } else {
          convertedResult = hashResult.converted;
        }
      }
    } else {
      // For providers that don't support blob tags (e.g., LocalStorageProvider),
      // just use the existing URLs - retention is tracked in Redis only
      context.log?.(`Provider does not support blob tags, updating Redis only`);
      shortLivedUrl = hashResult.shortLivedUrl || hashResult.url;
      convertedResult = hashResult.converted || null;
    }

    // Update Redis with new information (including shortLivedUrl and permanent flag)
    // Store as permanent boolean to match file collection logic
    const newFileInfo = {
      ...hashResult,
      url: hashResult.url, // URL stays the same - same blob, just different tag
      shortLivedUrl: shortLivedUrl,
      gcs: hashResult.gcs,
      permanent: retention === 'permanent', // Store as boolean to match file collection logic
      timestamp: new Date().toISOString()
    };
    
    if (convertedResult) {
      newFileInfo.converted = convertedResult;
    }

    await setFileStoreMap(hash, newFileInfo, contextId);
    const { redactContextId } = await import("../../utils/logSecurity.js");
    context.log?.(`Updated Redis map for hash: ${hash}${contextId ? ` (contextId: ${redactContextId(contextId)})` : ""}`);

    return {
      hash,
      filename: hashResult.filename,
      ...(hashResult.displayFilename && { displayFilename: hashResult.displayFilename }),
      retention: retention,
      url: hashResult.url,
      shortLivedUrl: shortLivedUrl,
      gcs: hashResult.gcs,
      converted: convertedResult,
      message: `File retention set to ${retention}`
    };
  }

  async uploadFileWithProviders(context, filePath, requestId, hash = null, filename = null) {
    await this._initialize();
    
    // Use provided filename or generate one
    const finalFilename = filename || (() => {
      const fileExtension = path.extname(filePath);
      const shortId = generateShortId();
      return `${shortId}${fileExtension}`;
    })();

    // Always use the default provider (container parameter ignored)
    const primaryProvider = this.primaryProvider;

    // All files are uploaded with retention=temporary by default
    const primaryResult = await primaryProvider.uploadFile(
      context,
      filePath,
      requestId,
      hash,
      finalFilename,
      'temporary' // retention tag
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

    // Ensure shortLivedUrl is always included
    const result = { ...primaryResult, gcs: gcsResult?.url };
    if (!result.shortLivedUrl && result.url) {
      // Fallback: generate short-lived URL if not provided
      if (primaryProvider.generateShortLivedSASToken) {
        try {
          const { containerClient } = await primaryProvider.getBlobClient();
          const blobName = primaryResult.blobName || primaryProvider.extractBlobNameFromUrl(result.url);
          if (blobName) {
            const shortLivedSasToken = primaryProvider.generateShortLivedSASToken(containerClient, blobName, 5);
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
    // Extract filename from URL (remove query parameters first)
    const urlWithoutQuery = existingFile.url.split('?')[0];
    const filename = path.basename(urlWithoutQuery) || `restore-${uuidv4()}`;
    const tempFile = path.join(os.tmpdir(), filename);
    try {
      await this.primaryProvider.downloadFile(existingFile.url, tempFile);

      // Upload to GCS - extract requestId from blobName if available, otherwise use empty string
      const requestId = existingFile.blobName ? path.dirname(existingFile.blobName) : "";
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
