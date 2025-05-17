import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
    generateBlobSASQueryParameters,
    StorageSharedKeyCredential,
    BlobServiceClient,
} from '@azure/storage-blob';

import { StorageProvider } from './StorageProvider.js';

export class AzureStorageProvider extends StorageProvider {
    constructor(connectionString, containerName) {
        super();
        if (!connectionString || !containerName) {
            throw new Error('Missing Azure Storage connection string or container name');
        }
        this.connectionString = connectionString;
        this.containerName = containerName;
        this.sasTokenLifeDays = process.env.SAS_TOKEN_LIFE_DAYS || 30;
    }

    async getBlobClient() {
        const blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
        
        // Ensure service version is set
        const serviceProperties = await blobServiceClient.getProperties();
        if (!serviceProperties.defaultServiceVersion) {
            serviceProperties.defaultServiceVersion = '2020-02-10';
            await blobServiceClient.setProperties(serviceProperties);
        }

        const containerClient = blobServiceClient.getContainerClient(this.containerName);
        return { blobServiceClient, containerClient };
    }

    generateSASToken(containerClient, blobName) {
        const { accountName, accountKey } = containerClient.credential;
        const sharedKeyCredential = new StorageSharedKeyCredential(
            accountName,
            accountKey,
        );

        const sasOptions = {
            containerName: containerClient.containerName,
            blobName: blobName,
            permissions: 'r',
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + this.sasTokenLifeDays * 24 * 60 * 60 * 1000),
        };

        return generateBlobSASQueryParameters(sasOptions, sharedKeyCredential).toString();
    }

    async uploadFile(context, filePath, requestId, hash = null) {
        const { containerClient } = await this.getBlobClient();
        
        // Use the filename with a UUID as the blob name
        let baseName = path.basename(filePath);
        // Remove any query parameters from the filename
        baseName = baseName.split('?')[0];
        // Only encode if not already encoded
        if (!this.isEncoded(baseName)) {
            baseName = encodeURIComponent(baseName);
        }
        const blobName = `${requestId}/${uuidv4()}_${baseName}`;
        
        // Create a read stream for the file
        const fileStream = fs.createReadStream(filePath);

        // Upload the file to Azure Blob Storage using the stream
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadStream(fileStream);

        // Generate SAS token after successful upload
        const sasToken = this.generateSASToken(containerClient, blobName);
        
        return {
            url: `${blockBlobClient.url}?${sasToken}`,
            blobName: blobName
        };
    }

    async deleteFiles(requestId) {
        if (!requestId) throw new Error('Missing requestId parameter');
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
                        console.warn(`Azure blob already missing during delete: ${blob.name}`);
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
            const headResp = await fetch(url, { method: 'HEAD' });
            if (headResp.ok) return true;

            // Some emulators (e.g. Azurite) may not properly support HEAD with SAS.
            // Fall back to a ranged GET of a single byte.
            const getResp = await fetch(url, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
            });
            return getResp.ok || getResp.status === 206; // 206 Partial Content
        } catch (error) {
            console.error('Error checking if file exists:', error);
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
            const pathParts = urlObj.pathname.split('/');
            const containerIndex = pathParts.indexOf(this.containerName);
            if (containerIndex === -1) return null;
            
            return pathParts.slice(containerIndex + 1).join('/');
        } catch (error) {
            console.error('Error extracting blob name from URL:', error);
            return null;
        }
    }
} 