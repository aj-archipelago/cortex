import fs from 'fs';
import path from 'path';
import { BlobServiceClient } from '@azure/storage-blob';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';
import { PassThrough } from 'stream';
import { pipeline as _pipeline } from 'stream';
import { promisify } from 'util';
const pipeline = promisify(_pipeline);
import { join } from 'path';


import { publicFolder, port, ipAddress } from "./start.js";

const getBlobClient = () => {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
    if (!connectionString || !containerName) {
        throw new Error('Missing Azure Storage connection string or container name environment variable');
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    return { blobServiceClient, containerClient };
}

async function saveFileToBlob(chunkPath, requestId) {
    const { containerClient } = getBlobClient();
    // Use the filename with a UUID as the blob name
    const blobName = `${requestId}/${uuidv4()}_${path.basename(chunkPath)}`;

    // Create a read stream for the chunk file
    const fileStream = fs.createReadStream(chunkPath);

    // Upload the chunk to Azure Blob Storage using the stream
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadStream(fileStream);

    // Return the full URI of the uploaded blob
    const blobUrl = blockBlobClient.url;
    return blobUrl;
}

//deletes blob that has the requestId
async function deleteBlob(requestId) {
    if (!requestId) throw new Error('Missing requestId parameter');
    const { containerClient } = getBlobClient();
    // List the blobs in the container with the specified prefix
    const blobs = containerClient.listBlobsFlat({ prefix: `${requestId}/` });

    const result = []
    // Iterate through the blobs
    for await (const blob of blobs) {
        // Delete the matching blob
        const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
        await blockBlobClient.delete();
        console.log(`Cleaned blob: ${blob.name}`);
        result.push(blob.name);
    }

    return result
}

async function uploadBlob(context, req, saveToLocal = false) {
    return new Promise((resolve, reject) => {
        try {
            const busboy = Busboy({ headers: req.headers });
            let requestId = uuidv4();

            busboy.on('field', (fieldname, value) => {
                if (fieldname === 'requestId') {
                    requestId = value;
                }
            });

            busboy.on('file', async (fieldname, file, info) => {
                if (saveToLocal) {
                    // Create the target folder if it doesn't exist
                    const localPath = join(publicFolder, requestId);
                    fs.mkdirSync(localPath, { recursive: true });

                    const filename = `${uuidv4()}_${info.filename}`;
                    const destinationPath = `${localPath}/${filename}`;

                    await pipeline(file, fs.createWriteStream(destinationPath));

                    const message = `File '${filename}' saved to folder successfully.`;
                    context.log(message);

                    const url = `http://${ipAddress}:${port}/files/${requestId}/${filename}`;

                    const body = { message, url };

                    context.res = {
                        status: 200,
                        body,
                    };


                    resolve(body); // Resolve the promise
                } else {
                    const { containerClient } = getBlobClient();
                    const filename = `${requestId}/${uuidv4()}_${info.filename}`;

                    const blockBlobClient = containerClient.getBlockBlobClient(filename);

                    const passThroughStream = new PassThrough();
                    file.pipe(passThroughStream);

                    await blockBlobClient.uploadStream(passThroughStream);

                    const message = `File '${filename}' uploaded successfully.`;
                    const url = blockBlobClient.url;
                    context.log(message);
                    const body = { message, url };

                    context.res = {
                        status: 200,
                        body,
                    };

                    resolve(body); // Resolve the promise
                }
            });

            busboy.on('error', (error) => {
                context.log.error('Error processing file upload:', error);
                context.res = {
                    status: 500,
                    body: 'Error processing file upload.',
                };
                reject(error); // Reject the promise
            });

            req.pipe(busboy);
        } catch (error) {
            context.log.error('Error processing file upload:', error);
            context.res = {
                status: 500,
                body: 'Error processing file upload.',
            };
            reject(error); // Reject the promise
        }
    });
}

export {
    saveFileToBlob, deleteBlob, uploadBlob
}