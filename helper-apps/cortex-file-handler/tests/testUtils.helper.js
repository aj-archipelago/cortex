import axios from 'axios';

export async function cleanupHashAndFile(hash, uploadedUrl, baseUrl) {
    if (uploadedUrl) {
        try {
            const fileUrl = new URL(uploadedUrl);
            // Get the full path after the domain
            const pathParts = fileUrl.pathname.split('/').filter(Boolean);
            // The last part should be the filename
            const filename = pathParts[pathParts.length - 1];
            // Extract the identifier (first part before underscore)
            const fileIdentifier = filename.split('_')[0];
            
            console.log('Cleaning up file:', {
                url: uploadedUrl,
                identifier: fileIdentifier
            });
            
            const deleteUrl = `${baseUrl}?operation=delete&requestId=${fileIdentifier}`;
            const deleteResponse = await axios.delete(deleteUrl, { 
                validateStatus: () => true,
                timeout: 5000 // Add timeout
            });
            
            if (deleteResponse.status !== 200) {
                console.error('Failed to delete file:', {
                    status: deleteResponse.status,
                    data: deleteResponse.data,
                    url: deleteUrl
                });
            }
        } catch (e) {
            console.error('Error during file cleanup:', {
                error: e.message,
                url: uploadedUrl
            });
        }
    }
    
    if (hash) {
        try {
            console.log('Cleaning up hash:', hash);
            const clearResponse = await axios.get(baseUrl, {
                params: { hash, clearHash: true },
                validateStatus: () => true,
                timeout: 5000 // Add timeout
            });
            
            if (clearResponse.status !== 200) {
                console.error('Failed to clear hash:', {
                    status: clearResponse.status,
                    data: clearResponse.data,
                    hash
                });
            }
        } catch (e) {
            console.error('Error during hash cleanup:', {
                error: e.message,
                hash
            });
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