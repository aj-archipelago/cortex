import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { pipeline as _pipeline } from "stream";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import { PassThrough } from "stream";
import mime from "mime-types";
import { Storage } from "@google-cloud/storage";
import {
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  BlobServiceClient,
} from "@azure/storage-blob";
import axios from "axios";

import {
  sanitizeFilename,
  generateShortId,
  generateBlobName,
} from "./utils/filenameUtils.js";
import { publicFolder, port, ipAddress } from "./start.js";
import { CONVERTED_EXTENSIONS } from "./constants.js";
import { FileConversionService } from "./services/FileConversionService.js";

const pipeline = promisify(_pipeline);

function isBase64(str) {
  try {
    return btoa(atob(str)) == str;
  } catch (err) {
    return false;
  }
}

const { SAS_TOKEN_LIFE_DAYS = 30 } = process.env;
const GCP_SERVICE_ACCOUNT_KEY =
  process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
  process.env.GCP_SERVICE_ACCOUNT_KEY ||
  "{}";
const GCP_SERVICE_ACCOUNT = isBase64(GCP_SERVICE_ACCOUNT_KEY)
  ? JSON.parse(Buffer.from(GCP_SERVICE_ACCOUNT_KEY, "base64").toString())
  : JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
const { project_id: GCP_PROJECT_ID } = GCP_SERVICE_ACCOUNT;

let gcs;
if (!GCP_PROJECT_ID || !GCP_SERVICE_ACCOUNT) {
  console.warn(
    "No Google Cloud Storage credentials provided - GCS will not be used",
  );
} else {
  try {
    gcs = new Storage({
      projectId: GCP_PROJECT_ID,
      credentials: GCP_SERVICE_ACCOUNT,
    });

    // Rest of your Google Cloud operations using gcs object
  } catch (error) {
    console.error(
      "Google Cloud Storage credentials are invalid - GCS will not be used: ",
      error,
    );
  }
}

export const AZURE_STORAGE_CONTAINER_NAME =
  process.env.AZURE_STORAGE_CONTAINER_NAME || "whispertempfiles";
export const GCS_BUCKETNAME = process.env.GCS_BUCKETNAME || "cortextempfiles";

function isEncoded(str) {
  // Checks for any percent-encoded sequence
  return /%[0-9A-Fa-f]{2}/.test(str);
}

// Helper function to ensure GCS URLs are never encoded
function ensureUnencodedGcsUrl(url) {
  if (!url || !url.startsWith("gs://")) {
    return url;
  }
  // Split into bucket and path parts
  const [bucket, ...pathParts] = url.replace("gs://", "").split("/");
  // Reconstruct URL with decoded path parts, handling invalid characters
  return `gs://${bucket}/${pathParts
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch (error) {
        // If decoding fails, sanitize the filename by removing invalid characters
        return part.replace(/[^\w\-\.]/g, "_");
      }
    })
    .join("/")}`;
}

async function gcsUrlExists(url, defaultReturn = false) {
  try {
    if (!url || !gcs) {
      return defaultReturn; // Cannot check return
    }

    // Ensure URL is not encoded
    const unencodedUrl = ensureUnencodedGcsUrl(url);
    const urlParts = unencodedUrl.replace("gs://", "").split("/");
    const bucketName = urlParts[0];
    const fileName = urlParts.slice(1).join("/");

    if (process.env.STORAGE_EMULATOR_HOST) {
      try {
        const response = await axios.get(
          `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${bucketName}/o/${encodeURIComponent(fileName)}`,
          { validateStatus: (status) => status === 200 || status === 404 },
        );
        return response.status === 200;
      } catch (error) {
        console.error("Error checking emulator file:", error);
        return false;
      }
    }

    const bucket = gcs.bucket(bucketName);
    const file = bucket.file(fileName);

    const [exists] = await file.exists();

    return exists;
  } catch (error) {
    console.error("Error checking if GCS URL exists:", error);
    return false;
  }
}

/**
 * Downloads a file from Google Cloud Storage to a local file
 * @param {string} gcsUrl - The GCS URL in format gs://bucket-name/file-path
 * @param {string} destinationPath - The local path where the file should be saved
 * @returns {Promise<void>}
 */
