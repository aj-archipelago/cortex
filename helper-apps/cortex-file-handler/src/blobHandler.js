import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { pipeline as _pipeline } from "stream";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import { PassThrough } from "stream";
import { Storage } from "@google-cloud/storage";
import axios from "axios";
import mime from "mime-types";

import {
  sanitizeFilename,
  generateShortId,
  generateBlobName,
} from "./utils/filenameUtils.js";
import { publicFolder, port, ipAddress } from "./start.js";
import {
  CONVERTED_EXTENSIONS,
  AZURITE_ACCOUNT_NAME,
  getDefaultContainerName,
  getUserContainerName,
  GCS_BUCKETNAME,
  AZURE_STORAGE_CONTAINER_NAME
} from "./constants.js";
import { FileConversionService } from "./services/FileConversionService.js";
import { StorageFactory } from "./services/storage/StorageFactory.js";
import { StorageService } from "./services/storage/StorageService.js";

const pipeline = promisify(_pipeline);

function isBase64(str) {
  try {
    return btoa(atob(str)) == str;
  } catch (err) {
    return false;
  }
}

const { SAS_TOKEN_LIFE_DAYS = 30 } = process.env;
let GCP_SERVICE_ACCOUNT;
let GCP_PROJECT_ID;

try {
  const GCP_SERVICE_ACCOUNT_KEY =
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
    process.env.GCP_SERVICE_ACCOUNT_KEY ||
    "{}";
  GCP_SERVICE_ACCOUNT = isBase64(GCP_SERVICE_ACCOUNT_KEY)
    ? JSON.parse(Buffer.from(GCP_SERVICE_ACCOUNT_KEY, "base64").toString())
    : JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
  GCP_PROJECT_ID = GCP_SERVICE_ACCOUNT.project_id;
} catch (error) {
  console.warn("Error parsing GCP service account credentials, GCS will not be used:", error.message);
  GCP_SERVICE_ACCOUNT = {};
  GCP_PROJECT_ID = null;
}

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

function isEncoded(str) {
  // Checks for any percent-encoded sequence
  return /%[0-9A-Fa-f]{2}/.test(str);
}

/**
 * Construct folder path for file storage based on user/chat context.
 * MIRROR: Keep in sync with vendor/cortex/lib/fileUtils.js constructFolderPath()
 * @param {Object} options - Options for folder path construction
 * @param {string} options.userId - Container owner ID
 * @param {string} options.chatId - Chat ID (if file is chat-scoped)
 * @param {string} options.workspaceId - Workspace ID (for workspace-user-legacy or workspace-shared-legacy scopes)
 * @param {string} options.appletId - Applet ID (for applet-user scopes)
 * @param {string} options.contextId - Optional scoped context ID
 * @param {string} options.fileScope - File scope: 'all', 'global', 'media', 'chat', 'workspace-user-legacy', 'applet-user', 'applet-shared', 'profile', 'articles', 'workspace-shared-legacy'
 * @returns {string|null} Folder path or null if no valid path can be constructed
 */
// IDs must be alphanumeric, hyphens, or underscores — rejects traversal and injection.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID.test(id);
}

function sanitizeSubPath(subPath) {
  if (!subPath || typeof subPath !== 'string') return null;

  const segments = subPath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => !isValidId(segment))) {
    return null;
  }

  return segments.join('/');
}

function parseAppletUserContextId(contextId = null) {
  if (typeof contextId !== "string" || !contextId.startsWith("applet-user:")) {
    return { appletId: null, userId: null };
  }

  const parts = contextId.split(":");
  if (parts.length < 3) {
    return { appletId: null, userId: null };
  }

  return {
    appletId: parts[1] || null,
    userId: parts.slice(2).join(":") || null,
  };
}

function resolveAppletScopeId({
  appletId = null,
  workspaceId = null,
  contextId = null,
} = {}) {
  if (appletId && isValidId(appletId)) {
    return appletId;
  }

  const parsed = parseAppletUserContextId(contextId);
  if (parsed.appletId && isValidId(parsed.appletId)) {
    return parsed.appletId;
  }

  if (workspaceId && isValidId(workspaceId)) {
    return workspaceId;
  }

  return null;
}

function buildAppletUserContextId(userId = null, appletId = null) {
  if (!userId || !appletId) {
    return null;
  }
  return `applet-user:${appletId}:${userId}`;
}

