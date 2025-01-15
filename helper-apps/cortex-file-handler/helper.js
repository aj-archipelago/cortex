import fs from 'fs';
import { ACCEPTED_MIME_TYPES } from './constants.js';
import path from 'path';

export async function deleteTempPath(path) {
    try {
        if (!path) {
            console.log('Temporary path is not defined.');
            return;
        }
        if (!fs.existsSync(path)) {
            console.log(`Temporary path ${path} does not exist.`);
            return;
        }
        const stats = fs.statSync(path);
        if (stats.isFile()) {
            fs.unlinkSync(path);
            console.log(`Temporary file ${path} deleted successfully.`);
        } else if (stats.isDirectory()) {
            fs.rmSync(path, { recursive: true });
            console.log(`Temporary folder ${path} and its contents deleted successfully.`);
        }
    } catch (err) {
        console.error('Error occurred while deleting the temporary path:', err);
    }
}

// Get the first extension for a given mime type
export function getExtensionForMimeType(mimeType) {
    if (!mimeType) return '';
    const cleanMimeType = mimeType.split(';')[0].trim();
    const extensions = ACCEPTED_MIME_TYPES[cleanMimeType];
    return extensions ? extensions[0] : '';
}

// Ensure a filename has the correct extension based on its mime type
export function ensureFileExtension(filename, mimeType) {
    if (!mimeType) return filename;
    
    const extension = getExtensionForMimeType(mimeType);
    if (!extension) return filename;

    // If filename already has this extension, return as is
    if (filename.toLowerCase().endsWith(extension)) {
        return filename;
    }

    // Get the current extension if any
    const currentExt = path.extname(filename);
    
    // If there's no current extension, just append the new one
    if (!currentExt) {
        return `${filename}${extension}`;
    }
    
    // Replace the current extension with the new one
    return filename.slice(0, -currentExt.length) + extension;
}

export function ensureEncoded(url) {
    try {
        return decodeURIComponent(url) !== url ? url : encodeURI(url);
    } catch (error) {
        console.error('Error encoding URL:', error);
        return url;
    }
}
