import axios from 'axios';

export async function cleanupHashAndFile(hash, uploadedUrl, baseUrl) {
    if (uploadedUrl) {
        try {
            const fileUrl = new URL(uploadedUrl);
            const fileIdentifier = fileUrl.pathname.split('/').pop().split('_')[0];
            const deleteUrl = `${baseUrl}?operation=delete&requestId=${fileIdentifier}`;
            await axios.delete(deleteUrl, { validateStatus: () => true });
        } catch (e) {
            // ignore
        }
    }
    await axios.get(baseUrl, {
        params: { hash, clearHash: true },
        validateStatus: (status) => true,
    });
    await axios.get(baseUrl, {
        params: { hash: `${hash}_converted`, clearHash: true },
        validateStatus: (status) => true,
    });
}

export function getFolderNameFromUrl(url) {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/');
    if (url.includes('127.0.0.1:10000')) {
        return parts[3].split('_')[0];
    }
    return parts[2].split('_')[0];
} 