function buildAppletSharedContextId(appletId = null) {
  if (!appletId) {
    return null;
  }
  return `applet-shared:${appletId}`;
}

function constructFolderPath({
  userId,
  chatId,
  workspaceId,
  appletId = null,
  contextId = null,
  fileScope,
}) {
  // For workspace-shared-legacy scope, userId is not required — workspaceId is the owner
  if (fileScope === 'workspace-shared-legacy') {
    if (!workspaceId || !isValidId(workspaceId)) return null;
    return '';  // root of per-workspace container
  }

  const ownerId = contextId || userId || null;
  if (!ownerId) {
    return null;
  }

  // Validate path-part IDs to prevent traversal / cross-tenant access.
  // ownerId is used only for container selection and may be a compound scoped context ID.
  if (chatId && !isValidId(chatId)) return null;
  if (workspaceId && !isValidId(workspaceId)) return null;
  if (appletId && !isValidId(appletId)) return null;

  // Folder names encode the logical scope within the selected container.
  // applet-user stays in the user's container under an applet-specific folder.
  switch (fileScope) {
    case 'all':
      // Root of the scoped container — lists everything
      return '';
    case 'global':
      return 'global';
    case 'media':
      return 'media';
    case 'chat':
      if (!chatId) {
        return 'global';
      }
      return `chats/${chatId}`;
    case 'workspace-user-legacy':
      if (!workspaceId) {
        return 'global';
      }
      return `applets/${workspaceId}`;
    case 'applet-user': {
      const scopedAppletId = resolveAppletScopeId({
        appletId,
        workspaceId,
        contextId,
      });
      if (!scopedAppletId) {
        return null;
      }
      return `applets/${scopedAppletId}`;
    }
    case 'applet-shared':
      return 'applet-shared';
    case 'profile':
      return 'profile';
    case 'articles':
      return 'articles';
    case 'applets':
      return 'applets';
    case 'skills':
      return 'skills';
    case 'automations':
      return 'automations';
    default:
      return 'global';
  }
}

function getScopedLogicalContextId({
  contextId = null,
  userId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
} = {}) {
  if (fileScope === 'workspace-shared-legacy') {
    return workspaceId || contextId || null;
  }

  if (fileScope === 'applet-user') {
    if (
      typeof contextId === 'string'
      && contextId.startsWith('applet-user:')
    ) {
      return contextId;
    }

    const parsedContext = parseAppletUserContextId(contextId);
    const parsedUser = parseAppletUserContextId(userId);
    const resolvedUserId =
      parsedContext.userId
      || parsedUser.userId
      || userId
      || contextId
      || null;
    const resolvedAppletId = resolveAppletScopeId({
      appletId: parsedContext.appletId || parsedUser.appletId || appletId,
      workspaceId,
      contextId,
    });

    return buildAppletUserContextId(resolvedUserId, resolvedAppletId);
  }

  if (fileScope === 'applet-shared') {
    if (contextId) {
      return contextId;
    }

    if (typeof userId === 'string' && userId.startsWith('applet-shared:')) {
      return userId;
    }

    return buildAppletSharedContextId(
      resolveAppletScopeId({ appletId, workspaceId, contextId }),
    );
  }

  return contextId || userId || null;
}

function getScopedContainerOwnerId({
  contextId = null,
  userId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
} = {}) {
  if (fileScope === 'workspace-shared-legacy') {
    return workspaceId || null;
  }

  if (fileScope === 'applet-user') {
    const parsed = parseAppletUserContextId(contextId);
    const scopedUserId = parsed.userId || userId || null;
    return scopedUserId;
  }

  return getScopedLogicalContextId({
    contextId,
    userId,
    workspaceId,
    appletId,
    fileScope,
  });
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

/**
 * Extracts MIME type from a URL based on file extension
 * @param {string} url - The URL to extract MIME type from
 * @returns {string} The MIME type or 'application/octet-stream' as fallback
 */
function getMimeTypeFromUrl(url) {
  const defaultMimeType = 'application/octet-stream';
  if (!url) return defaultMimeType;

  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const extension = path.extname(pathname);
    return mime.lookup(extension) || defaultMimeType;
  } catch (e) {
    // If URL parsing fails, try to extract extension from URL string
    const urlMatch = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    if (urlMatch) {
      return mime.lookup(urlMatch[1]) || defaultMimeType;
    }
    return defaultMimeType;
  }
}

