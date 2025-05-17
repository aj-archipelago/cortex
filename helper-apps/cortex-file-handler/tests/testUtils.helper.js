import axios from 'axios';

export async function cleanupHashAndFile(hash, uploadedUrl, baseUrl) {
    console.log(`[cleanupHashAndFile] Starting cleanup for hash: ${hash}, url: ${uploadedUrl}, baseUrl: ${baseUrl}`);
    
    // Only perform hash operations if hash is provided
    if (hash) {
        try {
            console.log(`[cleanupHashAndFile] Attempting to clear hash: ${hash}`);
            const clearResponse = await axios.get(
                `${baseUrl}?hash=${hash}&clearHash=true`,
                {
                    validateStatus: (status) => true,
                    timeout: 5000,
                },
            );
            console.log(`[cleanupHashAndFile] Clear hash response status: ${clearResponse.status}`);
            console.log(`[cleanupHashAndFile] Clear hash response: ${clearResponse.data}`);
        } catch (error) {
            console.error(`[cleanupHashAndFile] Error clearing hash: ${error.message}`);
        }
    }

    // Then delete the file
    try {
        const folderName = getFolderNameFromUrl(uploadedUrl);
        console.log(`[cleanupHashAndFile] Attempting to delete file with folder: ${folderName}`);
        const deleteResponse = await axios.delete(
            `${baseUrl}?operation=delete&requestId=${folderName}`,
            {
                validateStatus: (status) => true,
                timeout: 5000,
            },
        );
        console.log(`[cleanupHashAndFile] Delete file response status: ${deleteResponse.status}`);
        console.log(`[cleanupHashAndFile] Delete file response: ${JSON.stringify(deleteResponse.data)}`);
    } catch (error) {
        console.error(`[cleanupHashAndFile] Error deleting file: ${error.message}`);
    }

    // Only verify hash if hash was provided
    if (hash) {
        try {
            console.log(`[cleanupHashAndFile] Verifying hash is gone: ${hash}`);
            const verifyResponse = await axios.get(
                `${baseUrl}?hash=${hash}&checkHash=true`,
                {
                    validateStatus: (status) => true,
                    timeout: 5000,
                },
            );
            console.log(`[cleanupHashAndFile] Verify hash response status: ${verifyResponse.status}`);
            console.log(`[cleanupHashAndFile] Verify hash response: ${verifyResponse.data}`);
        } catch (error) {
            console.error(`[cleanupHashAndFile] Error verifying hash: ${error.message}`);
        }
    }
}

export function getFolderNameFromUrl(url) {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (url.includes('127.0.0.1:10000')) {
        return parts[2].split('_')[0];
    }
    return parts[1].split('_')[0];
} 