async function downloadFromGCS(gcsUrl, destinationPath) {
  if (!gcsUrl || !gcs) {
    throw new Error("Invalid GCS URL or GCS client not initialized");
  }

  const urlParts = gcsUrl.replace("gs://", "").split("/");
  const bucketName = urlParts[0];
  const fileName = urlParts.slice(1).join("/");

  if (process.env.STORAGE_EMULATOR_HOST) {
    // Use axios to download from emulator
    const response = await axios({
      method: "GET",
      url: `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${bucketName}/o/${encodeURIComponent(fileName)}?alt=media`,
      responseType: "stream",
    });

    // Write the response to file
    const writer = fs.createWriteStream(destinationPath);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } else {
    // Use GCS client for real GCS
    const bucket = gcs.bucket(bucketName);
    const file = bucket.file(fileName);
    await file.download({ destination: destinationPath });
  }
}

export const getBlobClient = async () => {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = AZURE_STORAGE_CONTAINER_NAME;
  if (!connectionString || !containerName) {
    throw new Error(
      "Missing Azure Storage connection string or container name environment variable",
    );
  }

  const blobServiceClient =
    BlobServiceClient.fromConnectionString(connectionString);

  const serviceProperties = await blobServiceClient.getProperties();
  if (!serviceProperties.defaultServiceVersion) {
    serviceProperties.defaultServiceVersion = "2020-02-10";
    await blobServiceClient.setProperties(serviceProperties);
  }

  const containerClient = blobServiceClient.getContainerClient(containerName);

  return { blobServiceClient, containerClient };
};

async function saveFileToBlob(chunkPath, requestId, filename = null) {
  const { containerClient } = await getBlobClient();
  // Use provided filename or generate LLM-friendly naming
  let blobName;
  if (filename) {
    blobName = generateBlobName(requestId, filename);
  } else {
    const fileExtension = path.extname(chunkPath);
    const shortId = generateShortId();
    blobName = generateBlobName(requestId, `${shortId}${fileExtension}`);
  }

  // Create a read stream for the chunk file
  const fileStream = fs.createReadStream(chunkPath);

  // Upload the chunk to Azure Blob Storage using the stream
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadStream(fileStream);

  // Generate SAS token after successful upload
  const sasToken = generateSASToken(containerClient, blobName);

  // Return an object with the URL property
  return {
    url: `${blockBlobClient.url}?${sasToken}`,
    blobName: blobName,
  };
}

const generateSASToken = (
  containerClient,
  blobName,
  expiryTimeSeconds = parseInt(SAS_TOKEN_LIFE_DAYS) * 24 * 60 * 60,
) => {
  const { accountName, accountKey } = containerClient.credential;
  const sharedKeyCredential = new StorageSharedKeyCredential(
    accountName,
    accountKey,
  );

  const sasOptions = {
    containerName: containerClient.containerName,
    blobName: blobName,
    permissions: "r", // Read permission
    startsOn: new Date(),
    expiresOn: new Date(new Date().valueOf() + expiryTimeSeconds * 1000),
  };

  const sasToken = generateBlobSASQueryParameters(
    sasOptions,
    sharedKeyCredential,
  ).toString();
  return sasToken;
};

//deletes blob that has the requestId
async function deleteBlob(requestId) {
  if (!requestId) throw new Error("Missing requestId parameter");
  const { containerClient } = await getBlobClient();
  // List all blobs in the container
  const blobs = containerClient.listBlobsFlat();

  const result = [];
  // Iterate through the blobs
  for await (const blob of blobs) {
    // Check if the blob name starts with requestId_ (flat structure)
    // or is inside a folder named requestId/ (folder structure)
    if (
      blob.name.startsWith(`${requestId}_`) ||
      blob.name.startsWith(`${requestId}/`)
    ) {
      // Delete the matching blob
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete();
      console.log(`Cleaned blob: ${blob.name}`);
      result.push(blob.name);
    }
  }

  return result;
}