/**
 * Generates a short-lived SAS URL for a converted file
 * @param {object} context - The request context for logging
 * @param {string} convertedUrl - The URL of the converted file
 * @param {string} [logSuffix=''] - Optional suffix for log messages
 * @returns {Promise<string>} The short-lived URL or the original URL as fallback
 */
async function generateShortLivedUrlForConvertedFile(context, convertedUrl, logSuffix = '') {
  let shortLivedUrl = convertedUrl; // Fallback to regular URL
  try {
    const storageFactory = StorageFactory.getInstance();
    const primaryProvider = await storageFactory.getAzureProvider();
    if (primaryProvider.generateShortLivedSASToken && primaryProvider.extractBlobNameFromUrl) {
      const blobName = primaryProvider.extractBlobNameFromUrl(convertedUrl);
      if (blobName) {
        await primaryProvider.ensureInitialized();
        const sasToken = primaryProvider.generateShortLivedSASToken(
          blobName,
          5
        );
        const urlObj = new URL(convertedUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
        shortLivedUrl = `${baseUrl}?${sasToken}`;
        context.log(`Generated shortLivedUrl for converted file${logSuffix}`);
      }
    }
  } catch (error) {
    context.log(`Warning: Could not generate shortLivedUrl for converted file: ${error.message}`);
    // Fallback to regular URL
  }
  return shortLivedUrl;
}

export const getBlobClient = async () => {
  const provider = await StorageFactory.getInstance().getAzureProvider();
  return await provider.getBlobClient();
};

//deletes blob that has the requestId
async function deleteBlob(requestId) {
  if (!requestId) throw new Error("Missing requestId parameter");
  // Container parameter is ignored - always uses default container from env var
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
        // Container parameter is ignored - always uses default container from env var
        const body = {};
        const fields = {}; // Buffer for all fields

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
              fields, // Pass fields for contextId extraction
            );
            resolve(result);
          } catch (error) {
            console.error("Error in uploadFile (local file path):", error);
            const err = new Error(`Error processing file upload: ${error.message}`);
            err.status = 500;
            throw err;
          }
        } else {
          const busboy = Busboy({ headers: req.headers });
          let hasFile = false;
          let errorOccurred = false;


          busboy.on("field", (fieldname, value) => {
            if (fieldname === "requestId") {
              requestId = value;
            } else if (fieldname === "hash") {
              hash = value;
            } else if (fieldname === "container") {
              // Container parameter is ignored - always uses default container from env var
              // No validation or error needed, just ignore it
            }
            fields[fieldname] = value; // Store all fields
          });

          // Promise that resolves once busboy has finished parsing the
          // entire multipart stream (all fields + file data consumed).
          // Used inside processFile to ensure late-arriving fields
          // (e.g. hash appended after the file) are available.
          let resolveBusboyFinished;
          const busboyFinished = new Promise((r) => { resolveBusboyFinished = r; });

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

            // Fields that precede the file part are already available.
            // Fields after the file part (e.g. hash) will arrive once
            // the file data is consumed — processFile handles this by
            // awaiting busboyFinished after the upload completes.
            await processFile(fieldname, file, info);
          });

          const processFile = async (fieldname, file, info) => {
            if (errorOccurred) return;

            // Validate file
            if (!info.filename || info.filename.trim() === "") {
              errorOccurred = true;
              const err = new Error("Invalid file: missing filename");
              err.status = 400;
              reject(err);
              return;
            }

            // Extract folder-related fields from form data
            const userId = fields.userId || null;
            const chatId = fields.chatId || null;
            const workspaceId = fields.workspaceId || null;
            const contextId = fields.contextId || null;
            const appletId = fields.appletId || null;
            const fileScope = fields.fileScope || null;
            const logicalContextId = getScopedLogicalContextId({
              contextId,
              userId,
              workspaceId,
              appletId,
              fileScope,
            });

            // Construct folder path for folder-based storage
            let folderPath = constructFolderPath({
              userId,
              chatId,
              workspaceId,
              appletId,
              contextId: logicalContextId,
              fileScope,
            });

            // Optional subPath appends a subdirectory within the fileScope folder.
            const subPath = fields.subPath || null;
            if (subPath && folderPath !== null) {
              const sanitizedSub = sanitizeSubPath(subPath);
              if (sanitizedSub) {
                folderPath = folderPath ? `${folderPath}/${sanitizedSub}` : sanitizedSub;
              }
            }

            // Prepare for streaming to cloud destinations
            const displayFilename = info.filename; // Preserve original filename for metadata
            const fileExtension = path.extname(displayFilename);
            const shortId = generateShortId();
            const uploadName = folderPath ? sanitizeFilename(displayFilename) : `${shortId}${fileExtension}`;
            // Extract content-type from busboy info (preserves charset if provided)
            const contentType = info.mimeType || null;
            const azureStream = !saveToLocal ? new PassThrough() : null;
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
            if (diskWriteStream) file.pipe(diskWriteStream);

            // Listen for end event to check for empty file
            file.on("end", async () => {
              if (!receivedAnyData) {
                errorOccurred = true;
                // Abort all streams
                if (azureStream) azureStream.destroy();
                if (diskWriteStream) diskWriteStream.destroy();
                const err = new Error("Invalid file: file is empty");
                err.status = 400;
                reject(err);
              }
            });

            const containerOwnerId = getScopedContainerOwnerId({
              contextId: logicalContextId,
              userId,
              workspaceId,
              appletId,
              fileScope,
            });
            const userContainerName = containerOwnerId
              ? getUserContainerName(getDefaultContainerName(), containerOwnerId)
              : null;

            // Start cloud uploads immediately
            let azurePromise;
            if (!saveToLocal) {
              azurePromise = saveToAzureStorage(
                context,
                uploadName,
                azureStream,
                userContainerName,
                contentType,
                folderPath, // Pass folder path for folder-based storage
              ).catch(async (err) => {
                cloudUploadError = err;
                // Fallback: try from disk if available
                if (diskWritePromise) {
                  await diskWritePromise;
                  const diskStream = fs.createReadStream(tempFilePath, {
                    highWaterMark: 1024 * 1024,
                    autoClose: true,
                  });
                  return saveToAzureStorage(context, uploadName, diskStream, userContainerName, contentType, folderPath);
                }
                throw err;
              });
            }
            // Wait for cloud uploads to finish
            try {
              const results = await Promise.all(
                [
                  azurePromise
                    ? azurePromise.then((result) => ({ result, type: "primary" }))
                    : null,
                  !azurePromise && saveToLocal
                    ? Promise.resolve({ result: { url: null }, type: "primary-local" }) // placeholder for local, url handled later
                    : null,
                ].filter(Boolean),
              );

              const result = {
                message: `File '${uploadName}' uploaded successfully.`,
                filename: uploadName,
                displayFilename: displayFilename, // Store original filename in metadata
                ...results.reduce((acc, item) => {
                  if (item.type === "primary") {
                    acc.url = item.result.url || item.result;
                    acc.shortLivedUrl = item.result.shortLivedUrl || item.result.url || item.result;
                    if (item.result.blobName) {
                      acc.blobName = item.result.blobName;
                      acc.blobPath = item.result.blobName;
                    }
                  }
                  return acc;
                }, {}),
              };

              if (!saveToLocal && gcs && result.url && result.blobName) {
                const storageService = new StorageService();
                try {
                  const ensuredFile = await storageService.ensureGCSUpload(context, {
                    url: result.shortLivedUrl || result.url,
                    blobName: result.blobName,
                    blobPath: result.blobPath || result.blobName,
                    containerOwnerId,
                    mimeType: contentType,
                  });
                  if (ensuredFile?.gcs) {
                    result.gcs = ensureUnencodedGcsUrl(ensuredFile.gcs);
                  }
                } catch (error) {
                  context.log?.(`Warning: GCS backup failed for ${result.blobName}: ${error.message}`);
                }
              }

              // Wait for busboy to finish parsing the entire request so
              // that form fields appended after the file (e.g. hash) are
              // available.  The file data is already consumed, so busboy
              // can parse the remaining fields without backpressure.
              await busboyFinished;

              if (hash) result.hash = hash;

              // Store MIME type from upload (used by Cortex for file type detection)
              if (contentType) {
                result.mimeType = contentType;
              }
              
              // Persist metadata in the same scoped Redis namespace that owns
              // the uploaded blob, even when callers only send userId/workspaceId.
              const uploadContextId = getScopedContainerOwnerId({
                contextId: logicalContextId,
                userId,
                workspaceId,
                appletId,
                fileScope,
              });
              const mapContextId = logicalContextId || uploadContextId;
              if (mapContextId) {
                result.contextId = mapContextId;
              }

              // Include folder metadata in result (for transparency/debugging)
              if (folderPath) {
                result.folderPath = folderPath;
              }
              if (userId) result.userId = userId;
              if (workspaceId) result.workspaceId = workspaceId;
              if (appletId) result.appletId = appletId;
              if (fileScope) result.fileScope = fileScope;

              // Container parameter is ignored - always uses default container from env var
              
              // Ensure shortLivedUrl is always present
              if (!result.shortLivedUrl && result.url) {
                result.shortLivedUrl = result.url;
              }

              // If saving locally, wait for disk write to finish and then move to public folder
              if (saveToLocal) {
                try {
                  if (diskWritePromise) {
                    await diskWritePromise; // ensure file fully written
                  }
                  const localResult = await saveToLocalStorage(
                    context,
                    requestId,
                    uploadName,
                    fs.createReadStream(tempFilePath, {
                      highWaterMark: 1024 * 1024,
                      autoClose: true,
                    }),
                  );
                  // Handle both old format (string) and new format (object)
                  result.url = typeof localResult === 'string' ? localResult : localResult.url;
                  result.shortLivedUrl = localResult.shortLivedUrl || result.url;
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
                    // Pass folderPath so converted file is stored next to original
                    const convertedSaveResult =
                      await conversionService._saveConvertedFile(
                        conversion.convertedPath,
                        requestId,
                        null,
                        folderPath,
                      );

                    // Optionally save to GCS
                    let convertedGcsUrl;
                    if (conversionService._isGCSConfigured()) {
                      convertedGcsUrl =
                        await conversionService._uploadChunkToGCS(
                          conversion.convertedPath,
                          requestId,
                          null,
                          folderPath,
                        );
                    }

                    // Generate shortLivedUrl for converted file
                    const convertedShortLivedUrl = await generateShortLivedUrlForConvertedFile(
                      context,
                      convertedSaveResult.url,
                      ' (busboy)'
                    );

                    // Determine MIME type of converted file from its URL
                    const convertedMimeType = getMimeTypeFromUrl(convertedSaveResult.url);

                    // Attach to response body
                    result.converted = {
                      url: convertedSaveResult.url,
                      shortLivedUrl: convertedShortLivedUrl,
                      gcs: convertedGcsUrl,
                      mimeType: convertedMimeType,
                    };
                    
                    // Note: result.shortLivedUrl remains pointing to the original file
                    // result.converted.shortLivedUrl points to the converted file
                    // Both are available for different use cases
                    
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
              console.error("Error in main busboy processing:", err);
              console.error("Stack trace:", err.stack);
              errorOccurred = true;
              reject(err);
            } finally {
              // Clean up temp file if written
              if (tempDir) {
                fs.rmSync(tempDir, { recursive: true, force: true });
              }
            }
          };

          busboy.on("error", (error) => {
            resolveBusboyFinished();
            if (errorOccurred) return;
            errorOccurred = true;
            const err = new Error("No file provided in request");
            err.status = 400;
            reject(err);
          });

          busboy.on("finish", () => {
            resolveBusboyFinished();
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
        // Always log errors with full details for debugging
        console.error("Top-level error processing file upload:", error);
        console.error("Error stack trace:", error.stack);
        context.log("Error processing file upload:", error);
        const err = new Error(error.message || "Error processing file upload.");
        err.status = error.status || 500;
        reject(err);
      }
    })();
  });
}

