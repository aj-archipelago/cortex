import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { publicFolder, port, ipAddress } from "./start.js";


async function moveFileToPublicFolder(chunkPath, requestId) {
    // Use the filename with a UUID as the blob name
    const filename = `${requestId}/${uuidv4()}_${basename(chunkPath)}`;

    // Create the target folder if it doesn't exist
    const targetFolder = join(publicFolder, requestId);
    await fs.mkdir(targetFolder, { recursive: true });

    // Move the file to the target folder
    const targetPath = join(targetFolder, basename(filename));
    await fs.rename(chunkPath, targetPath);

    // Return the complete URL of the file
    const fileUrl = `http://${ipAddress}:${port}/files/${filename}`;
    // const fileUrl = `http://localhost:${port}/files/${filename}`;
    return fileUrl;
}

async function deleteFolder(requestId) {
    if (!requestId) throw new Error('Missing requestId parameter');
    const targetFolder = join(publicFolder, requestId);
    await fs.rm(targetFolder, { recursive: true });
    console.log(`Cleaned folder: ${targetFolder}`);
}


export {
    moveFileToPublicFolder, deleteFolder
};