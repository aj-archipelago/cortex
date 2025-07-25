import fs from "fs/promises";
import os from "os";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import axios from "axios";
import XLSX from "xlsx";
import { CONVERTED_EXTENSIONS } from "../constants.js";
import { v4 as uuidv4 } from "uuid";
import { sanitizeFilename, generateShortId } from "../utils/filenameUtils.js";

const MARKITDOWN_CONVERT_URL = process.env.MARKITDOWN_CONVERT_URL;

if (!MARKITDOWN_CONVERT_URL) {
  throw new Error("MARKITDOWN_CONVERT_URL is not set");
}

export class ConversionService {
  constructor(context) {
    this.context = context;
  }

  /**
   * Determines if a file needs conversion based on its extension
   * @param {string} filename - The name of the file to check
   * @returns {boolean} - Whether the file needs conversion
   */
  needsConversion(filename) {
    // Accept either a full filename/path or a raw extension (e.g. ".docx")
    const input = filename.toLowerCase();

    // If the input looks like an extension already, check directly
    if (
      input.startsWith(".") &&
      !input.includes("/") &&
      !input.includes("\\")
    ) {
      return CONVERTED_EXTENSIONS.includes(input);
    }

    // Otherwise, extract the extension from the filename/path
    const ext = path.extname(input).toLowerCase();
    return CONVERTED_EXTENSIONS.includes(ext);
  }