// Helper function to handle local file storage
async function saveToLocalStorage(context, requestId, encodedFilename, file) {
  const storageFactory = StorageFactory.getInstance();
  const localProvider = storageFactory.getLocalProvider();
  const contextWithRequestId = { ...context, requestId };
  return await localProvider.uploadStream(contextWithRequestId, encodedFilename, file);
}

// Helper function to handle Azure blob storage
async function saveToAzureStorage(context, encodedFilename, file, containerName = null, contentType = null, folderPath = null) {
  const storageFactory = StorageFactory.getInstance();
  const provider = await storageFactory.getAzureProvider(containerName);
  return await provider.uploadStream(context, encodedFilename, file, contentType, folderPath);
}

// Wrapper that checks if GCS is configured
async function saveToGoogleStorage(context, encodedFilename, file, contentType = null, folderPath = null) {
  if (!gcs) {
    throw new Error("Google Cloud Storage is not initialized");
  }
  const storageFactory = StorageFactory.getInstance();
  const gcsProvider = storageFactory.getGCSProvider();
  if (!gcsProvider) {
    throw new Error("GCS provider not available");
  }
  return await gcsProvider.uploadStream(context, encodedFilename, file, contentType, folderPath);
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
  fields = null, // Optional fields from form data (for contextId)
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
        null, // containerName ignored
      );
    storagePromises.push(
      primaryPromise.then((result) => {
        context.log("Primary storage upload completed");
        // Handle both old format (string URL) and new format (object with url and shortLivedUrl)
        const url = typeof result === 'string' ? result : (result.url || result);
        const shortLivedUrl = result.shortLivedUrl || url;
        return { url, shortLivedUrl, type: "primary" };
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
    // Note: filename parameter here is the uploadName (generated short ID), not the original
    // For local file path uploads, we don't have the original filename, so originalFilename will be undefined
    const result = {
      message: `File '${uploadName}' ${saveToLocal ? "saved to folder" : "uploaded"} successfully.`,
      filename: uploadName,
      ...results.reduce((acc, item) => {
        if (item.type === "primary") {
          acc.url = item.url;
          acc.shortLivedUrl = item.shortLivedUrl || item.url;
        }
        if (item.type === "gcs") acc.gcs = ensureUnencodedGcsUrl(item.gcs);
        return acc;
      }, {}),
    };

    if (hash) {
      result.hash = hash;
    }
    
    // Store MIME type determined from filename (used by Cortex for file type detection)
    const mimeType = mime.lookup(uploadName) || 'application/octet-stream';
    result.mimeType = mimeType;
    
    // Extract contextId from form fields if present (only available for multipart uploads)
    if (fields && fields.contextId) {
      result.contextId = fields.contextId;
    }
    
    // Container parameter is ignored - always uses default container from env var
    
    // Ensure shortLivedUrl is always present
    if (!result.shortLivedUrl && result.url) {
      result.shortLivedUrl = result.url;
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
              null,
              null,
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

          // Generate shortLivedUrl for converted file
          const convertedShortLivedUrl = await generateShortLivedUrlForConvertedFile(
            context,
            convertedSaveResult.url
          );

          // Determine MIME type of converted file from its URL
          const convertedMimeType = getMimeTypeFromUrl(convertedSaveResult.url);

          // Add converted file info to result
          result.converted = {
            url: convertedSaveResult.url,
            shortLivedUrl: convertedShortLivedUrl,
            gcs: convertedGcsUrl,
            mimeType: convertedMimeType,
          };
          
          // Note: result.shortLivedUrl remains pointing to the original file
          // result.converted.shortLivedUrl points to the converted file
          // Both are available for different use cases
          
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
        // Container parameter is ignored - always uses default container from env var
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
// Container parameter is ignored - always uses default container from env var
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
  const storageService = new StorageService();
  return storageService.ensureGCSUpload(context, existingFile);
}

async function uploadChunkToGCS(chunkPath, requestId, filename = null, folderPath = null) {
  if (!gcs) return null;
  let gcsFileName;
  if (folderPath) {
    // Store in the same folder structure as the original file
    const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, '');
    const name = filename || path.basename(chunkPath);
    gcsFileName = normalizedFolder ? `${normalizedFolder}/${name}` : name;
  } else {
    const dirName = requestId || uuidv4();
    // Use provided filename or generate LLM-friendly naming
    if (filename) {
      gcsFileName = `${dirName}/${filename}`;
    } else {
      const fileExtension = path.extname(chunkPath);
      const shortId = generateShortId();
      gcsFileName = `${dirName}/${shortId}${fileExtension}`;
    }
  }
  await gcs
    .bucket(GCS_BUCKETNAME)
    .upload(chunkPath, { destination: gcsFileName });
  return `gs://${GCS_BUCKETNAME}/${gcsFileName}`;
}

export {
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
  getMimeTypeFromUrl,
  constructFolderPath,
  sanitizeSubPath,
  getScopedLogicalContextId,
  getScopedContainerOwnerId,
  // Re-export container constants
  getDefaultContainerName,
  getUserContainerName,
  GCS_BUCKETNAME,
  AZURE_STORAGE_CONTAINER_NAME,
};
