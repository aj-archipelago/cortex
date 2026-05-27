import { createReadStream } from "fs";
import path from "path";
import mime from "mime-types";

import { ConversionService } from "./ConversionService.js";
import { getFileStoreMap, setFileStoreMap } from "../redis.js";
import { urlExists } from "../helper.js";
import { gcsUrlExists, uploadChunkToGCS, gcs } from "../blobHandler.js";
import { downloadFile } from "../fileChunker.js";
import { StorageFactory } from "./storage/StorageFactory.js";
import { moveFileToPublicFolder } from "../localFileHandler.js";
import { v4 as uuidv4 } from "uuid";

export class FileConversionService extends ConversionService {
  constructor(context, useAzure = true) {
    super(context);
    this.useAzure = useAzure;
    this.storageFactory = StorageFactory.getInstance();
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

  async _saveConvertedFile(filePath, requestId, filename = null, folderPath = null) {
    // Generate a fallback requestId if none supplied (e.g. during checkHash calls)
    const reqId = requestId || uuidv4();

    let fileUrl;
    if (this.useAzure) {
      const provider = await this.storageFactory.getAzureProvider();
      if (folderPath) {
        // Use uploadStream which supports folderPath to store converted file
        // next to the original in the user's folder
        const uploadName = filename || path.basename(filePath);
        const stream = createReadStream(filePath);
        const contentType = mime.lookup(uploadName) || null;
        const result = await provider.uploadStream({}, uploadName, stream, contentType, folderPath);
        fileUrl = result.url;
      } else {
        // Container parameter is ignored - always uses default container from env var
        const result = await provider.uploadFile({}, filePath, reqId, null, filename);
        fileUrl = result.url;
      }
    } else {
      fileUrl = await moveFileToPublicFolder(filePath, reqId);
    }
    return { url: fileUrl };
  }

  async _uploadChunkToGCS(filePath, requestId, filename = null, folderPath = null) {
    return uploadChunkToGCS(filePath, requestId, filename, folderPath);
  }

  _isGCSConfigured() {
    return !!gcs;
  }
}
