import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { DOC_EXTENSIONS } from "./constants.js";
import { easyChunker } from "./docHelper.js";
import { downloadFile, splitMediaFile } from "./fileChunker.js";
import { ensureEncoded, ensureFileExtension, urlExists } from "./helper.js";
import {
  cleanupRedisFileStoreMap,
  getFileStoreMap,
  publishRequestProgress,
  removeFromFileStoreMap,
  setFileStoreMap,
  cleanupRedisFileStoreMapAge,
} from "./redis.js";
import { FileConversionService } from "./services/FileConversionService.js";
import { StorageService } from "./services/storage/StorageService.js";
import { uploadBlob } from "./blobHandler.js";
import { generateShortId } from "./utils/filenameUtils.js";

// Hybrid cleanup approach:
// 1. Lazy cleanup: Check file existence when cache entries are accessed (in getFileStoreMap)
// 2. Age cleanup: Remove old entries every 100 requests to prevent cache bloat
let requestCount = 0;

/**
 * Lightweight age-based cleanup - removes old cache entries to prevent bloat
 * Only removes entries older than 7 days and only checks a small sample
 * Runs every 100 requests to avoid performance impact
 */
async function cleanupInactive(context) {
  try {
    // Only run age cleanup every 100 requests to avoid overhead
    requestCount++;
    if (requestCount % 100 === 0) {
      const cleaned = await cleanupRedisFileStoreMapAge(7, 10); // 7 days, max 10 entries
      if (cleaned.length > 0) {
        context.log(`Age cleanup: Removed ${cleaned.length} old cache entries`);
      }
    }
  } catch (error) {
    console.log("Error occurred during age-based cleanup:", error);
  }
}

