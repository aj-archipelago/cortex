import { StorageFactory } from "./StorageFactory.js";
import path from "path";
import os from "os";
import fs from "fs";
import { generateShortId } from "../../utils/filenameUtils.js";

export class StorageService {
  constructor(factory, containerName = null) {
    this.factory = factory || new StorageFactory();
    this.containerName = containerName;
    this._initPromise = this._initialize(containerName);
  }

  async _initialize(containerName) {
    this.primaryProvider = await this.factory.getPrimaryProvider(containerName);
    this.backupProvider = this.factory.getGCSProvider();
  }

  async ensureInitialized() {
    await this._initPromise;
  }

  getPrimaryProvider() {
    return this.primaryProvider;
  }

  getBackupProvider() {
    return this.backupProvider;
  }

  async uploadFile(...args) {
    /*
            Supported call shapes:
            1) uploadFile(buffer, filename)
            2) uploadFile(context, filePath, requestId, hash?) – legacy internal use
        */

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

    // Fallback to legacy (context, filePath, requestId, hash?)
    const [context, filePath, requestId, hash] = args;
    return this.uploadFileWithProviders(context, filePath, requestId, hash);
  }

  async uploadFileToBackup(fileOrBuffer, filename) {
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
    if (typeof this.primaryProvider.deleteFile === "function") {
      return await this.primaryProvider.deleteFile(url);
    }
    // Fallback for providers that only have deleteFiles
    return await this.primaryProvider.deleteFiles([url]);
  }

  async deleteFileFromBackup(url) {
    if (!this.backupProvider) {
      throw new Error("Backup provider not configured");
    }
    if (typeof this.backupProvider.deleteFile === "function") {
      return await this.backupProvider.deleteFile(url);
    }
    // Fallback for providers that only have deleteFiles
    return await this.backupProvider.deleteFiles([url]);
  }

  async uploadFileWithProviders(context, filePath, requestId, hash = null) {
    // Generate filename once to ensure both providers use the same name
    const fileExtension = path.extname(filePath);
    const shortId = generateShortId();
    const filename = `${shortId}${fileExtension}`;

    const primaryResult = await this.primaryProvider.uploadFile(
      context,
      filePath,
      requestId,
      hash,
      filename,
    );

    let gcsResult = null;
    if (this.backupProvider) {
      gcsResult = await this.backupProvider.uploadFile(
        context,
        filePath,
        requestId,
        hash,
        filename,
      );
    }

    return { ...primaryResult, gcs: gcsResult?.url };
  }

  async deleteFiles(requestId) {
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
    if (!this.backupProvider) {
      throw new Error("Backup provider not configured");
    }
    // Delegate to the unified downloadFile handler
    return await this.downloadFile(url, destinationPath);
  }
}