function uploadBlob(
  context,
  req,
  saveToLocal = false,
  filePath = null,
  hash = null,
) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        let requestId = uuidv4();
        const body = {};

        // If filePath is given, we are dealing with local file and not form-data
        if (filePath) {
          const file = fs.createReadStream(filePath);
          const filename = path.basename(filePath);

          // Generate LLM-friendly ID for requestId to match the filename pattern
          const fileExtension = path.extname(filename);
          const shortId = generateShortId();
          const uploadName = `${shortId}${fileExtension}`;
          requestId = shortId; // Use the short ID as requestId

          try {
            const result = await uploadFile(
              context,
              requestId,
              body,
              saveToLocal,
              file,
              uploadName, // Use the LLM-friendly filename
              resolve,
              hash,
            );
            resolve(result);
          } catch (error) {
            const err = new Error("Error processing file upload.");
            err.status = 500;
            throw err;
          }
        } else {
          // Otherwise, continue working with form-data
          const busboy = Busboy({ headers: req.headers });
          let hasFile = false;
          let errorOccurred = false;

          busboy.on("field", (fieldname, value) => {
            if (fieldname === "requestId") {
              requestId = value;
            } else if (fieldname === "hash") {
              hash = value;
            }
          });

          busboy.on("file", async (fieldname, file, info) => {
            if (errorOccurred) return;
            hasFile = true;

            // Validate file
            if (!info.filename || info.filename.trim() === "") {
              errorOccurred = true;
              const err = new Error("Invalid file: missing filename");
              err.status = 400;
              reject(err);
              return;
            }

            // Prepare for streaming to cloud destinations
            const filename = info.filename;
            const fileExtension = path.extname(filename);
            const shortId = generateShortId();
            const uploadName = `${shortId}${fileExtension}`;
            const azureStream = !saveToLocal ? new PassThrough() : null;
            const gcsStream = gcs ? new PassThrough() : null;
            let diskWriteStream, tempDir, tempFilePath;
            let diskWritePromise;
            let diskWriteError = null;
            let cloudUploadError = null;

            // Start local disk write in parallel (non-blocking for response)
            if (saveToLocal) {
              try {
                tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
              } catch (err) {
                console.error("Error creating tempDir:", err);
                errorOccurred = true;
                reject(err);
                return;
              }
              tempFilePath = path.join(tempDir, uploadName);
              try {
                diskWriteStream = fs.createWriteStream(tempFilePath, {
                  highWaterMark: 1024 * 1024,
                  autoClose: true,
                });
              } catch (err) {
                console.error(
                  "Error creating write stream:",
                  err,
                  "Temp dir exists:",
                  fs.existsSync(tempDir),
                );
                errorOccurred = true;
                reject(err);
                return;
              }
              diskWriteStream.on("error", (err) => {
                console.error("Disk write stream error:", err);
              });
              diskWriteStream.on("close", () => {
                console.log("Disk write stream closed for:", tempFilePath);
              });
              diskWritePromise = new Promise((res, rej) => {
                diskWriteStream.on("finish", res);
                diskWriteStream.on("error", (err) => {
                  diskWriteError = err;
                  rej(err);
                });
              });
            }

            // Pipe incoming file to all destinations
            let receivedAnyData = false;
            file.on("data", () => {
              receivedAnyData = true;
            });
            if (azureStream) file.pipe(azureStream);
            if (gcsStream) file.pipe(gcsStream);
            if (diskWriteStream) file.pipe(diskWriteStream);

            // Listen for end event to check for empty file
            file.on("end", async () => {
              if (!receivedAnyData) {
                errorOccurred = true;
                // Abort all streams
                if (azureStream) azureStream.destroy();
                if (gcsStream) gcsStream.destroy();
                if (diskWriteStream) diskWriteStream.destroy();
                const err = new Error("Invalid file: file is empty");
                err.status = 400;
                reject(err);
              }
            });

            // Start cloud uploads immediately
            let azurePromise;
            if (!saveToLocal) {
              azurePromise = saveToAzureStorage(
                context,
                uploadName,
                azureStream,
              ).catch(async (err) => {
                cloudUploadError = err;
                // Fallback: try from disk if available
                if (diskWritePromise) {
                  await diskWritePromise;
                  const diskStream = fs.createReadStream(tempFilePath, {
                    highWaterMark: 1024 * 1024,
                    autoClose: true,
                  });
                  return saveToAzureStorage(context, uploadName, diskStream);
                }
                throw err;
              });
            }
            let gcsPromise;
            if (gcsStream) {
              gcsPromise = saveToGoogleStorage(
                context,
                uploadName,
                gcsStream,
              ).catch(async (err) => {
                cloudUploadError = err;
                if (diskWritePromise) {
                  await diskWritePromise;
                  const diskStream = fs.createReadStream(tempFilePath, {
                    highWaterMark: 1024 * 1024,
                    autoClose: true,
                  });
                  return saveToGoogleStorage(context, uploadName, diskStream);
                }
                throw err;
              });
            }

            // Wait for cloud uploads to finish
            try {
              const results = await Promise.all(
                [
                  azurePromise
                    ? azurePromise.then((url) => ({ url, type: "primary" }))
                    : null,
                  !azurePromise && saveToLocal
                    ? Promise.resolve({ url: null, type: "primary-local" }) // placeholder for local, url handled later
                    : null,
                  gcsPromise
                    ? gcsPromise.then((gcs) => ({ gcs, type: "gcs" }))
                    : null,
                ].filter(Boolean),
              );

              const result = {
                message: `File '${uploadName}' uploaded successfully.`,
                filename: uploadName,
                ...results.reduce((acc, result) => {
                  if (result.type === "primary") acc.url = result.url;
                  if (result.type === "gcs")
                    acc.gcs = ensureUnencodedGcsUrl(result.gcs);
                  return acc;
                }, {}),
              };
              if (hash) result.hash = hash;

              // If saving locally, wait for disk write to finish and then move to public folder
              if (saveToLocal) {
                try {
                  if (diskWritePromise) {
                    await diskWritePromise; // ensure file fully written
                  }
                  const localUrl = await saveToLocalStorage(
                    context,
                    requestId,
                    uploadName,
                    fs.createReadStream(tempFilePath, {
                      highWaterMark: 1024 * 1024,
                      autoClose: true,
                    }),
                  );
                  result.url = localUrl;
                } catch (err) {
                  console.error("Error saving to local storage:", err);
                  throw err;
                }
              }

              // After original uploads, handle optional conversion
              const conversionService = new FileConversionService(
                context,
                !saveToLocal,
              );

              if (conversionService.needsConversion(fileExtension)) {
                try {
                  context.log("Starting file conversion (busboy)...");

                  // Ensure we have a local copy of the file for conversion
                  let localPathForConversion = tempFilePath;

                  if (!localPathForConversion) {
                    // No temp file was written (saveToLocal === false). Download from primary URL.
                    const tmpDir = fs.mkdtempSync(
                      path.join(os.tmpdir(), "convert-"),
                    );
                    localPathForConversion = path.join(tmpDir, uploadName);
                    await conversionService._downloadFile(
                      result.url,
                      localPathForConversion,
                    );
                  } else {
                    // Wait until disk write completes to guarantee full file is present
                    if (diskWritePromise) {
                      await diskWritePromise;
                    }
                  }

                  // Perform the conversion
                  const conversion = await conversionService.convertFile(
                    localPathForConversion,
                    result.url,
                  );
                  context.log(
                    "File conversion completed (busboy):",
                    conversion,
                  );

                  if (conversion.converted) {
                    context.log("Saving converted file (busboy)...");
                    // Save converted file to primary storage
                    const convertedSaveResult =
                      await conversionService._saveConvertedFile(
                        conversion.convertedPath,
                        requestId,
                      );

                    // Optionally save to GCS
                    let convertedGcsUrl;
                    if (conversionService._isGCSConfigured()) {
                      convertedGcsUrl =
                        await conversionService._uploadChunkToGCS(
                          conversion.convertedPath,
                          requestId,
                        );
                    }

                    // Attach to response body
                    result.converted = {
                      url: convertedSaveResult.url,
                      gcs: convertedGcsUrl,
                    };
                    context.log(
                      "Conversion process (busboy) completed successfully",
                    );
                  }
                } catch (convErr) {
                  console.error("Error converting file (busboy):", convErr);
                  context.log(
                    "Error during conversion (busboy):",
                    convErr.message,
                  );
                  // Continue without failing the upload
                }
              }

              // Respond after conversion (if any)
              context.res = { status: 200, body: result };
              resolve(result);
            } catch (err) {
              errorOccurred = true;
              reject(err);
            } finally {
              // Clean up temp file if written
              if (tempDir) {
                fs.rmSync(tempDir, { recursive: true, force: true });
              }
            }
          });

          busboy.on("error", (error) => {
            if (errorOccurred) return;
            errorOccurred = true;
            const err = new Error("No file provided in request");
            err.status = 400;
            reject(err);
          });

          busboy.on("finish", () => {
            if (errorOccurred) return;
            if (!hasFile) {
              errorOccurred = true;
              const err = new Error("No file provided in request");
              err.status = 400;
              reject(err);
            }
          });

          // Handle errors from piping the request
          req.on("error", (error) => {
            if (errorOccurred) return;
            errorOccurred = true;
            // Only log unexpected errors
            if (error.message !== "No file provided in request") {
              context.log("Error in request stream:", error);
            }
            const err = new Error("No file provided in request");
            err.status = 400;
            reject(err);
          });

          try {
            req.pipe(busboy);
          } catch (error) {
            if (errorOccurred) return;
            errorOccurred = true;
            // Only log unexpected errors
            if (error.message !== "No file provided in request") {
              context.log("Error piping request to busboy:", error);
            }
            const err = new Error("No file provided in request");
            err.status = 400;
            reject(err);
          }
        }
      } catch (error) {
        // Only log unexpected errors
        if (error.message !== "No file provided in request") {
          context.log("Error processing file upload:", error);
        }
        const err = new Error(error.message || "Error processing file upload.");
        err.status = error.status || 500;
        reject(err);
      }
    })();
  });
}

