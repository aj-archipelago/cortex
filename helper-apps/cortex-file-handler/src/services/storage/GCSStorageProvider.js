import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Storage } from '@google-cloud/storage';
import axios from 'axios';

import { StorageProvider } from './StorageProvider.js';

export class GCSStorageProvider extends StorageProvider {
    constructor(credentials, bucketName) {
        super();
        if (!credentials || !bucketName) {
            throw new Error('Missing GCS credentials or bucket name');
        }
        
        this.bucketName = bucketName;
        this.storage = new Storage({
            projectId: credentials.project_id,
            credentials: credentials
        });
    }

    ensureUnencodedGcsUrl(url) {
        if (!url || !url.startsWith('gs://')) {
            return url;
        }
        // Split into bucket and path parts
        const [bucket, ...pathParts] = url.replace('gs://', '').split('/');
        // Reconstruct URL with decoded path parts
        return `gs://${bucket}/${pathParts.map(part => decodeURIComponent(part)).join('/')}`;
    }

    async uploadFile(context, filePath, requestId, hash = null) {
        const bucket = this.storage.bucket(this.bucketName);
        
        // Use the filename with a UUID as the blob name
        let baseName = typeof filePath === 'string' ? path.basename(filePath) : requestId;
        // Remove any query parameters from the filename
        baseName = baseName.split('?')[0];
        // Only encode if not already encoded
        if (!this.isEncoded(baseName)) {
            baseName = encodeURIComponent(baseName);
        }
        const blobName = `${requestId}/${uuidv4()}_${baseName}`;
        
        if (typeof filePath === 'string') {
            // Use bucket.upload for file-path uploads
            await bucket.upload(filePath, {
                destination: blobName,
                metadata: { contentType: this.getContentType(filePath) },
                resumable: false,
            });
        } else {
            // Handle buffer uploads
            const file = bucket.file(blobName);
            await file.save(filePath, {
                metadata: { contentType: 'application/octet-stream' },
                resumable: false,
            });
        }

        return {
            url: `gs://${this.bucketName}/${blobName}`,
            blobName,
        };
    }

    async deleteFiles(requestId) {
        if (!requestId) throw new Error('Missing requestId parameter');

        try {
            let filesToDelete = [];

            if (process.env.STORAGE_EMULATOR_HOST) {
                // When using the emulator, list objects via raw REST because client lib list may 404
                try {
                    const listResp = await axios.get(
                        `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${this.bucketName}/o`,
                        {
                            params: { prefix: requestId },
                            validateStatus: (s) => s === 200 || s === 404,
                        },
                    );

                    if (listResp.status === 200 && Array.isArray(listResp.data.items)) {
                        filesToDelete = listResp.data.items.map((item) => ({ name: item.name }));
                    } else if (listResp.status === 404) {
                        // Bucket or objects not found; treat as nothing to delete
                        filesToDelete = [];
                    }
                } catch (listErr) {
                    console.error('Error listing objects from emulator:', listErr.message || listErr);
                    // Fallback to empty list to avoid throwing
                    filesToDelete = [];
                }
            } else {
                // Real GCS – use client library
                const bucket = this.storage.bucket(this.bucketName);
                try {
                    const [files] = await bucket.getFiles({ prefix: requestId });
                    filesToDelete = files;
                } catch (libErr) {
                    console.error('Error listing objects from GCS:', libErr.message || libErr);
                    filesToDelete = [];
                }
            }

            const result = [];
            for (const file of filesToDelete) {
                const fileName = file.name || file; // for emulator list we constructed objects with name member
                try {
                    if (process.env.STORAGE_EMULATOR_HOST) {
                        await axios.delete(
                            `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${this.bucketName}/o/${encodeURIComponent(fileName)}`,
                            { validateStatus: (s) => s === 200 || s === 204 || s === 404 },
                        );
                    } else {
                        // file is a File object from @google-cloud/storage
                        if (file.delete) {
                            await file.delete({ ignoreNotFound: true });
                        }
                    }
                    result.push(fileName);
                } catch (error) {
                    const code = error.code || error.response?.status;
                    if (code === 404 || code === 412) {
                        console.warn(`GCS file already missing during delete: ${fileName}`);
                    } else {
                        console.error(`Error deleting GCS file ${fileName}:`, error);
                    }
                }
            }

            return result;
        } catch (error) {
            console.error('Error during GCS deleteFiles:', error);
            return [];
        }
    }

    async fileExists(url) {
        try {
            if (!url || !url.startsWith('gs://')) {
                return false;
            }

            const unencodedUrl = this.ensureUnencodedGcsUrl(url);
            const urlParts = unencodedUrl.replace('gs://', '').split('/');
            const bucketName = urlParts[0];
            const fileName = urlParts.slice(1).join('/');

            if (process.env.STORAGE_EMULATOR_HOST) {
                try {
                    const response = await axios.get(
                        `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${bucketName}/o/${encodeURIComponent(fileName)}`,
                        { validateStatus: (status) => status === 200 || status === 404 }
                    );
                    return response.status === 200;
                } catch (error) {
                    console.error('Error checking emulator file:', error);
                    return false;
                }
            }

            const bucket = this.storage.bucket(bucketName);
            const file = bucket.file(fileName);
            const [exists] = await file.exists();
            return exists;
        } catch (error) {
            console.error('Error checking if GCS URL exists:', error);
            return false;
        }
    }

    async downloadFile(url, destinationPath) {
        if (!url || !url.startsWith('gs://')) {
            throw new Error('Invalid GCS URL');
        }

        const urlParts = url.replace('gs://', '').split('/');
        const bucketName = urlParts[0];
        const fileName = urlParts.slice(1).join('/');

        if (process.env.STORAGE_EMULATOR_HOST) {
            // Use axios to download from emulator
            const response = await axios({
                method: 'GET',
                url: `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${bucketName}/o/${encodeURIComponent(fileName)}?alt=media`,
                responseType: 'stream'
            });
            
            // Write the response to file
            const writer = fs.createWriteStream(destinationPath);
            return new Promise((resolve, reject) => {
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.on('error', reject);
            });
        } else {
            // Use GCS client for real GCS
            const bucket = this.storage.bucket(bucketName);
            const file = bucket.file(fileName);
            await file.download({ destination: destinationPath });
        }
    }

    async cleanup(urls) {
        if (!urls || !urls.length) return;
        
        const bucket = this.storage.bucket(this.bucketName);
        const result = [];
        
        for (const url of urls) {
            try {
                if (!url.startsWith('gs://')) continue;
                
                const urlParts = url.replace('gs://', '').split('/');
                const bucketName = urlParts[0];
                const fileName = urlParts.slice(1).join('/');
                
                if (bucketName === this.bucketName) {
                    const file = bucket.file(fileName);
                    await file.delete();
                    result.push(fileName);
                }
            } catch (error) {
                console.error(`Error cleaning up GCS file ${url}:`, error);
            }
        }
        
        return result;
    }

    isEncoded(str) {
        return /%[0-9A-Fa-f]{2}/.test(str);
    }

    getContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.txt': 'text/plain',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.mp4': 'video/mp4',
            '.mp3': 'audio/mpeg'
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }
} 