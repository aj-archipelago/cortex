import fs from 'fs';

function isValidYoutubeUrl(url) {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
    return regex.test(url);
}

async function deleteTempPath(path) {
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

function ensureEncoded(url) {
    try {
        const decodedUrl = decodeURI(url);
        if (decodedUrl === url) {
            return encodeURI(url);
        }
        return url;
    } catch (e) {
        return url;
    }
}

export {
    isValidYoutubeUrl, deleteTempPath, ensureEncoded
}