// Helper function to handle local file storage
async function saveToLocalStorage(context, requestId, encodedFilename, file) {
  const localPath = path.join(publicFolder, requestId);
  fs.mkdirSync(localPath, { recursive: true });

  // Sanitize filename by removing invalid characters
  const sanitizedFilename = sanitizeFilename(encodedFilename);
  const destinationPath = `${localPath}/${sanitizedFilename}`;

  await pipeline(file, fs.createWriteStream(destinationPath));
  return `http://${ipAddress}:${port}/files/${requestId}/${sanitizedFilename}`;
}

// Helper function to handle Azure blob storage
async function saveToAzureStorage(context, encodedFilename, file) {
  const { containerClient } = await getBlobClient();
  const contentType = mime.lookup(encodedFilename);

  // Create a safe blob name that is URI-encoded once (no double encoding)
  let blobName = sanitizeFilename(encodedFilename);
  blobName = encodeURIComponent(blobName);

  const options = {
    blobHTTPHeaders: contentType ? { blobContentType: contentType } : {},
    maxConcurrency: 50,
    blockSize: 8 * 1024 * 1024,
  };

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  context.log(`Uploading to Azure... ${blobName}`);
  await blockBlobClient.uploadStream(file, undefined, undefined, options);
  const sasToken = generateSASToken(containerClient, blobName);
  return `${blockBlobClient.url}?${sasToken}`;
}