async function CortexFileHandler(context, req) {
  const {
    uri,
    requestId,
    save,
    hash,
    checkHash,
    clearHash,
    shortLivedMinutes,
    fetch,
    load,
    restore,
    container,
  } = req.body?.params || req.query;

  // Normalize boolean parameters
  const shouldSave = save === true || save === "true";
  const shouldCheckHash = checkHash === true || checkHash === "true";
  const shouldClearHash = clearHash === true || clearHash === "true";
  const shortLivedDuration = parseInt(shortLivedMinutes) || 5; // Default to 5 minutes
  const shouldFetchRemote = fetch || load || restore;



  const operation = shouldSave
    ? "save"
    : shouldCheckHash
      ? "checkHash"
      : shouldClearHash
        ? "clearHash"
        : shouldFetchRemote
          ? "remoteFile"
          : req.method.toLowerCase() === "delete" ||
              req.query.operation === "delete"
            ? "delete"
            : uri
              ? DOC_EXTENSIONS.some((ext) => uri.toLowerCase().endsWith(ext))
                ? "document_processing"
                : "media_chunking"
              : "upload";

  context.log(
    `Processing ${req.method} request - ${requestId ? `requestId: ${requestId}, ` : ""}${uri ? `uri: ${uri}, ` : ""}${hash ? `hash: ${hash}, ` : ""}operation: ${operation}`,
  );

  // Trigger lightweight age-based cleanup (runs every 100 requests)
  cleanupInactive(context);

  // Initialize services
  const storageService = new StorageService();
  await storageService._initialize(); // Ensure providers are initialized
  const conversionService = new FileConversionService(
    context,
    storageService.primaryProvider.constructor.name === "AzureStorageProvider",
    null,
  );

  // Validate URL for document processing and media chunking operations
  if (operation === "document_processing" || operation === "media_chunking") {
    try {
      const urlObj = new URL(uri);
      if (!["http:", "https:", "gs:"].includes(urlObj.protocol)) {
        context.res = {
          status: 400,
          body: "Invalid URL protocol - only HTTP, HTTPS, and GCS URLs are supported",
        };
        return;
      }
      // Check if the pathname is too long (e.g., > 1024 characters)
      if (urlObj.pathname.length > 1024) {
        context.res = {
          status: 400,
          body: "URL pathname is too long",
        };
        return;
      }
    } catch (error) {
      context.res = {
        status: 400,
        body: "Invalid URL format",
      };
      return;
    }
  }

  // Clean up files when request delete which means processing marked completed
  if (operation === "delete") {
    const deleteRequestId = req.query.requestId || requestId;
    const deleteHash = req.query.hash || hash;
    if (!deleteRequestId) {
      context.res = {
        status: 400,
        body: "Please pass a requestId on the query string",
      };
      return;
    }

    // First, get the hash from the map if it exists
    if (deleteHash) {
      const hashResult = await getFileStoreMap(deleteHash);
      if (hashResult) {
        context.log(`Found hash in map for deletion: ${deleteHash}`);
        await removeFromFileStoreMap(deleteHash);
      }
    }

    const deleted = await storageService.deleteFiles(deleteRequestId);
    context.res = {
      status: 200,
      body: { body: deleted },
    };
    return;
  }

  const remoteUrl = shouldFetchRemote;
  if (req.method.toLowerCase() === "get" && remoteUrl) {
    context.log(`Remote file: ${remoteUrl}`);
    let filename;
    try {
      // Validate URL format and accessibility
      const urlCheck = await urlExists(remoteUrl);
      if (!urlCheck.valid) {
        context.res = {
          status: 400,
          body: "Invalid or inaccessible URL",
        };
        return;
      }

      // Check if file already exists (using hash as the key)
      const exists = await getFileStoreMap(remoteUrl);
      if (exists) {
        context.res = {
          status: 200,
          body: exists,
        };
        //update redis timestamp with current time
        await setFileStoreMap(remoteUrl, exists);
        return;
      }

      // Download the file first
      const urlObj = new URL(remoteUrl);
      // Use LLM-friendly naming for temp files instead of original filename
      const fileExtension = path.extname(urlObj.pathname) || ".mp3";
      const shortId = generateShortId();
      const tempFileName = `${shortId}${fileExtension}`;
      filename = path.join(os.tmpdir(), tempFileName);
      await downloadFile(remoteUrl, filename);

      // For remote files, we don't need a requestId folder structure since it's just a single file
      // Pass empty string to store the file directly in the root
      const res = await storageService.uploadFile(context, filename, '');

      //Update Redis (using hash as the key)
      await setFileStoreMap(remoteUrl, res);

      // Return the file URL
      context.res = {
        status: 200,
        body: res,
      };
    } catch (error) {
      context.log("Error processing remote file request:", error);
      context.res = {
        status: 500,
        body: `Error processing file: ${error.message}`,
      };
    } finally {
      // Cleanup temp file if it exists
      try {
        if (filename && fs.existsSync(filename)) {
          fs.unlinkSync(filename);
        }
      } catch (err) {
        context.log("Error cleaning up temp file:", err);
      }
    }
    return;
  }

  if (hash && clearHash) {
    try {
      const hashValue = await getFileStoreMap(hash);
      if (hashValue) {
        await removeFromFileStoreMap(hash);
        context.res = {
          status: 200,
          body: `Hash ${hash} removed`,
        };
      } else {
        context.res = {
          status: 404,
          body: `Hash ${hash} not found`,
        };
      }
    } catch (error) {
      context.res = {
        status: 500,
        body: `Error occurred during hash cleanup: ${error}`,
      };
      console.log("Error occurred during hash cleanup:", error);
    }
    return;
  }

  if (hash && checkHash) {
    let hashResult = await getFileStoreMap(hash, true); // Skip lazy cleanup to handle it ourselves

    if (hashResult) {
      context.log(`File exists in map: ${hash}`);

      // Log the URL retrieved from Redis before checking existence
      context.log(`Checking existence of URL from Redis: ${hashResult?.url}`);

      try {
        // Check primary storage first
        const primaryExists = hashResult?.url
          ? await storageService.fileExists(hashResult.url)
          : false;
        const gcsExists = hashResult?.gcs
          ? await storageService.fileExists(hashResult.gcs)
          : false;

        // If neither storage has the file, remove from map and return not found
        if (!primaryExists && !gcsExists) {
          context.log(
            `File not found in any storage. Removing from map: ${hash}`,
          );
          await removeFromFileStoreMap(hash);
          context.res = {
            status: 404,
            body: `Hash ${hash} not found in storage`,
          };
          return;
        }

        // If GCS is missing but primary exists, restore to GCS
        if (primaryExists && !gcsExists && hashResult?.url) {
          context.log(`GCS file missing, restoring from primary: ${hash}`);
          try {
            hashResult = await storageService.ensureGCSUpload(
              context,
              hashResult,
            );
          } catch (error) {
            context.log(`Error restoring to GCS: ${error}`);
            // If restoration fails, remove the hash from the map
            await removeFromFileStoreMap(hash);
            context.res = {
              status: 404,
              body: `Hash ${hash} not found`,
            };
            return;
          }
        }

        // If primary is missing but GCS exists, restore from GCS
        if (
          !primaryExists &&
          gcsExists &&
          hashResult?.gcs &&
          storageService.backupProvider?.isConfigured()
        ) {
          context.log(
            `Primary storage file missing, restoring from GCS: ${hash}`,
          );
          try {
            // Create a temporary file to store the downloaded content
            const tempDir = path.join(os.tmpdir(), `${uuidv4()}`);
            fs.mkdirSync(tempDir);
            const downloadedFile = path.join(
              tempDir,
              path.basename(hashResult.gcs),
            );

            // Download from GCS
            await storageService.downloadFile(hashResult.gcs, downloadedFile);

            // Upload to primary storage
            const res = await storageService.uploadFile(
              context,
              downloadedFile,
              hash,
            );

            // Update the hash result with the new primary storage URL
            hashResult.url = res.url;

            // Clean up temp file
            try {
              if (downloadedFile && fs.existsSync(downloadedFile)) {
                fs.unlinkSync(downloadedFile);
              }
              if (tempDir && fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true });
              }
            } catch (err) {
              console.log("Error cleaning up temp files:", err);
            }
          } catch (error) {
            console.error("Error restoring from GCS:", error);
            // If restoration fails, remove the hash from the map
            await removeFromFileStoreMap(hash);
            context.res = {
              status: 404,
              body: `Hash ${hash} not found`,
            };
            return;
          }
        }

        // Final check to ensure we have at least one valid storage location
        const finalPrimaryCheck = hashResult?.url
          ? await storageService.fileExists(hashResult.url)
          : false;
        const finalGCSCheck = hashResult?.gcs
          ? await storageService.fileExists(hashResult.gcs)
          : false;
        if (!finalPrimaryCheck && !finalGCSCheck) {
          context.log(`Failed to restore file. Removing from map: ${hash}`);
          await removeFromFileStoreMap(hash);
          context.res = {
            status: 404,
            body: `Hash ${hash} not found`,
          };
          return;
        }

        // Create the response object
        const response = {
          message: `File '${hashResult.filename}' uploaded successfully.`,
          filename: hashResult.filename,
          url: hashResult.url,
          gcs: hashResult.gcs,
          hash: hashResult.hash,
          timestamp: new Date().toISOString(),
        };

        // Always generate short-lived URL for checkHash operations
        try {
          // Extract blob name from the stored URL to generate new SAS token
          let blobName;
          try {
            const url = new URL(hashResult.url);
            // Extract blob name from the URL path (remove leading slash)
            blobName = url.pathname.substring(1);
            // If there's a container prefix, remove it
            const containerName = storageService.primaryProvider.containerName;
            if (blobName.startsWith(containerName + '/')) {
              blobName = blobName.substring(containerName.length + 1);
            }
          } catch (urlError) {
            context.log(`Error parsing URL for short-lived generation: ${urlError}`);
          }

          // Generate short-lived SAS token
          if (blobName && storageService.primaryProvider.generateShortLivedSASToken) {
            const { containerClient } = await storageService.primaryProvider.getBlobClient();
            const sasToken = storageService.primaryProvider.generateShortLivedSASToken(
              containerClient, 
              blobName, 
              shortLivedDuration
            );
            
            // Construct new URL with short-lived SAS token
            const baseUrl = hashResult.url.split('?')[0]; // Remove existing SAS token
            const shortLivedUrl = `${baseUrl}?${sasToken}`;
            
            // Add short-lived URL to response
            response.shortLivedUrl = shortLivedUrl;
            response.expiresInMinutes = shortLivedDuration;
            
            context.log(`Generated short-lived URL for hash: ${hash} (expires in ${shortLivedDuration} minutes)`);
          } else {
            // Fallback for storage providers that don't support short-lived tokens
            response.shortLivedUrl = hashResult.url;
            response.expiresInMinutes = shortLivedDuration;
            context.log(`Storage provider doesn't support short-lived tokens, using original URL`);
          }
        } catch (error) {
          context.log(`Error generating short-lived URL: ${error}`);
          // Provide fallback even on error
          response.shortLivedUrl = hashResult.url;
          response.expiresInMinutes = shortLivedDuration;
        }

        // Ensure converted version exists and is synced across storage providers
        try {
          hashResult = await conversionService.ensureConvertedVersion(
            hashResult,
            requestId,
          );
        } catch (error) {
          context.log(`Error ensuring converted version: ${error}`);
        }

        // Attach converted info to response if present
        if (hashResult.converted) {
          response.converted = {
            url: hashResult.converted.url,
            gcs: hashResult.converted.gcs,
          };
        }

        //update redis timestamp with current time
        await setFileStoreMap(hash, hashResult);

        context.res = {
          status: 200,
          body: response,
        };
        return;
      } catch (error) {
        context.log(`Error checking file existence: ${error}`);
        // If there's an error checking file existence, remove the hash from the map
        await removeFromFileStoreMap(hash);
        context.res = {
          status: 404,
          body: `Hash ${hash} not found`,
        };
        return;
      }
    }

    context.res = {
      status: 404,
      body: `Hash ${hash} not found`,
    };
    return;
  }

  if (req.method.toLowerCase() === "post") {
    // Determine if we should save to local storage based on primary provider
    const saveToLocal =
      storageService.primaryProvider.constructor.name ===
      "LocalStorageProvider";
    // Use uploadBlob to handle multipart/form-data
    const result = await uploadBlob(context, req, saveToLocal, null, hash);
    if (result?.hash && context?.res?.body) {
      await setFileStoreMap(result.hash, context.res.body);
    }
    return;
  }

  if (!uri || !requestId) {
    context.res = {
      status: 400,
      body: "Please pass a uri and requestId on the query string or in the request body",
    };
    return;
  }

  let totalCount = 0;
  let completedCount = 0;
  let numberOfChunks;

  const file = ensureEncoded(uri); // encode url to handle special characters

  const result = [];

  const sendProgress = async (data = null) => {
    completedCount++;
    const progress = completedCount / totalCount;
    await publishRequestProgress({
      requestId,
      progress,
      completedCount,
      totalCount,
      numberOfChunks,
      data,
    });
  };

  try {
    // Parse URL and get pathname without query parameters for extension check
    const urlObj = new URL(uri);
    const pathWithoutQuery = urlObj.pathname;

    if (
      DOC_EXTENSIONS.some((ext) => pathWithoutQuery.toLowerCase().endsWith(ext))
    ) {
      const extension = path.extname(pathWithoutQuery).toLowerCase();
      const tempDir = path.join(os.tmpdir(), `${uuidv4()}`);
      fs.mkdirSync(tempDir);
      const downloadedFile = path.join(tempDir, `${uuidv4()}${extension}`);
      await downloadFile(uri, downloadedFile);

      try {
        if (shouldSave) {
          // Check if file needs conversion first
          if (conversionService.needsConversion(downloadedFile)) {
            // Convert the file
            const conversion = await conversionService.convertFile(
              downloadedFile,
              uri,
            );
            if (!conversion.converted) {
              throw new Error("File conversion failed");
            }

            // Save the converted file
            const convertedSaveResult =
              await conversionService._saveConvertedFile(
                conversion.convertedPath,
                requestId,
              );

            // Return the converted file URL
            context.res = {
              status: 200,
              body: {
                url: convertedSaveResult.url,
                blobName: path.basename(convertedSaveResult.url),
              },
            };
          } else {
            // File doesn't need conversion, save the original file
            const saveResult = await conversionService._saveConvertedFile(
              downloadedFile,
              requestId,
            );

            // Return the original file URL
            context.res = {
              status: 200,
              body: {
                url: saveResult.url,
                blobName: path.basename(saveResult.url),
              },
            };
          }
          return;
        } else {
          let text;
          if (conversionService.needsConversion(downloadedFile)) {
            text = await conversionService.convertFile(
              downloadedFile,
              uri,
              true,
            );
          } else {
            // For files that don't need conversion, read the file contents directly
            text = await fs.promises.readFile(downloadedFile, "utf-8");
          }
          result.push(...easyChunker(text));
        }
      } catch (err) {
        console.log(
          `Error saving file ${uri} with request id ${requestId}:`,
          err,
        );
        throw err; // Re-throw to handle in outer catch
      } finally {
        try {
          // delete temporary files
          if (downloadedFile && fs.existsSync(downloadedFile)) {
            fs.unlinkSync(downloadedFile);
            console.log(`Cleaned temp file ${downloadedFile}`);
          }
        } catch (err) {
          console.log(`Error cleaning temp file ${downloadedFile}:`, err);
        }

        // Delete uploaded files only if we're NOT saving the converted version.
        // When save=true we need to keep the converted file (which is stored under the same requestId prefix),
        // so skip the cleanup in that case.
        if (!shouldSave) {
          await storageService.deleteFiles(requestId);
          console.log(`Cleaned temp files for request id ${requestId}`);
        } else {
          console.log(
            `Skip cleanup for request id ${requestId} because save flag is set`,
          );
        }
      }
    } else {
      const { chunkPromises, chunkOffsets, uniqueOutputPath, chunkBaseName } =
        await splitMediaFile(file);

      numberOfChunks = chunkPromises.length; // for progress reporting
      totalCount += chunkPromises.length * 4; // 4 steps for each chunk (download and upload)

      // sequential download of chunks
      const chunks = [];
      for (const chunkPromise of chunkPromises) {
        const chunkPath = await chunkPromise;
        chunks.push(chunkPath);
        await sendProgress();
      }

      // sequential processing of chunks
      for (let index = 0; index < chunks.length; index++) {
        const chunkPath = chunks[index];
        // Use the same base filename for all chunks to ensure consistency
        const chunkFilename = `chunk-${index + 1}-${chunkBaseName}`;
        const chunkResult = await storageService.uploadFile(
          context,
          chunkPath,
          requestId,
          null,
          chunkFilename,
        );

        const chunkOffset = chunkOffsets[index];
        result.push({
          uri: chunkResult.url,
          offset: chunkOffset,
          gcs: chunkResult.gcs,
        });
        console.log(
          `Saved chunk as: ${chunkResult.url}${chunkResult.gcs ? ` and ${chunkResult.gcs}` : ""}`,
        );
        await sendProgress();
      }

      // Cleanup the temp directory
      try {
        if (uniqueOutputPath && fs.existsSync(uniqueOutputPath)) {
          fs.rmSync(uniqueOutputPath, { recursive: true });
          console.log(`Cleaned temp directory: ${uniqueOutputPath}`);
        }
      } catch (err) {
        console.log(`Error cleaning temp directory ${uniqueOutputPath}:`, err);
      }
    }
  } catch (error) {
    console.error("An error occurred:", error);
    context.res = {
      status: 500,
      body: error.message || error,
    };
    return;
  }

  console.log(
    "result:",
    result
      .map((item) =>
        typeof item === "object" ? JSON.stringify(item, null, 2) : item,
      )
      .join("\n"),
  );

  context.res = {
    body: result,
  };
}

export default CortexFileHandler;
