import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import fs from "fs";
import path from "path";

import { StorageProvider } from "./StorageProvider.js";
import {
  generateShortId,
  generateBlobName,
} from "../../utils/filenameUtils.js";

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
      accountName = "devstoreaccount1";
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

    // Create a read stream for the file
    const fileStream = fs.createReadStream(filePath);

    // Upload the file to Azure Blob Storage using the stream
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadStream(fileStream);

    // Generate SAS token after successful upload
    const sasToken = this.generateSASToken(containerClient, blobName);

    return {
      url: `${blockBlobClient.url}?${sasToken}`,
      blobName: blobName,
    };
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