// Helper function to upload a file to Google Cloud Storage
async function uploadToGCS(context, file, filename) {
  const objectName = sanitizeFilename(filename);
  const gcsFile = gcs.bucket(GCS_BUCKETNAME).file(objectName);
  const writeStream = gcsFile.createWriteStream({
    resumable: true,
    validation: false,
    metadata: {
      contentType: mime.lookup(objectName) || "application/octet-stream",
    },
    chunkSize: 8 * 1024 * 1024,
    numRetries: 3,
    retryDelay: 1000,
  });
  context.log(`Uploading to GCS... ${objectName}`);
  await pipeline(file, writeStream);
  return `gs://${GCS_BUCKETNAME}/${objectName}`;
}

// Wrapper that checks if GCS is configured
async function saveToGoogleStorage(context, encodedFilename, file) {
  if (!gcs) {
    throw new Error("Google Cloud Storage is not initialized");
  }
  return uploadToGCS(context, file, encodedFilename);
}

async function uploadFile(
  context,
  requestId,
  body,
  saveToLocal,
  file,
  filename,
  resolve,
  hash = null,
) {
  try {
    if (!file) {
      context.res = {
        status: 400,
        body: "No file provided in request",
      };
      resolve(context.res);
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    context.log(`Processing file with extension: ${ext}`);
    let uploadPath = null;
    let uploadName = null;
    let tempDir = null;

    // Create temp directory for file operations
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
    const tempOriginal = path.join(tempDir, filename);
    context.log(`Created temp directory: ${tempDir}`);

    // Optimize initial write with larger buffer
    const writeStream = fs.createWriteStream(tempOriginal, {
      highWaterMark: 1024 * 1024, // 1MB chunks for initial write
      autoClose: true,
    });

    // Use pipeline with error handling
    context.log("Writing file to temp location...");
    await pipeline(file, writeStream);
    context.log("File written to temp location successfully");

    uploadPath = tempOriginal;
    // Use the filename that was passed in (which should already be the LLM-friendly name)
    uploadName = filename;
    const fileExtension = path.extname(filename);
    context.log(`Prepared upload name: ${uploadName}`);

    // Create optimized read streams with larger buffers for storage uploads
    const createOptimizedReadStream = (path) =>
      fs.createReadStream(path, {
        highWaterMark: 1024 * 1024, // 1MB chunks for storage uploads
        autoClose: true,
      });

    // Upload original in parallel with optimized streams
    const storagePromises = [];
    context.log("Starting primary storage upload...");
    const primaryPromise = saveToLocal
      ? saveToLocalStorage(
          context,
          requestId,
          uploadName,
          createOptimizedReadStream(uploadPath),
        )
      : saveToAzureStorage(
          context,
          uploadName,
          createOptimizedReadStream(uploadPath),
        );
    storagePromises.push(
      primaryPromise.then((url) => {
        context.log("Primary storage upload completed");
        return { url, type: "primary" };
      }),
    );

    if (gcs) {
      context.log("Starting GCS upload...");
      storagePromises.push(
        saveToGoogleStorage(
          context,
          uploadName,
          createOptimizedReadStream(uploadPath),
        ).then((gcsUrl) => {
          context.log("GCS upload completed");
          return {
            gcs: gcsUrl,
            type: "gcs",
          };
        }),
      );
    }

    // Wait for original uploads to complete
    context.log("Waiting for all storage uploads to complete...");
    const results = await Promise.all(storagePromises);
    const result = {
      message: `File '${uploadName}' ${saveToLocal ? "saved to folder" : "uploaded"} successfully.`,
      filename: uploadName,
      ...results.reduce((acc, result) => {
        if (result.type === "primary") acc.url = result.url;
        if (result.type === "gcs") acc.gcs = ensureUnencodedGcsUrl(result.gcs);
        return acc;
      }, {}),
    };

    if (hash) {
      result.hash = hash;
    }

    // Initialize conversion service
    const conversionService = new FileConversionService(context, !saveToLocal);

    // Check if file needs conversion and handle it
    if (conversionService.needsConversion(fileExtension)) {
      try {
        context.log("Starting file conversion...");
        // Convert the file
        const conversion = await conversionService.convertFile(
          uploadPath,
          result.url,
        );
        context.log("File conversion completed:", conversion);

        if (conversion.converted) {
          context.log("Saving converted file...");
          // Save converted file
          const convertedSaveResult =
            await conversionService._saveConvertedFile(
              conversion.convertedPath,
              requestId,
            );
          context.log("Converted file saved to primary storage");

          // If GCS is configured, also save to GCS
          let convertedGcsUrl;
          if (conversionService._isGCSConfigured()) {
            context.log("Saving converted file to GCS...");
            convertedGcsUrl = await conversionService._uploadChunkToGCS(
              conversion.convertedPath,
              requestId,
            );
            context.log("Converted file saved to GCS");
          }

          // Add converted file info to result
          result.converted = {
            url: convertedSaveResult.url,
            gcs: convertedGcsUrl,
          };
          context.log("Conversion process completed successfully");
        }
      } catch (error) {
        console.error("Error converting file:", error);
        context.log("Error during conversion:", error.message);
        // Don't fail the upload if conversion fails
      }
    }

    context.res = {
      status: 200,
      body: result,
    };

    // Clean up temp files
    context.log("Cleaning up temporary files...");
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      context.log("Temporary files cleaned up");
    }

    context.log("Upload process completed successfully");
    resolve(result);
  } catch (error) {
    context.log("Error in upload process:", error);
    if (body.url) {
      try {
        await cleanup(context, [body.url]);
      } catch (cleanupError) {
        context.log("Error during cleanup after failure:", cleanupError);
      }
    }
    throw error;
  }
}

