import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import fs from "fs";
import path from "path";
import mime from "mime-types";

import { StorageProvider } from "./StorageProvider.js";
import { AZURITE_ACCOUNT_NAME } from "../../constants.js";
import {
  generateShortId,
  generateBlobName,
  sanitizeFilename,
} from "../../utils/filenameUtils.js";
import { isTextMimeType as isTextMimeTypeUtil } from "../../utils/mimeUtils.js";

export class AzureStorageProvider extends StorageProvider {
  constructor(connectionString, containerName) {
    super();
    if (!connectionString || !containerName) {
      throw new Error(
        "Missing Azure Storage connection string or container name",
      );
    }
    this.connectionString = connectionString;
    this.containerName = containerName;
    this.sasTokenLifeDays = process.env.SAS_TOKEN_LIFE_DAYS || 30;
    this._containerEnsured = false;

    // Cached clients — lazily initialized by _doInitialize()
    this._blobServiceClient = null;
    this._containerClient = null;
    this._sharedKeyCredential = null;
    this._initPromise = null;
  }

  /**
   * Lazy one-time initialization: creates BlobServiceClient, checks service
   * version, creates containerClient, and caches StorageSharedKeyCredential.
   * Uses promise coalescence so concurrent callers share the same init.
   */
  async ensureInitialized() {
    if (this._sharedKeyCredential) return; // already done
    if (!this._initPromise) {
      this._initPromise = this._doInitialize();
    }
    await this._initPromise;
  }

  async _doInitialize() {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      this.connectionString,
    );

    // Ensure service version is set
    const serviceProperties = await blobServiceClient.getProperties();
    if (!serviceProperties.defaultServiceVersion) {
      serviceProperties.defaultServiceVersion = "2020-02-10";
      await blobServiceClient.setProperties(serviceProperties);
    }

    const containerClient = blobServiceClient.getContainerClient(
      this.containerName,
    );

    // Extract and cache the shared key credential
    let accountName, accountKey;
    if (containerClient.credential && containerClient.credential.accountName) {
      accountName = containerClient.credential.accountName;
      if (Buffer.isBuffer(containerClient.credential.accountKey)) {
        accountKey = containerClient.credential.accountKey.toString('base64');
      } else {
        accountKey = containerClient.credential.accountKey;
      }
    } else {
      // Azurite development storage fallback — only if explicitly detected
      const isAzurite = process.env.AZURITE_ACCOUNTS
        || process.env.AZURE_STORAGE_EMULATOR
        || this.connectionString.includes(AZURITE_ACCOUNT_NAME);

      if (isAzurite) {
        accountName = AZURITE_ACCOUNT_NAME;
        // Well-known default Azurite development key (publicly documented)
        accountKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
      } else {
        throw new Error(
          "Could not extract Azure Storage credentials from the connection string and Azurite was not detected. "
          + "Set AZURITE_ACCOUNTS or AZURE_STORAGE_EMULATOR for local development, or provide a valid connection string.",
        );
      }
    }

