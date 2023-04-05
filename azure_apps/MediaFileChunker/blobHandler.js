const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');


const getBlobClient = () => {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
    if (!connectionString || !containerName) {
        throw new Error('Missing Azure Storage connection string or container name environment variable');
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_STORAGE_CONTAINER_NAME);

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

    // return blobName;
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

module.exports = {
    saveFileToBlob, deleteBlob
}