// Helper to convert a stream to a buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Function to delete files that haven't been used in more than a month
async function cleanup(context, urls = null) {
  const { containerClient } = await getBlobClient();
  const cleanedURLs = [];

  if (!urls) {
    const xMonthAgo = new Date();
    xMonthAgo.setMonth(xMonthAgo.getMonth() - 1);

    const blobs = containerClient.listBlobsFlat();

    for await (const blob of blobs) {
      const lastModified = blob.properties.lastModified;
      if (lastModified < xMonthAgo) {
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          await blockBlobClient.delete();
          context.log(`Cleaned blob: ${blob.name}`);
          cleanedURLs.push(blob.name);
        } catch (error) {
          if (error.statusCode !== 404) {
            context.log(`Error cleaning blob ${blob.name}:`, error);
          }
        }
      }
    }
  } else {
    for (const url of urls) {
      try {
        const blobName = url.replace(containerClient.url, "");
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.delete();
        context.log(`Cleaned blob: ${blobName}`);
        cleanedURLs.push(blobName);
      } catch (error) {
        if (error.statusCode !== 404) {
          context.log(`Error cleaning blob ${url}:`, error);
        }
      }
    }
  }
  return cleanedURLs;
}

async function cleanupGCS(urls = null) {
  if (!gcs) return [];
  const bucket = gcs.bucket(GCS_BUCKETNAME);
  const directories = new Set();
  const cleanedURLs = [];

  if (!urls) {
    const daysN = 30;
    const threshold = Date.now() - daysN * 24 * 60 * 60 * 1000;
    const [files] = await bucket.getFiles();

    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const directoryPath = path.dirname(file.name);
      directories.add(directoryPath);
      if (metadata.updated) {
        const updatedTime = new Date(metadata.updated).getTime();
        if (updatedTime < threshold) {
          await file.delete();
          cleanedURLs.push(file.name);
        }
      }
    }
  } else {
    for (const url of urls) {
      const filePath = url.split("/").slice(3).join("/");
      const file = bucket.file(filePath);
      const directoryPath = path.dirname(file.name);
      directories.add(directoryPath);
      await file.delete();
      cleanedURLs.push(url);
    }
  }

  for (const directory of directories) {
    const [files] = await bucket.getFiles({ prefix: directory });
    if (files.length === 0) {
      await bucket.deleteFiles({ prefix: directory });
    }
  }

  return cleanedURLs;
}