    this._blobServiceClient = blobServiceClient;
    this._containerClient = containerClient;
    this._sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );
  }

  async getBlobClient({ createContainer = true } = {}) {
    await this.ensureInitialized();

    // Create container if it doesn't exist (only checked once per instance).
    // Only cache success; a failed create must retry on the next call so a
    // transient error does not poison this provider instance.
    if (createContainer && !this._containerEnsured) {
      try {
        await this._containerClient.createIfNotExists();
        this._containerEnsured = true;
      } catch (e) {
        // 409 = already exists, which is fine
        if (e.statusCode === 409) {
          this._containerEnsured = true;
        } else {
          console.error(`Failed to ensure container ${this.containerName}: ${e.message}`);
          throw e;
        }
      }
    }

    return { blobServiceClient: this._blobServiceClient, containerClient: this._containerClient };
  }

  /**
   * Generate a SAS token for a blob.
   * Dual-signature for backward compat:
   *   New: generateSASToken(blobName, options?)
   *   Old: generateSASToken(containerClient, blobName, options?) — containerClient is ignored
   */
  generateSASToken(firstArg, secondArg, thirdArg) {
    let blobName, options;
    if (typeof firstArg === 'string') {
      // New signature: generateSASToken(blobName, options?)
      blobName = firstArg;
      options = secondArg || {};
    } else {
      // Old signature: generateSASToken(containerClient, blobName, options?)
      blobName = secondArg;
      options = thirdArg || {};
    }

    if (!this._sharedKeyCredential) {
      throw new Error('AzureStorageProvider not initialized — call ensureInitialized() or getBlobClient() first');
    }

    // Support custom duration: minutes, hours, or fall back to default days
    let expirationTime;
    if (options.minutes) {
      expirationTime = new Date(new Date().valueOf() + options.minutes * 60 * 1000);
    } else if (options.hours) {
      expirationTime = new Date(new Date().valueOf() + options.hours * 60 * 60 * 1000);
    } else if (options.days) {
      expirationTime = new Date(new Date().valueOf() + options.days * 24 * 60 * 60 * 1000);
    } else {
      // Default to configured sasTokenLifeDays
      expirationTime = new Date(
        new Date().valueOf() + this.sasTokenLifeDays * 24 * 60 * 60 * 1000,
      );
    }

    const sasOptions = {
      containerName: this.containerName,
      blobName: blobName,
      permissions: options.permissions || "r",
      startsOn: new Date(),
      expiresOn: expirationTime,
    };

    return generateBlobSASQueryParameters(
      sasOptions,
      this._sharedKeyCredential,
    ).toString();
  }

  /**
   * Generate a short-lived SAS token.
   * Dual-signature for backward compat:
   *   New: generateShortLivedSASToken(blobName, minutes?)
   *   Old: generateShortLivedSASToken(containerClient, blobName, minutes?) — containerClient is ignored
   */
  generateShortLivedSASToken(firstArg, secondArg, thirdArg) {
    if (typeof firstArg === 'string') {
      // New signature: generateShortLivedSASToken(blobName, minutes?)
      return this.generateSASToken(firstArg, { minutes: secondArg || 5 });
    }
    // Old signature: generateShortLivedSASToken(containerClient, blobName, minutes?)
    return this.generateSASToken(secondArg, { minutes: thirdArg || 5 });
  }

  async uploadFile(context, filePath, requestId, hash = null, filename = null) {
    const { containerClient } = await this.getBlobClient();

    // Use provided filename or generate LLM-friendly naming
    let blobName;
    if (filename) {
      blobName = generateBlobName(requestId, filename);
    } else {
      const fileExtension = path.extname(filePath);
      const shortId = generateShortId();
      blobName = generateBlobName(requestId, `${shortId}${fileExtension}`);
    }

    // Validate blobName is not empty
    if (!blobName || blobName.trim().length === 0) {
      throw new Error(`Invalid blob name generated: blobName="${blobName}", requestId="${requestId}", filename="${filename}"`);
    }

    // Determine content-type from filename
    const sourceFilename = filename || filePath;
    let contentType = mime.lookup(sourceFilename);
    
    // For text MIME types, ensure charset=utf-8 is included if not already present
    if (contentType && this.isTextMimeType(contentType)) {
      if (!contentType.includes('charset=')) {
        contentType = `${contentType}; charset=utf-8`;
      }
    }

    // Set ContentEncoding to utf-8 for text files to help browsers interpret encoding correctly
    // Azure preserves ContentEncoding header even though it strips charset from ContentType
    const contentEncoding = (contentType && this.isTextMimeType(contentType)) ? 'utf-8' : undefined;

    // Create a read stream for the file
    const fileStream = fs.createReadStream(filePath);

    // Upload the file to Azure Blob Storage using the stream
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const uploadOptions = {
      blobHTTPHeaders: {
        ...(contentType ? { blobContentType: contentType } : {}),
        ...(contentEncoding ? { blobContentEncoding: contentEncoding } : {}),
        blobCacheControl: 'public, max-age=2592000, immutable',
      },
    };
    await blockBlobClient.uploadStream(fileStream, undefined, undefined, uploadOptions);

    // Generate SAS token after successful upload
    const sasToken = this.generateSASToken(containerClient, blobName);
    const shortLivedSasToken = this.generateShortLivedSASToken(containerClient, blobName, 5);

    const url = `${blockBlobClient.url}?${sasToken}`;
    const shortLivedUrl = `${blockBlobClient.url}?${shortLivedSasToken}`;
    
    // Validate that the URL contains a blob name (not just container)
    // Azure blob URLs should be: https://account.blob.core.windows.net/container/blobname
    // Container-only URLs end with /container/ or /container
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
    if (pathParts.length <= 1) {
      // Only container name, no blob name - this is invalid
      throw new Error(`Generated invalid Azure URL (container-only): ${url}, blobName: ${blobName}`);
    }

    return {
      url: url,
      shortLivedUrl: shortLivedUrl,
      blobName: blobName,
    };
  }

  async uploadStream(context, encodedFilename, stream, providedContentType = null, folderPath = null) {
    const { containerClient } = await this.getBlobClient();
    let contentType = providedContentType || mime.lookup(encodedFilename);

    // mime-types@3 maps .mp4 to 'application/mp4' (IANA-registered) which
    // browsers don't play inline. Override to the widely-supported type.
    if (contentType === 'application/mp4') {
      contentType = 'video/mp4';
    }

    // For text MIME types, ensure charset=utf-8 is included if not already present
    if (contentType && this.isTextMimeType(contentType)) {
      if (!contentType.includes('charset=')) {
        contentType = `${contentType}; charset=utf-8`;
      }
    }

    // Normalize the blob name: sanitizeFilename decodes and cleans.
    // Do NOT encodeURIComponent — Azure SDK handles URL-encoding internally
    // when constructing blockBlobClient.url. Encoding here would double-encode
    // (e.g., spaces become %20 in the blob name, then %2520 in the URL).
    let blobName = sanitizeFilename(encodedFilename);

    // If folderPath is provided, prepend it to create folder hierarchy
    if (folderPath) {
      // Normalize folder path: remove leading/trailing slashes
      const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, '');
      if (normalizedFolder) {
        blobName = `${normalizedFolder}/${blobName}`;
      }
    }

    // Validate blobName is not empty
    if (!blobName || blobName.trim().length === 0) {
      throw new Error(`Invalid blob name generated from encodedFilename: "${encodedFilename}"`);
    }

    // Set ContentEncoding to utf-8 for text files to help browsers interpret encoding correctly
    // Azure preserves ContentEncoding header even though it strips charset from ContentType
    const contentEncoding = (contentType && this.isTextMimeType(contentType)) ? 'utf-8' : undefined;
    
    const options = {
      blobHTTPHeaders: {
        ...(contentType ? { blobContentType: contentType } : {}),
        ...(contentEncoding ? { blobContentEncoding: contentEncoding } : {}),
        blobCacheControl: 'public, max-age=2592000, immutable',
      },
      maxConcurrency: 50,
      blockSize: 8 * 1024 * 1024,
    };

    let activeContainerClient = containerClient;
    let blockBlobClient = activeContainerClient.getBlockBlobClient(blobName);
    if (context.log) {
      context.log(`Uploading to Azure... ${blobName}`);
      context.log(`Setting content-type: ${contentType}`);
    }

    try {
      await blockBlobClient.uploadStream(stream, undefined, undefined, options);
    } catch (error) {
      const code = error?.code || error?.details?.errorCode;
      const missingContainer = error?.statusCode === 404 || code === "ContainerNotFound";
      const streamPath = typeof stream?.path === "string" ? stream.path : null;

      if (!missingContainer || !streamPath || !fs.existsSync(streamPath)) {
        throw error;
      }

      // A background empty-container cull or transient create failure can remove
      // the just-created scoped container before the first upload block lands.
      // Recreate the container and retry with a fresh file stream.
      console.warn(`Azure container ${this.containerName} missing during upload; recreating and retrying once`);
      this._containerEnsured = false;
      const retryClient = await this.getBlobClient();
      activeContainerClient = retryClient.containerClient;
      blockBlobClient = activeContainerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadStream(
        fs.createReadStream(streamPath),
        undefined,
        undefined,
        options,
      );
    }
    
    const sasToken = this.generateSASToken(activeContainerClient, blobName);
    const shortLivedSasToken = this.generateShortLivedSASToken(activeContainerClient, blobName, 5);
    
    const url = `${blockBlobClient.url}?${sasToken}`;
    const shortLivedUrl = `${blockBlobClient.url}?${shortLivedSasToken}`;
    
    // Validate that the URL contains a blob name (not just container)
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
    if (pathParts.length <= 1) {
      throw new Error(`Generated invalid Azure URL (container-only) from uploadStream: ${url}, blobName: ${blobName}`);
    }
    
    return { url, shortLivedUrl };
  }

  // Use shared utility for MIME type checking
  isTextMimeType(mimeType) {
    return isTextMimeTypeUtil(mimeType);
  }

  async deleteFiles(requestId) {
    if (!requestId) throw new Error("Missing requestId parameter");
    const { containerClient } = await this.getBlobClient();

    const result = [];
    const blobs = containerClient.listBlobsFlat();

    for await (const blob of blobs) {
      if (blob.name.startsWith(requestId)) {
        const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
        try {
          await blockBlobClient.delete();
          result.push(blob.name);
        } catch (error) {
          if (error.statusCode === 404) {
            console.warn(
              `Azure blob already missing during delete: ${blob.name}`,
            );
          } else {
            throw error;
          }
        }
      }
    }

    return result;
  }

  async deleteFile(url) {
    if (!url) throw new Error("Missing URL parameter");

    try {
      const { containerClient } = await this.getBlobClient();

      // Use extractBlobNameFromUrl which correctly handles both standard Azure
      // and Azurite URL formats by finding the container name index
      const blobName = this.extractBlobNameFromUrl(url);

      if (!blobName || blobName.trim().length === 0) {
        console.warn(`Invalid blob URL (could not extract blob name): ${url}`);
        return null;
      }

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      try {
        await blockBlobClient.delete();
        return blobName;
      } catch (error) {
        if (error.statusCode === 404) {
          console.warn(`Azure blob not found during delete: ${blobName}`);
          return null;
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error("Error deleting Azure blob:", error);
      throw error;
    }
  }

  async fileExists(url) {
    try {
      // First attempt a lightweight HEAD request
      const headResp = await fetch(url, { method: "HEAD" });
      if (headResp.ok) return true;

      // Some emulators (e.g. Azurite) may not properly support HEAD with SAS.
      // Fall back to a ranged GET of a single byte.
      const getResp = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
      });
      return getResp.ok || getResp.status === 206; // 206 Partial Content
    } catch (error) {
      console.error("Error checking if file exists:", error);
      return false;
    }
  }

  async downloadFile(url, destinationPath) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    // In newer Node versions, response.body is a web-stream, not a Node stream.
    // Easier + reliable: read into a Buffer then write to file.
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.promises.writeFile(destinationPath, buffer);
  }

  async cleanup(urls) {
    if (!urls || !urls.length) return;

    const { containerClient } = await this.getBlobClient();
    const result = [];

    for (const url of urls) {
      try {
        const blobName = this.extractBlobNameFromUrl(url);
        if (blobName) {
          const blockBlobClient = containerClient.getBlockBlobClient(blobName);
          await blockBlobClient.delete();
          result.push(blobName);
        }
      } catch (error) {
        console.error(`Error cleaning up blob ${url}:`, error);
      }
    }

    return result;
  }

  isEncoded(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
  }

  extractBlobNameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      // Decode the pathname to reverse URL encoding applied by the Azure SDK.
      // Blob names may contain percent-encoded characters (e.g., %20 for spaces),
      // and the SDK further encodes the % as %25 when building the URL (%20 → %2520).
      // A single decodeURIComponent reverses that to get the actual blob name.
      const decodedPath = decodeURIComponent(urlObj.pathname);
      const pathParts = decodedPath.split("/");
      const containerIndex = pathParts.indexOf(this.containerName);
      if (containerIndex === -1) return null;

      return pathParts.slice(containerIndex + 1).join("/");
    } catch (error) {
      console.error("Error extracting blob name from URL:", error);
      return null;
    }
  }

  /**
   * List all files in a folder path
   * @param {string} folderPath - The folder path to list (e.g., 'users/123/global')
   * @returns {Promise<Array>} Array of file objects with name, filename, hash, lastModified
   */
  async listFolder(folderPath) {
    const { containerClient } = await this.getBlobClient({ createContainer: false });

    // Ensure folder path ends with / for proper prefix matching
    // Empty string means "list everything" — use undefined prefix (no filter)
    const prefix = folderPath === '' ? undefined : (folderPath.endsWith('/') ? folderPath : `${folderPath}/`);
    const results = [];

    try {
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        // Extract just the filename from the full blob path and decode
        // (blob names are URL-encoded by uploadStream via encodeURIComponent)
        const rawFilename = blob.name.split('/').pop();
        let filename;
        try { filename = decodeURIComponent(rawFilename); } catch { filename = rawFilename; }

        // Extract hash from filename if it matches pattern {hash}_{filename}
        // Hash is a hex string (xxhash64 produces 16-char hex strings)
        const hashMatch = filename.match(/^([a-f0-9]+)_/i);

        // Generate a short-lived SAS URL for direct download (60 min)
        const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
        const sasToken = this.generateShortLivedSASToken(containerClient, blob.name, 60);

        results.push({
          name: blob.name, // Full blob path
          filename: hashMatch ? filename.replace(/^[a-f0-9]+_/i, '') : filename, // Original filename without hash prefix
          hash: hashMatch ? hashMatch[1] : null,
          lastModified: blob.properties.lastModified,
          contentType: blob.properties.contentType,
          size: blob.properties.contentLength,
          url: `${blockBlobClient.url}?${sasToken}`,
        });
      }
    } catch (e) {
      // A user with no uploads yet has no per-user container — treat as empty.
      const code = e?.code || e?.details?.errorCode;
      if (e?.statusCode === 404 || code === "ContainerNotFound") {
        return [];
      }
      throw e;
    }

    return results;
  }

  /**
   * Rename a blob by copying to a new name and deleting the old one.
   * @param {string} oldBlobName - The current blob name
   * @param {string} newBlobName - The new blob name
   * @returns {Promise<{url: string, shortLivedUrl: string, blobName: string}>}
   */
  async renameBlob(oldBlobName, newBlobName) {
    const { containerClient } = await this.getBlobClient();

    // If the blob names are identical, skip the copy-delete cycle
    // (otherwise copy-to-self then delete would destroy the file)
    if (oldBlobName === newBlobName) {
      const blobClient = containerClient.getBlockBlobClient(oldBlobName);
      const sasToken = this.generateSASToken(oldBlobName);
      const shortLivedSasToken = this.generateShortLivedSASToken(oldBlobName, 5);
      return {
        url: `${blobClient.url}?${sasToken}`,
        shortLivedUrl: `${blobClient.url}?${shortLivedSasToken}`,
        blobName: oldBlobName,
      };
    }

    const oldBlobClient = containerClient.getBlockBlobClient(oldBlobName);
    const newBlobClient = containerClient.getBlockBlobClient(newBlobName);

    // Generate a short SAS token so the copy source is accessible
    const sourceSas = this.generateShortLivedSASToken(oldBlobName, 10);
    const sourceUrl = `${oldBlobClient.url}?${sourceSas}`;

    // Copy old blob to new name
    const copyPoller = await newBlobClient.beginCopyFromURL(sourceUrl);
    await copyPoller.pollUntilDone();

    // Delete the old blob — if this fails the old blob is orphaned but
    // the rename still succeeds (the new blob exists).
    try {
      await oldBlobClient.delete();
    } catch (deleteErr) {
      console.error(`Orphaned blob after rename: ${oldBlobName} (new: ${newBlobName}) — ${deleteErr.message}`);
    }

    // Generate SAS tokens for the new blob
    const sasToken = this.generateSASToken(newBlobName);
    const shortLivedSasToken = this.generateShortLivedSASToken(newBlobName, 5);

    return {
      url: `${newBlobClient.url}?${sasToken}`,
      shortLivedUrl: `${newBlobClient.url}?${shortLivedSasToken}`,
      blobName: newBlobName,
    };
  }
}
