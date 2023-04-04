const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

async function saveFileToBlob(chunkPath) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Use the filename with a UUID as the blob name
    const blobName = `${uuidv4()}_${path.basename(chunkPath)}`;

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

module.exports = {
    saveFileToBlob
}