async function deleteGCS(blobName) {
  if (!blobName) {
    console.log("[deleteGCS] No blobName provided, skipping GCS deletion");
    return;
  }

  if (!gcs) {
    console.log("[deleteGCS] GCS not initialized, skipping deletion");
    return;
  }

  try {
    if (process.env.STORAGE_EMULATOR_HOST) {
      console.log(
        `[deleteGCS] Using emulator at ${process.env.STORAGE_EMULATOR_HOST}`,
      );
      console.log(
        `[deleteGCS] Attempting to delete files with prefix: ${blobName}`,
      );

      // List files first
      const listUrl = `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${GCS_BUCKETNAME}/o?prefix=${blobName}`;
      console.log(`[deleteGCS] Listing files with URL: ${listUrl}`);

      const listResponse = await axios.get(listUrl, {
        validateStatus: (status) => true,
      });
      console.log(`[deleteGCS] List response status: ${listResponse.status}`);
      console.log(
        `[deleteGCS] List response data: ${JSON.stringify(listResponse.data)}`,
      );

      if (listResponse.status === 200 && listResponse.data.items) {
        console.log(
          `[deleteGCS] Found ${listResponse.data.items.length} items to delete`,
        );

        // Delete each file
        for (const item of listResponse.data.items) {
          const deleteUrl = `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${GCS_BUCKETNAME}/o/${encodeURIComponent(item.name)}`;
          console.log(`[deleteGCS] Deleting file: ${item.name}`);
          console.log(`[deleteGCS] Delete URL: ${deleteUrl}`);

          const deleteResponse = await axios.delete(deleteUrl, {
            validateStatus: (status) => true,
            headers: {
              "Content-Type": "application/json",
            },
          });
          console.log(
            `[deleteGCS] Delete response status: ${deleteResponse.status}`,
          );
          console.log(
            `[deleteGCS] Delete response data: ${JSON.stringify(deleteResponse.data)}`,
          );
        }
        console.log("[deleteGCS] All files deleted successfully");
      } else {
        console.log("[deleteGCS] No files found to delete");
      }
    } else {
      console.log("[deleteGCS] Using real GCS");
      const bucket = gcs.bucket(GCS_BUCKETNAME);
      const [files] = await bucket.getFiles({ prefix: blobName });
      console.log(`[deleteGCS] Found ${files.length} files to delete`);

      if (files.length > 0) {
        await Promise.all(files.map((file) => file.delete()));
        console.log("[deleteGCS] All files deleted successfully");
      } else {
        console.log("[deleteGCS] No files found to delete");
      }
    }
  } catch (error) {
    // If we get a 404 error, it means the file is already gone, which is fine
    if (error.response?.status === 404 || error.code === 404) {
      console.log(
        "[deleteGCS] File not found in GCS (404) - this is expected if file was already deleted",
      );
      return;
    }
    console.error("[deleteGCS] Error during deletion:", error);
    console.error("[deleteGCS] Error details:", {
      message: error.message,
      code: error.code,
      errors: error.errors,
      response: error.response
        ? {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data,
            headers: error.response.headers,
          }
        : null,
    });
    // Don't throw the error - we want to continue with cleanup even if GCS deletion fails
  }
}

