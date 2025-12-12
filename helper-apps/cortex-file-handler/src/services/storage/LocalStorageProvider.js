import fs from "fs";
import path from "path";
import { promisify } from "util";
import { pipeline as _pipeline } from "stream";
import { generateShortId, sanitizeFilename } from "../../utils/filenameUtils.js";
import { ipAddress, port } from "../../start.js";

import { StorageProvider } from "./StorageProvider.js";

const pipeline = promisify(_pipeline);

export class LocalStorageProvider extends StorageProvider {
  constructor(publicFolder) {
    super();
    if (!publicFolder) {
      throw new Error("Missing public folder path");
    }
    this.publicFolder = publicFolder;
    this.ensurePublicFolder();
  }

  ensurePublicFolder() {
    if (!fs.existsSync(this.publicFolder)) {
      fs.mkdirSync(this.publicFolder, { recursive: true });
    }
  }

  async uploadFile(context, filePath, requestId, hash = null, filename = null) {
    // Create request folder if it doesn't exist
    const requestFolder = path.join(this.publicFolder, requestId);
    if (!fs.existsSync(requestFolder)) {
      fs.mkdirSync(requestFolder, { recursive: true });
    }

    // Use provided filename or generate LLM-friendly naming
    let uniqueFileName;
    if (filename) {
      uniqueFileName = filename;
    } else {
      const fileExtension = path.extname(filePath);
      const shortId = generateShortId();
      uniqueFileName = `${shortId}${fileExtension}`;
    }

    const destinationPath = path.join(requestFolder, uniqueFileName);

    // Copy file to public folder
    await fs.promises.copyFile(filePath, destinationPath);

    // Generate full URL
    const url = `http://${ipAddress}:${port}/files/${requestId}/${uniqueFileName}`;

    return {
      url,
      shortLivedUrl: url, // For local storage, shortLivedUrl is the same as url
      blobName: path.join(requestId, uniqueFileName),
    };
  }

  async uploadStream(context, encodedFilename, stream) {
    // For local storage, we need a requestId to create a folder
    // Extract from context or generate one
    const requestId = context.requestId || "default";
    
    // Create request folder if it doesn't exist
    const requestFolder = path.join(this.publicFolder, requestId);
    if (!fs.existsSync(requestFolder)) {
      fs.mkdirSync(requestFolder, { recursive: true });
    }

    const sanitizedFilename = sanitizeFilename(encodedFilename);
    const destinationPath = path.join(requestFolder, sanitizedFilename);
    const writeStream = fs.createWriteStream(destinationPath);

    await pipeline(stream, writeStream);

    // Generate full URL
    const url = `http://${ipAddress}:${port}/files/${requestId}/${sanitizedFilename}`;

    // Return object with url and shortLivedUrl for consistency
    return {
      url,
      shortLivedUrl: url // For local storage, shortLivedUrl is the same as url
    };
  }

  async deleteFiles(requestId) {
    if (!requestId) throw new Error("Missing requestId parameter");

    const requestFolder = path.join(this.publicFolder, requestId);
    const result = [];

    if (fs.existsSync(requestFolder)) {
      const files = await fs.promises.readdir(requestFolder);
      for (const file of files) {
        const filePath = path.join(requestFolder, file);
        await fs.promises.unlink(filePath);
        // Return the full path relative to the public folder
        result.push(path.join(requestId, file));
      }
      await fs.promises.rmdir(requestFolder);
    }

    return result;
  }

  async deleteFile(url) {
    if (!url) throw new Error("Missing URL parameter");

    const filePath = this.urlToFilePath(url);
    if (!filePath) {
      throw new Error("Invalid URL");
    }

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      // Try to remove the parent directory if it's empty
      const parentDir = path.dirname(filePath);
      try {
        await fs.promises.rmdir(parentDir);
      } catch (error) {
        // Ignore error if directory is not empty
      }
      return path.relative(this.publicFolder, filePath);
    }

    return null;
  }

  async fileExists(url) {
    try {
      if (!url) {
        return false;
      }

      const filePath = this.urlToFilePath(url);
      if (!filePath) {
        return false;
      }

      // Check if file exists and is accessible
      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        return true;
      } catch (error) {
        return false;
      }
    } catch (error) {
      console.error("Error checking if file exists:", error);
      return false;
    }
  }

  async downloadFile(url, destinationPath) {
    const sourcePath = this.urlToFilePath(url);
    if (!fs.existsSync(sourcePath)) {
      throw new Error("File not found");
    }
    await fs.promises.copyFile(sourcePath, destinationPath);
  }

  async cleanup(urls) {
    if (!urls || !urls.length) return;

    const result = [];
    for (const url of urls) {
      try {
        const filePath = this.urlToFilePath(url);
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
          result.push(path.relative(this.publicFolder, filePath));
        }
      } catch (error) {
        console.error(`Error cleaning up file ${url}:`, error);
      }
    }

    return result;
  }

  isEncoded(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
  }

  urlToFilePath(url) {
    try {
      // If it's a full URL, extract the pathname
      let urlPath = url;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const urlObj = new URL(url);
        urlPath = urlObj.pathname;
      }

      // Remove leading slash if present
      if (urlPath.startsWith("/")) {
        urlPath = urlPath.substring(1);
      }

      // Split into parts and decode each part
      const parts = urlPath.split("/");
      const decodedParts = parts.map((part) => decodeURIComponent(part));

      // If the URL path starts with 'files', remove that segment because
      // our publicFolder already represents the root of '/files'.
      if (decodedParts.length && decodedParts[0] === "files") {
        decodedParts.shift();
      }

      // Join with the public folder path
      return path.join(this.publicFolder, ...decodedParts);
    } catch (error) {
      console.error("Error converting URL to file path:", error);
      return null;
    }
  }
}