  /**
   * Converts a file to its appropriate format
   * @param {string} filePath - Path to the file to convert
   * @param {string} originalUrl - Original URL of the file (required for document conversion)
   * @param {boolean} forceConversion - If true, bypasses extension check and forces document conversion
   * @returns {Promise<{convertedPath: string, convertedName: string, converted: boolean}>}
   */
  async convertFile(filePath, originalUrl = null, forceConversion = false) {
    this.context.log("Converting file:", {
      filePath,
      originalUrl,
      forceConversion,
    });

    // Clean the file path by removing any query parameters
    const cleanFilePath = sanitizeFilename(filePath.split("?")[0]);
    const ext = path.extname(cleanFilePath).toLowerCase();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "convert-"));

    try {
      // If forceConversion is true, directly handle as document conversion
      if (forceConversion) {
        return await this._handleDocumentConversion(
          filePath,
          originalUrl,
          tempDir,
        );
      }

      // Handle Excel files
      if (ext === ".xlsx" || ext === ".xls") {
        return await this._handleExcelConversion(filePath, tempDir);
      }

      // Handle documents that need markdown conversion
      if ([".docx", ".doc", ".ppt", ".pptx"].includes(ext)) {
        return await this._handleDocumentConversion(
          filePath,
          originalUrl,
          tempDir,
        );
      }

      this.context.log("No conversion needed for this file type");
      return { converted: false };
    } catch (error) {
      this.context.log("Error in convertFile:", error);
      // Clean up temp directory on error
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Ensures a file has both original and converted versions
   * @param {Object} fileInfo - Information about the file
   * @param {string} requestId - Request ID for storage
   * @returns {Promise<Object>} - Updated file info with conversion if needed
   */
  async ensureConvertedVersion(fileInfo, requestId) {
    const { url, gcs } = fileInfo;
    // Remove any query parameters before extension check
    const extension = path.extname(url.split("?")[0]).toLowerCase();

    // If file doesn't need conversion, return original info
    if (!this.needsConversion(extension)) {
      return fileInfo;
    }

    // Work with any converted info already stored inside the main hash element
    const convertedInfo = fileInfo.converted;

    let needsConversion = false;
    if (convertedInfo) {
      // Verify both primary and GCS URLs exist
      const primaryExists = await this._urlExists(convertedInfo?.url);
      const gcsExists = this._isGCSConfigured()
        ? await this._gcsUrlExists(convertedInfo?.gcs)
        : false;

      // If both URLs exist, return the info
      if (primaryExists.valid && (!this._isGCSConfigured() || gcsExists)) {
        return { ...fileInfo, converted: convertedInfo };
      }

      // If either URL is missing, we need to convert
      needsConversion = true;
      this.context.log("Conversion needed - missing URLs:", {
        primaryExists: primaryExists.valid,
        gcsExists,
        convertedInfo,
      });
    } else {
      needsConversion = true;
      this.context.log("Conversion needed - no converted info in map");
    }

    // If conversion is needed, create it
    if (needsConversion) {
      try {
        const tempDir = path.join(os.tmpdir(), `${uuidv4()}`);
        await fs.mkdir(tempDir);

        // Ensure we strip any query parameters from the URL when determining the local filename
        const cleanUrlPath = url.split("?")[0];
        const downloadedFile = path.join(tempDir, path.basename(cleanUrlPath));
        await this._downloadFile(url, downloadedFile);

        // Convert the file
        const conversion = await this.convertFile(downloadedFile, url);

        if (!conversion.converted) {
          throw new Error("File conversion failed");
        }

        // Save converted file to primary storage
        const convertedSaveResult = await this._saveConvertedFile(
          conversion.convertedPath,
          requestId,
        );
        if (!convertedSaveResult) {
          throw new Error("Failed to save converted file to primary storage");
        }

        // If GCS is configured, also save to GCS
        let gcsUrl;
        if (this._isGCSConfigured()) {
          gcsUrl = await this._uploadChunkToGCS(
            conversion.convertedPath,
            requestId,
          );
        }

        // Store converted file info
        const convertedFileInfo = {
          url: convertedSaveResult.url,
          gcs: gcsUrl,
        };

        // Attach converted info directly to the main file record –
        // the caller (index.js) will persist the updated fileInfo
        if (!convertedFileInfo.url) {
          throw new Error("Failed to get primary URL for converted file");
        }

        // Cleanup temp files
        await this._cleanupTempFiles(
          downloadedFile,
          conversion.convertedPath,
          tempDir,
        );

        return { ...fileInfo, converted: convertedFileInfo };
      } catch (error) {
        this.context.log("Error ensuring converted version:", error);
        // Don't return partial conversion results
        return fileInfo;
      }
    }

    return fileInfo;
  }

  // Private helper methods
  async _handleExcelConversion(filePath, tempDir) {
    this.context.log("Handling Excel file conversion");
    const csvPath = await this._xlsxToCsv(filePath);
    const ext = path.extname(filePath);
    const convertedPath = path.join(
      tempDir,
      `${path.basename(filePath, ext)}.csv`,
    );

    await pipeline(
      createReadStream(csvPath, { highWaterMark: 64 * 1024 }),
      createWriteStream(convertedPath, { highWaterMark: 64 * 1024 }),
    );
    await fs.unlink(csvPath);

    return {
      convertedPath,
      convertedName: path.basename(convertedPath),
      converted: true,
    };
  }

  async _handleDocumentConversion(filePath, originalUrl, tempDir) {
    this.context.log("Handling document conversion");
    if (!originalUrl) {
      throw new Error("Original URL is required for document conversion");
    }

    const markdown = await this._convertToMarkdown(originalUrl);
    if (!markdown) {
      throw new Error("Markdown conversion returned empty result");
    }

    // Remove any query parameters from the file path before processing
    const cleanFilePath = filePath.split("?")[0];
    const ext = path.extname(cleanFilePath);
    // Use LLM-friendly naming for temp files instead of original filename
    const shortId = generateShortId();
    const convertedPath = path.join(tempDir, `${shortId}.md`);
    await fs.writeFile(convertedPath, markdown);

    return {
      convertedPath,
      convertedName: path.basename(convertedPath),
      converted: true,
    };
  }

  async _convertToMarkdown(fileUrl) {
    try {
      const apiUrl = `${MARKITDOWN_CONVERT_URL}${encodeURIComponent(fileUrl)}`;
      const response = await axios.get(apiUrl);
      return response.data.markdown || "";
    } catch (err) {
      this.context.log("Error converting to markdown:", err);
      throw err;
    }
  }

  async _xlsxToCsv(filePath) {
    const workbook = XLSX.readFile(filePath, { type: "buffer" });
    const outputPath = filePath.replace(/\.[^/.]+$/, ".csv");
    let csvContent = "";

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      csvContent += `Sheet: ${sheetName}\n${csv}\n\n`;
    });

    await fs.writeFile(outputPath, csvContent);
    return outputPath;
  }

  // Storage-related methods (to be implemented by the caller)
  async _getFileStoreMap(key) {
    throw new Error("Method _getFileStoreMap must be implemented");
  }

  async _setFileStoreMap(key, value) {
    throw new Error("Method _setFileStoreMap must be implemented");
  }

  async _urlExists(url) {
    throw new Error("Method _urlExists must be implemented");
  }

  async _gcsUrlExists(url) {
    throw new Error("Method _gcsUrlExists must be implemented");
  }

  async _downloadFile(url, destination) {
    throw new Error("Method _downloadFile must be implemented");
  }

  async _saveConvertedFile(filePath, requestId) {
    throw new Error("Method _saveConvertedFile must be implemented");
  }

  async _uploadChunkToGCS(filePath, requestId) {
    throw new Error("Method _uploadChunkToGCS must be implemented");
  }

  _isGCSConfigured() {
    throw new Error("Method _isGCSConfigured must be implemented");
  }

  async _cleanupTempFiles(...files) {
    for (const file of files) {
      try {
        if (!file) continue;
        // Check if the file/directory exists
        await fs.access(file).catch(() => null);
        // Determine if the path is a directory or a file
        const stats = await fs.lstat(file).catch(() => null);
        if (!stats) continue;

        if (stats.isDirectory()) {
          await fs.rm(file, { recursive: true, force: true });
        } else {
          await fs.unlink(file);
        }
      } catch (err) {
        this.context.log("Error cleaning up temp file:", err);
      }
    }
  }
}