// Helper function to ensure GCS upload for existing files
async function ensureGCSUpload(context, existingFile) {
  if (!existingFile.gcs && gcs) {
    context.log("GCS file was missing - uploading.");
    // Use LLM-friendly naming instead of extracting original filename
    const fileExtension = path.extname(existingFile.url.split("?")[0]);
    const shortId = generateShortId();
    const fileName = `${shortId}${fileExtension}`;
    const response = await axios({
      method: "get",
      url: existingFile.url,
      responseType: "stream",
    });
    existingFile.gcs = await uploadToGCS(context, response.data, fileName);
  }
  return existingFile;
}

async function uploadChunkToGCS(chunkPath, requestId, filename = null) {
  if (!gcs) return null;
  const dirName = requestId || uuidv4();
  // Use provided filename or generate LLM-friendly naming
  let gcsFileName;
  if (filename) {
    gcsFileName = `${dirName}/${filename}`;
  } else {
    const fileExtension = path.extname(chunkPath);
    const shortId = generateShortId();
    gcsFileName = `${dirName}/${shortId}${fileExtension}`;
  }
  await gcs
    .bucket(GCS_BUCKETNAME)
    .upload(chunkPath, { destination: gcsFileName });
  return `gs://${GCS_BUCKETNAME}/${gcsFileName}`;
}

export {
  saveFileToBlob,
  deleteBlob,
  deleteGCS,
  uploadBlob,
  cleanup,
  cleanupGCS,
  gcsUrlExists,
  ensureGCSUpload,
  gcs,
  uploadChunkToGCS,
  downloadFromGCS,
};
