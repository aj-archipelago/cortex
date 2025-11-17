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
  }

  async getBlobClient() {
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
    return { blobServiceClient, containerClient };
  }

  generateSASToken(containerClient, blobName, options = {}) {
    // Handle Azurite (development storage) credentials
    let accountName, accountKey;
    
    // Note: Debug logging removed for production
    
    if (containerClient.credential && containerClient.credential.accountName) {
      // Regular Azure Storage credentials
      accountName = containerClient.credential.accountName;
      
      // Handle Buffer case (Azurite) vs string case (real Azure)
      if (Buffer.isBuffer(containerClient.credential.accountKey)) {
        accountKey = containerClient.credential.accountKey.toString('base64');
      } else {
        accountKey = containerClient.credential.accountKey;
      }
    } else {
      // Azurite development storage fallback
      accountName = AZURITE_ACCOUNT_NAME;
      accountKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
    }
    
    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

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
      containerName: containerClient.containerName,
      blobName: blobName,
      permissions: options.permissions || "r",
      startsOn: new Date(),
      expiresOn: expirationTime,
    };

    return generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();
  }

  generateShortLivedSASToken(containerClient, blobName, minutes = 5) {
    return this.generateSASToken(containerClient, blobName, { minutes });
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

    const url = `${blockBlobClient.url}?${sasToken}`;
    
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
      blobName: blobName,
    };
  }

  async uploadStream(context, encodedFilename, stream, providedContentType = null) {
    const { containerClient } = await this.getBlobClient();
    let contentType = providedContentType || mime.lookup(encodedFilename);

    // For text MIME types, ensure charset=utf-8 is included if not already present
    if (contentType && this.isTextMimeType(contentType)) {
      if (!contentType.includes('charset=')) {
        contentType = `${contentType}; charset=utf-8`;
      }
    }

    // Normalize the blob name: sanitizeFilename decodes, cleans, then we encode for Azure
    let blobName = sanitizeFilename(encodedFilename);
    blobName = encodeURIComponent(blobName);

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

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    if (context.log) {
      context.log(`Uploading to Azure... ${blobName}`);
      context.log(`Setting content-type: ${contentType}`);
    }
    
    await blockBlobClient.uploadStream(stream, undefined, undefined, options);
    
    const sasToken = this.generateSASToken(containerClient, blobName);
    
    const url = `${blockBlobClient.url}?${sasToken}`;
    
    // Validate that the URL contains a blob name (not just container)
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
    if (pathParts.length <= 1) {
      throw new Error(`Generated invalid Azure URL (container-only) from uploadStream: ${url}, blobName: ${blobName}`);
    }
    
    return url;
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
      
      // Extract blob name from URL
      const urlObj = new URL(url);
      let blobName = urlObj.pathname.substring(1); // Remove leading slash
      
      // Handle different URL formats:
      // 1. Azurite: /devstoreaccount1/container/blobname (3 segments)
      // 2. Standard Azure: /container/blobname (2 segments)
      // 3. Container-only: /container or /container/ (invalid)
      
      if (blobName.includes('/')) {
        const pathSegments = blobName.split('/').filter(segment => segment.length > 0);
        
        if (pathSegments.length === 1) {
          // Only container name, no blob name - this is invalid
          console.warn(`Invalid blob URL (container-only): ${url}`);
          return null;
        } else if (pathSegments.length === 2) {
          // Standard Azure format: container/blobname
          // Check if first segment matches container name
          if (pathSegments[0] === this.containerName) {
            blobName = pathSegments[1];
          } else {
            // Container name doesn't match, but assume second segment is blob name
            blobName = pathSegments[1];
          }
        } else if (pathSegments.length >= 3) {
          // Azurite format: devstoreaccount1/container/blobname
          // Skip the account and container segments to get the actual blob name
          // Check if second segment matches container name
          if (pathSegments[1] === this.containerName) {
            blobName = pathSegments.slice(2).join('/');
          } else {
            // Container name doesn't match, but assume remaining segments are blob name
            blobName = pathSegments.slice(2).join('/');
          }
        }
      } else {
        // No slashes - could be just container name or just blob name
        if (blobName === this.containerName || blobName === this.containerName + '/') {
          // URL is just the container name - invalid blob URL
          console.warn(`Invalid blob URL (container-only): ${url}`);
          return null;
        }
        // Otherwise assume it's a blob name at root level (unlikely but possible)
      }
      
      // Validate that we have a non-empty blob name
      if (!blobName || blobName.trim().length === 0) {
        console.warn(`Invalid blob URL (empty blob name): ${url}`);
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
      const pathParts = urlObj.pathname.split("/");
      const containerIndex = pathParts.indexOf(this.containerName);
      if (containerIndex === -1) return null;

      return pathParts.slice(containerIndex + 1).join("/");
    } catch (error) {
      console.error("Error extracting blob name from URL:", error);
      return null;
    }
  }
}
