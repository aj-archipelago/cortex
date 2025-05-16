import { ConversionService } from './ConversionService.js';
import { getFileStoreMap, setFileStoreMap } from '../redis.js';
import { urlExists } from '../helper.js';
import { gcsUrlExists, uploadChunkToGCS, gcs } from '../blobHandler.js';
import { downloadFile } from '../fileChunker.js';
import { saveFileToBlob } from '../blobHandler.js';
import { moveFileToPublicFolder } from '../localFileHandler.js';

export class FileConversionService extends ConversionService {
    constructor(context, useAzure = true) {
        super(context);
        this.useAzure = useAzure;
    }

    async _getFileStoreMap(key) {
        return getFileStoreMap(key);
    }

    async _setFileStoreMap(key, value) {
        return setFileStoreMap(key, value);
    }

    async _urlExists(url) {
        return urlExists(url);
    }

    async _gcsUrlExists(url) {
        return gcsUrlExists(url);
    }

    async _downloadFile(url, destination) {
        return downloadFile(url, destination);
    }

    async _saveConvertedFile(filePath, requestId) {
        let fileUrl;    
        if (this.useAzure) {
            const savedBlob = await saveFileToBlob(filePath, requestId);
            fileUrl = savedBlob.url;
        } else {
            fileUrl = await moveFileToPublicFolder(filePath, requestId);
        }
        return { url: fileUrl };
    }

    async _uploadChunkToGCS(filePath, requestId) {
        return uploadChunkToGCS(filePath, requestId);
    }

    _isGCSConfigured() {
        return !!gcs;
    }
} 