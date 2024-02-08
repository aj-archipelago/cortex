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

async function cleanupLocal() {
  try {
    // Read the directory
    const items = await fs.readdir(publicFolder);

    // Calculate the date that is x months ago
    const monthsAgo = new Date();
    monthsAgo.setMonth(monthsAgo.getMonth() - 1);

    // Iterate through the items
    for (const item of items) {
      const itemPath = join(publicFolder, item);

      // Get the stats of the item
      const stats = await fs.stat(itemPath);

      // Check if the item is a file or a directory
      const isDirectory = stats.isDirectory();

      // Compare the last modified date with three months ago
      if (stats.mtime < monthsAgo) {
        if (isDirectory) {
          // If it's a directory, delete it recursively
          await fs.rm(itemPath, { recursive: true });
          console.log(`Cleaned directory: ${item}`);
        } else {
          // If it's a file, delete it
          await fs.unlink(itemPath);
          console.log(`Cleaned file: ${item}`);
        }
      }
    }
  } catch (error) {
    console.error(`Error cleaning up files: ${error}`);
  }
}


export {
    moveFileToPublicFolder, deleteFolder, cleanupLocal
};