import logger from "./logger.js";
import stream from 'stream';
import os from 'os';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import { axios } from './requestExecutor.js';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import xxhash from 'xxhash-wasm';
import mime from 'mime-types';

const pipeline = promisify(stream.pipeline);
const MEDIA_API_URL = config.get('whisperMediaApiUrl');

// Cache xxhash instance for reuse
let xxhashInstance = null;
let xxhashInitPromise = null;

/**
 * Get or initialize xxhash instance (reused for performance)
 * Thread-safe initialization to prevent race conditions in high-volume scenarios
 * @returns {Promise<Object>} xxhash instance
 */
async function getXXHashInstance() {
    // If already initialized, return immediately
    if (xxhashInstance) {
        return xxhashInstance;
    }
    
    // If initialization is in progress, wait for it
    if (xxhashInitPromise) {
        return await xxhashInitPromise;
    }
    
    // Start initialization (only one will execute)
    xxhashInitPromise = (async () => {
        try {
            const instance = await xxhash();
            xxhashInstance = instance;
            return instance;
        } finally {
            // Clear the promise so we can retry if initialization fails
            xxhashInitPromise = null;
        }
    })();
    
    return await xxhashInitPromise;
}

/**
 * Compute xxhash64 hash of a file (super fast hash for file deduplication)
 * Uses xxhash64 to match the hash format used in labeeb and cortex file handler
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} xxhash64 hash in hex format
 */
async function computeFileHash(filePath) {
    const hasher = await getXXHashInstance();
    
    return new Promise((resolve, reject) => {
        // Create a new xxh64 instance for this file to avoid concurrency issues
        const xxh64 = hasher.create64();
        const stream = fs.createReadStream(filePath);
        
        stream.on('data', (data) => xxh64.update(data));
        stream.on('end', () => resolve(xxh64.digest().toString(16)));
        stream.on('error', (error) => reject(error));
    });
}

/**
 * Compute xxhash64 hash of a buffer
 * @param {Buffer} buffer - Buffer to hash
 * @returns {Promise<string>} xxhash64 hash in hex format
 */
async function computeBufferHash(buffer) {
    const hasher = await getXXHashInstance();
    const xxh64 = hasher.create64();
    xxh64.update(buffer);
    return xxh64.digest().toString(16);
}

/**
 * Fetch/load a file from URL via file handler
 * Downloads file from URL, processes it, and returns the result
 * @param {string} fileUrl - URL of file to fetch
 * @param {string} requestId - Request ID for tracking
 * @param {string|null} contextId - Optional context ID for scoped file storage
 * @param {boolean} save - Whether to save the file (default: false)
 * @returns {Promise<Object>} Response data with file information
 */
async function fetchFileFromUrl(fileUrl, requestId, contextId = null, save = false) {
    const fileHandlerUrl = MEDIA_API_URL;
    if (!fileHandlerUrl || fileHandlerUrl === 'null') {
        throw new Error('File handler URL is not configured');
    }

    const url = buildFileHandlerUrl(fileHandlerUrl, {
        fetch: fileUrl,
        requestId,
        ...(contextId ? { contextId } : {}),
        ...(save ? { save: true } : {})
    });

    const response = await axios.get(url, { timeout: 60000 });
    
    if (!response.data?.url && !Array.isArray(response.data)) {
        throw new Error("File handler did not return valid data");
    }

    return response.data;
}

/**
 * Build a file handler URL with query parameters
 * Handles separator detection (? vs &) and parameter encoding
 * @param {string} baseUrl - Base file handler URL
 * @param {Object} params - Query parameters as key-value pairs (null/undefined values are skipped)
 * @returns {string} Complete URL with query parameters
 */
function buildFileHandlerUrl(baseUrl, params = {}) {
    if (!baseUrl) {
        throw new Error('baseUrl is required');
    }
    
    const separator = baseUrl.includes('?') ? '&' : '?';
    const queryParams = [];
    
    Object.entries(params).forEach(([key, value]) => {
        if (value != null && value !== '') {
            queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
    });
    
    if (queryParams.length === 0) {
        return baseUrl;
    }
    
    return `${baseUrl}${separator}${queryParams.join('&')}`;
}

async function deleteTempPath(path) {
    try {
        if (!path) {
            logger.warn('Temporary path is not defined.');
            return;
        }
        if (!fs.existsSync(path)) {
            logger.warn(`Temporary path ${path} does not exist.`);
            return;
        }
        const stats = fs.statSync(path);
        if (stats.isFile()) {
            fs.unlinkSync(path);
            logger.info(`Temporary file ${path} deleted successfully.`);
        } else if (stats.isDirectory()) {
            fs.rmSync(path, { recursive: true });
            logger.info(`Temporary folder ${path} and its contents deleted successfully.`);
        }
    } catch (err) {
        logger.error(`Error occurred while deleting the temporary path: ${err}`);
    }
}

function generateUniqueFilename(extension) {
    return `${uuidv4()}.${extension}`;
}

const downloadFile = async (fileUrl) => {
    const urlObj = new URL(fileUrl);
    const pathname = urlObj.pathname;
    const fileExtension = path.extname(pathname).slice(1) || 'bin';
    const uniqueFilename = generateUniqueFilename(fileExtension);
    const tempDir = os.tmpdir();
    const localFilePath = `${tempDir}/${uniqueFilename}`;

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
        try {
            const parsedUrl = new URL(fileUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const response = await new Promise((resolve, reject) => {
                protocol.get(parsedUrl, (res) => {
                    if (res.statusCode === 200) {
                        resolve(res);
                    } else {
                        reject(new Error(`HTTP request failed with status code ${res.statusCode}`));
                    }
                }).on('error', reject);
            });

            await pipeline(response, fs.createWriteStream(localFilePath));
            logger.info(`Downloaded file to ${localFilePath}`);
            resolve(localFilePath);
        } catch (error) {
            fs.unlink(localFilePath, () => {
                reject(error);
            });
            //throw error;
        }
    });
};

/**
 * Get media chunks from file handler (for chunked media files)
 * @param {string} file - File URL or URI
 * @param {string} requestId - Request ID for tracking
 * @param {string|null} contextId - Optional context ID for scoped file storage
 * @returns {Promise<Array>} Array of chunk URLs
 */
async function getMediaChunks(file, requestId, contextId = null) {
    try {
        if (MEDIA_API_URL) {
            const url = buildFileHandlerUrl(MEDIA_API_URL, {
                uri: file,
                requestId,
                ...(contextId ? { contextId } : {})
            });
            const res = await axios.get(url, { timeout: 30000 });
            return res.data;
        } else {
            logger.info(`No API_URL set, returning file as chunk`);
            return [file];
        }
    } catch (err) {
        logger.error(`Error getting media chunks list from api: ${err}`);
        throw err;
    }
}

/**
 * Mark a request as completed for cleanup in file handler
 * @param {string} requestId - Request ID to mark as completed
 * @param {string|null} contextId - Optional context ID for scoped file storage
 * @returns {Promise<Object|null>} Response data or null
 */
async function markCompletedForCleanUp(requestId, contextId = null) {
    try {
        if (MEDIA_API_URL) {
            const url = buildFileHandlerUrl(MEDIA_API_URL, {
                requestId,
                ...(contextId ? { contextId } : {})
            });
            const res = await axios.delete(url, { timeout: 15000 });
            logger.info(`Marked request ${requestId} as completed: ${JSON.stringify(res.data)}`);
            return res.data;
        }
    } catch (err) {
        logger.error(`Error marking request ${requestId} as completed: ${err}`);
    }
    return null;
}

/**
 * Delete a file from cloud storage by hash
 * @param {string} hash - File hash to delete
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @param {string|null} contextId - Optional but strongly recommended context id for scoped hashes
 * @returns {Promise<boolean>} True if file was deleted, false if not found or error
 */
async function deleteFileByHash(hash, pathwayResolver = null, contextId = null) {
    if (!hash || typeof hash !== 'string') {
        logger.warn('deleteFileByHash: hash is required and must be a string');
        return false;
    }

    const fileHandlerUrl = MEDIA_API_URL;
    if (!fileHandlerUrl) {
        logger.warn('deleteFileByHash: WHISPER_MEDIA_API_URL is not set, cannot delete file');
        return false;
    }

    try {
        const deleteUrl = buildFileHandlerUrl(fileHandlerUrl, {
            hash,
            ...(contextId ? { contextId } : {})
        });
        
        const response = await axios.delete(deleteUrl, {
            validateStatus: (status) => status >= 200 && status < 500, // Accept 200-499 as valid responses
            timeout: 30000
        });

        if (response.status === 200) {
            logger.info(`Successfully deleted file with hash ${hash}`);
            return true;
        } else if (response.status === 404) {
            logger.info(`File with hash ${hash} not found (may have already been deleted)`);
            return false; // Not an error - file doesn't exist
        } else {
            logger.warn(`Unexpected status ${response.status} when deleting file with hash ${hash}`);
            return false;
        }
    } catch (error) {
        // If it's a 404, that's fine - file doesn't exist
        if (error?.response?.status === 404) {
            logger.info(`File with hash ${hash} not found during deletion (may have already been deleted)`);
            return false;
        }
        
        // Log other errors but don't throw - deletion failure shouldn't block modification
        const errorMsg = error?.message || String(error);
        logger.warn(`Error deleting file with hash ${hash}: ${errorMsg}`);
        return false;
    }
}

// Helper function to extract file metadata from a content object
// Returns normalized format with url and gcs (for file collection storage)
function extractFileMetadataFromContent(contentObj) {
    const files = [];
    
    if (contentObj.type === 'image_url' && contentObj.image_url?.url) {
        files.push({
            url: contentObj.image_url.url,
            gcs: contentObj.gcs || null,
            filename: contentObj.originalFilename || contentObj.name || contentObj.filename || null,
            hash: contentObj.hash || null,
            type: 'image_url'
        });
    } else if (contentObj.type === 'file' && contentObj.url) {
        files.push({
            url: contentObj.url,
            gcs: contentObj.gcs || null,
            filename: contentObj.originalFilename || contentObj.name || contentObj.filename || null,
            hash: contentObj.hash || null,
            type: 'file'
        });
    } else if (contentObj.url && (contentObj.type === 'image_url' || !contentObj.type)) {
        // Handle direct URL objects
        files.push({
            url: contentObj.url,
            gcs: contentObj.gcs || null,
            filename: contentObj.originalFilename || contentObj.name || contentObj.filename || null,
            hash: contentObj.hash || null,
            type: contentObj.type || 'file'
        });
    }
    
    return files;
}

// Cache for file collections during a request lifecycle
const fileCollectionCache = new Map();
const CACHE_TTL = 5000; // 5 seconds

/**
 * Generate a unique version string with timestamp + random component
 * This handles clock skew by ensuring uniqueness even when timestamps collide
 * @returns {string} Version string in format: "timestamp-random"
 */
function generateVersion() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${random}`;
}

/**
 * Get cache key for file collection
 */
function getCollectionCacheKey(contextId, contextKey) {
    // Use memoryFiles section key for cache
    return `${contextId}-memoryFiles-${contextKey || 'default'}`;
}

/**
 * Extract files from chat history
 * @param {Array} chatHistory - Chat history to scan
 * @returns {Array} Array of file metadata objects
 */
function extractFilesFromChatHistory(chatHistory) {
    if (!chatHistory || !Array.isArray(chatHistory)) {
        return [];
    }

    const extractedFiles = [];
    for (const message of chatHistory) {
        if (!message || !message.content) {
            continue;
        }
        
        // Handle array content
        if (Array.isArray(message.content)) {
            for (const content of message.content) {
                try {
                    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
                    extractedFiles.push(...extractFileMetadataFromContent(contentObj));
                } catch (e) {
                    // Not JSON or couldn't be parsed, continue
                    continue;
                }
            }
        }
        // Handle string content
        else if (typeof message.content === 'string') {
            try {
                const contentObj = JSON.parse(message.content);
                extractedFiles.push(...extractFileMetadataFromContent(contentObj));
            } catch (e) {
                // Not JSON or couldn't be parsed, continue
                continue;
            }
        }
        // Handle object content
        else if (typeof message.content === 'object') {
            extractedFiles.push(...extractFileMetadataFromContent(message.content));
        }
    }

    return extractedFiles;
}

/**
 * Load file collection from memory system or cache
 * Returns both the collection data and version for optimistic locking
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {boolean} useCache - Whether to check cache first (default: true)
 * @returns {Promise<{files: Array, version: string}>} File collection with version
 */
async function loadFileCollectionWithVersion(contextId, contextKey = null, useCache = true) {
    if (!contextId) {
        return { files: [], version: generateVersion() };
    }

    const cacheKey = getCollectionCacheKey(contextId, contextKey);

    // Check cache first
    if (useCache && fileCollectionCache.has(cacheKey)) {
        const cached = fileCollectionCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return { files: cached.collection, version: cached.version || generateVersion() };
        }
    }

    // Load from memory system
    const { callPathway } = await import('./pathwayTools.js');
    let files = [];
    let version = generateVersion();
    
    try {
        const memoryContent = await callPathway('sys_read_memory', { 
            contextId, 
            section: 'memoryFiles',
            contextKey 
        });
        if (memoryContent) {
            const parsed = JSON.parse(memoryContent);
            
            // Handle new format: { version, files }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.files) {
                files = Array.isArray(parsed.files) ? parsed.files : [];
                version = parsed.version || generateVersion();
            }
            // Handle old format: just an array (backward compatibility)
            else if (Array.isArray(parsed)) {
                files = parsed;
                version = generateVersion(); // Assign new version for migration
            }
            // Invalid format
            else {
                files = [];
                version = generateVersion();
            }
        }
    } catch (e) {
        // Collection doesn't exist yet, start with empty array
        files = [];
        version = generateVersion();
    }

    // Update cache
    fileCollectionCache.set(cacheKey, {
        collection: files,
        version: version,
        timestamp: Date.now()
    });

    return { files, version };
}

/**
 * Load file collection from memory system or cache
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {boolean} useCache - Whether to check cache first (default: true)
 * @returns {Promise<Array>} File collection array
 */
async function loadFileCollection(contextId, contextKey = null, useCache = true) {
    const { files } = await loadFileCollectionWithVersion(contextId, contextKey, useCache);
    return files;
}

/**
 * Save file collection to memory system with version checking
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {Array} collection - File collection array
 * @param {string} expectedVersion - Expected version for optimistic locking (if provided)
 * @returns {Promise<boolean>} True if save succeeded, false if version mismatch
 */
async function saveFileCollectionWithVersion(contextId, contextKey, collection, expectedVersion = null) {
    const cacheKey = getCollectionCacheKey(contextId, contextKey);
    const newVersion = generateVersion();

    try {
        const { callPathway } = await import('./pathwayTools.js');
        
        // If expectedVersion is provided, verify it matches RIGHT before saving
        // This minimizes the race condition window
        if (expectedVersion !== null) {
            // Read directly from memory (bypass cache) to get the absolute latest version
            const memoryContent = await callPathway('sys_read_memory', { 
                contextId, 
                section: 'memoryFiles',
                contextKey 
            });
            
            let currentVersion = null;
            let collectionExists = false;
            let isOldFormat = false;
            
            if (memoryContent && memoryContent.trim() !== '' && memoryContent.trim() !== '[]') {
                collectionExists = true;
                try {
                    const parsed = JSON.parse(memoryContent);
                    // Handle new format: { version, files }
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version) {
                        currentVersion = parsed.version;
                    }
                    // Handle old format: just an array (no version yet)
                    else if (Array.isArray(parsed)) {
                        // Old format - we'll allow migration if the content matches
                        isOldFormat = true;
                        currentVersion = null;
                    }
                } catch (e) {
                    // Invalid format - treat as version mismatch
                    currentVersion = null;
                }
            }
            
            // If collection doesn't exist yet (empty memoryContent or just "[]"), allow the save
            // since there's nothing to conflict with. The version check is only needed
            // when there's an existing collection that might have been modified.
            // Also allow save if we're migrating from old format (isOldFormat) - the migration
            // will happen on the next load, so we allow this save to proceed.
            if (collectionExists && !isOldFormat && currentVersion !== expectedVersion) {
                // Version mismatch - return false to trigger retry
                return false;
            }
        }
        
        // Save with version (minimal window between check and save)
        const collectionData = {
            version: newVersion,
            files: collection
        };
        
        await callPathway('sys_save_memory', { 
            contextId, 
            section: 'memoryFiles',
            aiMemory: JSON.stringify(collectionData),
            contextKey 
        });

        // Update cache
        fileCollectionCache.set(cacheKey, {
            collection,
            version: newVersion,
            timestamp: Date.now()
        });
        
        return true;
    } catch (e) {
        // Log but don't fail - collection update is best effort
        const logger = (await import('./logger.js')).default;
        logger.warn(`Failed to save file collection: ${e.message}`);
        return false;
    }
}

/**
 * Save file collection to memory system
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {Array} collection - File collection array
 */
async function saveFileCollection(contextId, contextKey, collection) {
    await saveFileCollectionWithVersion(contextId, contextKey, collection, null);
}

/**
 * Modify file collection with optimistic locking and automatic retries
 * This is the main function that all modify operations should use to ensure concurrency safety
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {Function} modifierCallback - Callback function that modifies the collection array
 *   The callback receives (collection) and should return the modified collection array
 * @param {number} maxRetries - Maximum number of retry attempts (default: 5)
 * @returns {Promise<Array>} The final modified collection array
 */
async function modifyFileCollectionWithLock(contextId, contextKey, modifierCallback, maxRetries = 5) {
    if (!contextId) {
        throw new Error("contextId is required");
    }
    
    if (typeof modifierCallback !== 'function') {
        throw new Error("modifierCallback must be a function");
    }
    
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Load collection with version (skip cache to get latest version)
            const { files, version } = await loadFileCollectionWithVersion(contextId, contextKey, false);
            
            // Create a copy to avoid mutating the original
            const collectionCopy = [...files];
            
            // Execute the modifier callback
            const modifiedCollection = await modifierCallback(collectionCopy);
            
            // Validate that callback returned an array
            if (!Array.isArray(modifiedCollection)) {
                throw new Error("modifierCallback must return an array");
            }
            
            // Try to save with version check
            const saved = await saveFileCollectionWithVersion(contextId, contextKey, modifiedCollection, version);
            
            if (saved) {
                // Success! Return the modified collection
                return modifiedCollection;
            }
            
            // Version mismatch - will retry on next iteration
            // Add a small delay to reduce contention (exponential backoff)
            if (attempt < maxRetries - 1) {
                const delay = Math.min(10 * Math.pow(2, attempt), 100); // Max 100ms
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } catch (error) {
            lastError = error;
            // For non-version-mismatch errors, we might want to retry or fail immediately
            // For now, we'll retry a few times then throw
            if (attempt === maxRetries - 1) {
                throw error;
            }
            // Small delay before retry
            const delay = Math.min(10 * Math.pow(2, attempt), 100);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // If we get here, all retries failed due to version mismatches
    throw new Error(`Failed to modify file collection after ${maxRetries} attempts due to concurrent modifications`);
}

/**
 * Add a file to the file collection
 * If fileUrl is provided and is not already a cloud URL, it will be uploaded first
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {string} url - Cloud storage URL (Azure URL) - if fileUrl is provided, this can be null
 * @param {string} gcs - Optional Google Cloud Storage URL
 * @param {string} filename - Filename or title for the file
 * @param {Array<string>} tags - Optional array of tags
 * @param {string} notes - Optional notes or description
 * @param {string} hash - Optional file hash
 * @param {string} fileUrl - Optional: URL of file to upload (if not already in cloud storage)
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @returns {Promise<Object>} File entry object with id
 */
async function addFileToCollection(contextId, contextKey, url, gcs, filename, tags = [], notes = '', hash = null, fileUrl = null, pathwayResolver = null, permanent = false) {
    if (!contextId || !filename) {
        throw new Error("contextId and filename are required");
    }

    // If permanent=true, set retention=permanent to keep file forever
    const desiredRetention = permanent ? 'permanent' : 'temporary';

    // If fileUrl is provided and url is not already a cloud URL, upload the file first
    let finalUrl = url;
    let finalGcs = gcs;
    let finalHash = hash;
    
    if (fileUrl && (!url || (!url.includes('blob.core.windows.net') && !url.includes('storage.googleapis.com')))) {
        // Upload the file from the URL
        // uploadFileToCloud will download it, compute hash, check if it exists, and upload if needed
        // It uploads the local file stream, not the URL, to avoid triggering remoteFile fetch
        const uploadResult = await uploadFileToCloud(fileUrl, null, filename, pathwayResolver, contextId);
        finalUrl = uploadResult.url;
        finalGcs = uploadResult.gcs;
        finalHash = uploadResult.hash || hash;
    }

    // If the caller asked for permanence/privacy and we have a hash, update retention (best-effort)
    if (finalHash && desiredRetention === 'permanent') {
        try {
            await setRetentionForHash(finalHash, desiredRetention, contextId, pathwayResolver);
        } catch (e) {
            const msg = `Failed to set retention=${desiredRetention} for hash ${finalHash}: ${e?.message || String(e)}`;
            if (pathwayResolver?.logWarning) pathwayResolver.logWarning(msg);
            else logger.warn(msg);
        }
    }
    
    if (!finalUrl) {
        throw new Error("url or fileUrl is required");
    }

    // Determine MIME type from URL (preferring converted URL if available)
    const mimeType = determineMimeTypeFromUrl(finalUrl, finalGcs, filename);
    
    // Ensure filename has correct extension based on MIME type
    const correctedFilename = ensureFilenameExtension(filename, mimeType);

    // Create file entry (before locking to avoid recreating on retry)
    const fileEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        url: finalUrl,
        gcs: finalGcs || null,
        filename: correctedFilename,
        mimeType: mimeType,
        tags: Array.isArray(tags) ? tags : [],
        notes: notes || '',
        hash: finalHash || null,
        permanent: permanent,
        addedDate: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
    };

    // Use optimistic locking to add file to collection
    await modifyFileCollectionWithLock(contextId, contextKey, (collection) => {
        collection.push(fileEntry);
        return collection;
    });

    return fileEntry;
}

/**
 * Extract filename from URL (preferring GCS URL if available, otherwise Azure URL)
 * @param {string} url - Azure URL
 * @param {string} gcs - Optional GCS URL
 * @returns {string} Filename extracted from URL
 */
function extractFilenameFromUrl(url, gcs = null) {
    // Prefer GCS URL if available, otherwise use Azure URL
    const urlToUse = gcs || url;
    if (!urlToUse) {
        return null;
    }
    
    try {
        // Use URL API for proper parsing (handles query params, fragments, etc.)
        const urlObj = new URL(urlToUse);
        // Extract filename from pathname (last segment)
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        return filename || null;
    } catch (e) {
        // If URL parsing fails (e.g., GCS URLs like gs://bucket/file.pdf), fall back to string splitting
        // Extract filename from URL, removing query parameters
        return urlToUse.split('/').pop().split('?')[0];
    }
}

/**
 * Ensure filename has the correct extension based on MIME type
 * @param {string} filename - Current filename (may be null)
 * @param {string} mimeType - MIME type to use for extension
 * @returns {string} Filename with correct extension, or null if no filename/mimeType
 */
function ensureFilenameExtension(filename, mimeType) {
    if (!mimeType || mimeType === 'application/octet-stream') {
        // If no MIME type or generic binary, return filename as-is
        return filename || null;
    }
    
    // Get the correct extension for this MIME type
    const correctExtension = mime.extension(mimeType);
    if (!correctExtension || correctExtension === 'bin') {
        // If we can't determine extension from MIME type, return filename as-is
        return filename || null;
    }
    
    // Normalize extension (handle common cases where multiple extensions map to same MIME type)
    let normalizedExtension = correctExtension;
    if (correctExtension === 'markdown') {
        normalizedExtension = 'md';
    } else if (correctExtension === 'jpeg') {
        // Prefer 'jpg' over 'jpeg' for consistency
        normalizedExtension = 'jpg';
    }
    const extensionWithDot = '.' + normalizedExtension;
    
    if (!filename || filename === '') {
        // No filename provided - return null (don't generate one)
        return null;
    }
    
    // Get base name and current extension
    const parsed = path.parse(filename);
    const currentExtension = parsed.ext.toLowerCase();
    const correctExtensionLower = extensionWithDot.toLowerCase();
    
    // If extension already matches, return as-is
    if (currentExtension === correctExtensionLower) {
        return filename;
    }
    
    // Replace extension with correct one
    return parsed.name + extensionWithDot;
}

/**
 * Determine MIME type from URL or filename
 * Prefers converted URL (actual file type) over original URL
 * @param {string} url - Azure URL (may be converted URL)
 * @param {string} gcs - Optional GCS URL (may be converted URL)
 * @param {string} filename - Optional filename as fallback
 * @returns {string} MIME type
 */
function determineMimeTypeFromUrl(url, gcs = null, filename = null) {
    // Prefer GCS URL if available (often has converted file)
    const urlToUse = gcs || url;
    
    if (urlToUse) {
        const urlFilename = extractFilenameFromUrl(urlToUse);
        if (urlFilename) {
            const mimeType = getMimeTypeFromFilename(urlFilename);
            if (mimeType !== 'application/octet-stream') {
                return mimeType;
            }
        }
    }
    
    // Fallback to filename if URL didn't give us a good MIME type
    if (filename) {
        return getMimeTypeFromFilename(filename);
    }
    
    return 'application/octet-stream';
}


/**
 * Sync files from chat history to file collection
 * @param {Array} chatHistory - Chat history to scan
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @returns {Promise<Array>} Array of file metadata objects
 */
async function syncFilesToCollection(chatHistory, contextId, contextKey = null) {
    if (!chatHistory || !Array.isArray(chatHistory) || !contextId) {
        return [];
    }

    // Extract all files from chat history
    const extractedFiles = extractFilesFromChatHistory(chatHistory);

    if (extractedFiles.length === 0) {
        // No new files to add, return existing collection
        return await loadFileCollection(contextId, contextKey, true);
    }

    // Use optimistic locking to sync files
    const collection = await modifyFileCollectionWithLock(contextId, contextKey, (collection) => {
        // Create a map of existing files by URL and hash for fast lookup
        const existingFilesMap = new Map();
        collection.forEach(file => {
            if (file.url) {
                existingFilesMap.set(file.url, file);
            }
            if (file.gcs) {
                existingFilesMap.set(file.gcs, file);
            }
            if (file.hash) {
                existingFilesMap.set(`hash:${file.hash}`, file);
            }
        });

        // Add new files that aren't already in the collection
        for (const file of extractedFiles) {
            // Check if file already exists by URL or hash
            const existsByUrl = file.url && existingFilesMap.has(file.url);
            const existsByGcs = file.gcs && existingFilesMap.has(file.gcs);
            const existsByHash = file.hash && existingFilesMap.has(`hash:${file.hash}`);
            
            if (!existsByUrl && !existsByGcs && !existsByHash) {
                // New file - add to collection
                // Determine MIME type from URL (preferring converted URL if available)
                const mimeType = determineMimeTypeFromUrl(file.url, file.gcs, file.filename);
                
                // Ensure filename has correct extension based on MIME type
                const correctedFilename = ensureFilenameExtension(file.filename, mimeType);
                
                const fileEntry = {
                    id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                    url: file.url,
                    gcs: file.gcs || null,
                    filename: correctedFilename,
                    mimeType: mimeType,
                    hash: file.hash || null,
                    type: file.type || 'file',
                    addedDate: new Date().toISOString(),
                    lastAccessed: new Date().toISOString()
                };
                
                collection.push(fileEntry);
                existingFilesMap.set(file.url, fileEntry);
                if (file.gcs) {
                    existingFilesMap.set(file.gcs, fileEntry);
                }
                if (file.hash) {
                    existingFilesMap.set(`hash:${file.hash}`, fileEntry);
                }
            } else {
                // File exists - update lastAccessed and merge URLs if needed
                const existingFile = existsByUrl ? existingFilesMap.get(file.url) :
                                    existsByGcs ? existingFilesMap.get(file.gcs) :
                                    existingFilesMap.get(`hash:${file.hash}`);
                
                if (existingFile) {
                    existingFile.lastAccessed = new Date().toISOString();
                    
                    // Merge or update URLs
                    if (file.url && file.url !== existingFile.url) {
                        existingFile.url = file.url;
                    }
                    if (file.gcs && file.gcs !== existingFile.gcs) {
                        existingFile.gcs = file.gcs;
                    }
                    
                    // If MIME type is missing, determine it from current URLs
                    if (!existingFile.mimeType) {
                        existingFile.mimeType = determineMimeTypeFromUrl(existingFile.url, existingFile.gcs, existingFile.filename);
                    }
                    
                    // Update filename if provided, or ensure existing filename has correct extension
                    const filenameToUse = file.filename || existingFile.filename;
                    if (filenameToUse && existingFile.mimeType) {
                        existingFile.filename = ensureFilenameExtension(filenameToUse, existingFile.mimeType);
                    }
                    
                    if (file.hash && !existingFile.hash) {
                        existingFile.hash = file.hash;
                    }
                }
            }
        }

        return collection;
    });

    return collection;
}

/**
 * Get available files from file collection and format for template
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @returns {Promise<string>} Formatted string of available files
 */
async function getAvailableFilesFromCollection(contextId, contextKey = null) {
    if (!contextId) {
        return 'No files available.';
    }

    const collection = await loadFileCollection(contextId, contextKey, true);
    return formatFilesForTemplate(collection);
}

/**
 * Format file collection for template display
 * Shows the last 10 most recently used files in a compact one-line format
 * @param {Array} collection - File collection array
 * @returns {string} Formatted string
 */
function formatFilesForTemplate(collection) {
    if (!collection || collection.length === 0) {
        return 'No files available.';
    }

    // Sort by lastAccessed (most recent first), fallback to addedDate
    const sorted = [...collection].sort((a, b) => {
        const aDate = a.lastAccessed || a.addedDate || '';
        const bDate = b.lastAccessed || b.addedDate || '';
        return new Date(bDate) - new Date(aDate);
    });

    // Take only the last 10 most recently used files
    const recentFiles = sorted.slice(0, 10);
    const totalFiles = collection.length;
    const hasMore = totalFiles > 10;

    // Format as compact one line per file: hash | filename | url | date | tags
    const fileList = recentFiles.map((file) => {
        const hash = file.hash || '';
        const filename = file.filename || 'Unnamed file';
        const url = file.url || '';
        const dateAdded = file.addedDate 
            ? new Date(file.addedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
        const tags = Array.isArray(file.tags) && file.tags.length > 0 
            ? file.tags.join(',') 
            : '';
        return `${hash} | ${filename} | ${url} | ${dateAdded}${tags ? ' | ' + tags : ''}`;
    }).join('\n');

    let result = fileList;
    
    if (hasMore) {
        result += `\n(${totalFiles - 10} more file(s) available - use ListFileCollection or SearchFileCollection)`;
    }

    return result;
}

/**
 * Get available files - now async and works with file collection
 * @param {Array} chatHistory - Chat history to scan
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @returns {Promise<string>} Formatted string of available files
 */
async function getAvailableFiles(chatHistory, contextId, contextKey = null) {
    if (!contextId) {
        // Fallback to old behavior if no contextId
        const files = extractFilesFromChatHistory(chatHistory);
        return files.map(f => f.url).filter(Boolean).join('\n') || 'No files available.';
    }

    // Sync files from chat history to collection
    await syncFilesToCollection(chatHistory, contextId, contextKey);
    
    // Return formatted files from collection
    return await getAvailableFilesFromCollection(contextId, contextKey);
}

/**
 * Find a file in the collection by ID, URL, hash, or filename
 * First tries exact matches, then falls back to simple "contains" matches on filename, URL, and GCS
 * @param {string} fileParam - File ID, URL (Azure or GCS), hash, or filename
 * @param {Array} collection - File collection array
 * @returns {Object|null} File entry from collection, or null if not found
 */
function findFileInCollection(fileParam, collection) {
    if (!fileParam || typeof fileParam !== 'string' || !Array.isArray(collection)) {
        return null;
    }

    const trimmed = fileParam.trim();
    const normalizedParam = trimmed.toLowerCase();
    
    // Extract just the filename from parameter (in case it includes a path)
    const paramFilename = path.basename(normalizedParam);
    
    // First, try exact matches (case-sensitive for IDs, URLs, hashes)
    for (const file of collection) {
        // Check by ID
        if (file.id === trimmed) {
            return file;
        }
        
        // Check by hash
        if (file.hash === trimmed) {
            return file;
        }
        
        // Check by Azure URL (exact match)
        if (file.url === trimmed) {
            return file;
        }
        
        // Check by GCS URL (exact match)
        if (file.gcs === trimmed) {
            return file;
        }
        
        // Check by exact filename (case-insensitive, using basename)
        if (file.filename) {
            const normalizedFilename = file.filename.toLowerCase();
            const fileFilename = path.basename(normalizedFilename);
            if (fileFilename === paramFilename) {
                return file;
            }
        }
    }

    // If no exact match, try simple "contains" matches on filename, url, and gcs
    // Only match if parameter is at least 4 characters to avoid false matches
    if (normalizedParam.length >= 4) {
        for (const file of collection) {
            // Check if filename contains the parameter
            if (file.filename) {
                const normalizedFilename = file.filename.toLowerCase();
                if (normalizedFilename.includes(normalizedParam)) {
                    return file;
                }
            }
            
            // Check if URL contains the parameter
            if (file.url) {
                const normalizedUrl = file.url.toLowerCase();
                if (normalizedUrl.includes(normalizedParam)) {
                    return file;
                }
            }
            
            // Check if GCS URL contains the parameter
            if (file.gcs) {
                const normalizedGcs = file.gcs.toLowerCase();
                if (normalizedGcs.includes(normalizedParam)) {
                    return file;
                }
            }
        }
    }

    return null;
}

/**
 * Resolve a file parameter to a URL by looking it up in the file collection
 * If the parameter is already a URL (starts with http:// or https://), returns it as-is
 * If contextId is provided, looks up the file in the collection and returns its URL
 * @param {string} fileParam - File ID, URL (Azure or GCS), hash, or filename from collection
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {Object} options - Optional configuration
 * @param {boolean} options.preferGcs - If true, prefer GCS URL over Azure URL when available
 * @returns {Promise<string|null>} Resolved file URL, or null if not found
 */
export async function resolveFileParameter(fileParam, contextId, contextKey = null, options = {}) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    const trimmed = fileParam.trim();
    const { preferGcs = false } = options;

    // If no contextId, can't look up in collection - return null
    if (!contextId) {
        return null;
    }

    try {
        // Load file collection and find the file
        const collection = await loadFileCollection(contextId, contextKey, true);
        const foundFile = findFileInCollection(trimmed, collection);
        
        if (foundFile) {
            // If preferGcs is true and GCS URL is available, return it
            if (preferGcs && foundFile.gcs) {
                return foundFile.gcs;
            }
            // Otherwise return the regular URL (Azure)
            if (foundFile.url) {
                return foundFile.url;
            }
        }
        
        // File not found in collection
        return null;
    } catch (error) {
        // Log error but return null
        logger.warn(`Failed to resolve file parameter "${trimmed}": ${error.message}`);
        return null;
    }
}

/**
 * Generate file message content by looking up a file parameter in the file collection
 * @param {string} fileParam - File URL (Azure or GCS), file ID from collection, or file hash
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @returns {Promise<Object|null>} Content object in the format for chat history, or null if not found
 */
async function generateFileMessageContent(fileParam, contextId, contextKey = null) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    if (!contextId) {
        // Without contextId, we can't look up in collection
        // Return a basic content object from the URL
        return null;
    }

    // Load file collection
    const collection = await loadFileCollection(contextId, contextKey, true);

    // Find the file using shared matching logic
    const foundFile = findFileInCollection(fileParam, collection);

    if (!foundFile) {
        // File not found in collection, return null
        return null;
    }

    // Resolve to short-lived URL if possible
    // Note: contextId is not available in this function, so we pass null
    // This is acceptable as short-lived URLs work without contextId
    const fileWithShortLivedUrl = await ensureShortLivedUrl(foundFile, MEDIA_API_URL, null);

    return {
        type: 'image_url',
        url: fileWithShortLivedUrl.url,
        gcs: fileWithShortLivedUrl.gcs || null,
        originalFilename: fileWithShortLivedUrl.filename || null,
        hash: fileWithShortLivedUrl.hash || null
    };

}

/**
 * Inject a file into chat history as a content object
 * Only injects if the file is not already present in the chat history
 * @param {Array} chatHistory - Chat history array to modify
 * @param {Object} fileContent - Content object from generateFileMessageContent
 * @returns {Array} Modified chat history with file injected (or unchanged if already present)
 */
function injectFileIntoChatHistory(chatHistory, fileContent) {
    if (!chatHistory || !Array.isArray(chatHistory)) {
        return [{ role: 'user', content: [fileContent] }];
    }

    if (!fileContent) {
        return chatHistory;
    }

    // Extract URLs and hash from the file content to check for duplicates
    const fileUrl = fileContent.url || fileContent.image_url?.url;
    const fileGcs = fileContent.gcs;
    const fileHash = fileContent.hash;

    // Check if file already exists in chat history
    const existingFiles = extractFilesFromChatHistory(chatHistory);
    const fileAlreadyExists = existingFiles.some(existingFile => {
        // Check by URL (existingFile uses url from extractFileMetadataFromContent)
        if (fileUrl && existingFile.url === fileUrl) {
            return true;
        }
        // Check by GCS URL
        if (fileGcs && existingFile.gcs === fileGcs) {
            return true;
        }
        // Check by hash
        if (fileHash && existingFile.hash === fileHash) {
            return true;
        }
        return false;
    });

    // If file already exists, return chat history unchanged
    if (fileAlreadyExists) {
        return chatHistory;
    }

    // Create a new user message with the file content
    // Use OpenAI-compatible format: content is an array of objects (not JSON strings)
    const fileMessage = {
        role: 'user',
        content: [fileContent]
    };

    // Add to the end of chat history
    return [...chatHistory, fileMessage];
}

/**
 * Check if a file exists by hash using the file handler
 * Returns short-lived URL when available, with fallback to regular URL
 * @param {string} hash - File hash to check
 * @param {string} fileHandlerUrl - File handler service URL
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @param {string|null} contextId - Optional but strongly recommended context id for scoped hashes
 * @param {number} shortLivedMinutes - Optional duration for short-lived URL (default: 5)
 * @returns {Promise<Object|null>} {url, gcs, hash, filename} if file exists, null otherwise
 *   url: shortLivedUrl if available (prefers converted), otherwise regular URL
 *   gcs: GCS URL (prefers converted, no short-lived version for GCS)
 *   filename: Original filename from file handler (if available)
 */
async function checkHashExists(hash, fileHandlerUrl, pathwayResolver = null, contextId = null, shortLivedMinutes = 5) {
    if (!hash || !fileHandlerUrl) {
        return null;
    }
    
    try {
        const checkHashUrl = buildFileHandlerUrl(fileHandlerUrl, {
            hash,
            checkHash: true,
            ...(contextId ? { contextId } : {}),
            ...(shortLivedMinutes ? { shortLivedMinutes } : {})
        });
        
        const checkResponse = await axios.get(checkHashUrl, {
            timeout: 10000,
            validateStatus: (status) => status >= 200 && status < 500
        });
        
        // If file exists (200), return URLs with short-lived URL preferred
        if (checkResponse.status === 200 && checkResponse.data && checkResponse.data.url) {
            const data = checkResponse.data;
            // shortLivedUrl automatically prefers converted URL if it exists
            // Use shortLivedUrl if available, otherwise fall back to regular URL
            // For GCS, always use the GCS URL from checkHash (no short-lived for GCS)
            const url = data.shortLivedUrl || data.converted?.url || data.url;
            const gcs = data.converted?.gcs || data.gcs || null;
            
            return {
                url: url, // shortLivedUrl if available (prefers converted), otherwise regular URL
                gcs: gcs, // GCS URL (prefers converted, no short-lived version for GCS)
                hash: data.hash || hash,
                filename: data.filename || null // Include filename from response
            };
        }
        
        return null;
    } catch (checkError) {
        // If checkHash fails, log but don't throw - this is an optimization
        let errorMsg;
        if (checkError?.message) {
            errorMsg = checkError.message;
        } else if (checkError?.errors && Array.isArray(checkError.errors)) {
            // Handle AggregateError
            errorMsg = checkError.errors.map(e => e?.message || String(e)).join('; ');
        } else {
            errorMsg = String(checkError);
        }
        if (pathwayResolver && pathwayResolver.logWarning) {
            pathwayResolver.logWarning(`checkHash failed: ${errorMsg}`);
        }
        return null;
    }
}

/**
 * Central function to resolve a file object to use short-lived URL when available
 * This is the single point of logic for ensuring files sent to LLMs use short-lived URLs
 * @param {Object} fileObject - File object from collection (must have hash and url)
 * @param {string} fileHandlerUrl - File handler service URL
 * @param {number} shortLivedMinutes - Optional duration for short-lived URL (default: 5)
 * @returns {Promise<Object>} File object with url set to shortLivedUrl (or original if not available)
 */
async function ensureShortLivedUrl(fileObject, fileHandlerUrl, contextId = null, shortLivedMinutes = 5) {
    if (!fileObject || !fileObject.hash || !fileHandlerUrl) {
        // No hash or no file handler - return original object
        return fileObject;
    }
    
    try {
        const resolved = await checkHashExists(fileObject.hash, fileHandlerUrl, null, contextId, shortLivedMinutes);
        if (resolved && resolved.url) {
            // Return file object with url replaced by shortLivedUrl (or fallback to regular url)
            // GCS URL comes from checkHash (no short-lived version for GCS)
            // Preserve filename from original, but use resolved filename if original doesn't have one
            return {
                ...fileObject,
                url: resolved.url, // shortLivedUrl (or fallback)
                gcs: resolved.gcs || fileObject.gcs || null, // GCS from checkHash
                filename: fileObject.filename || resolved.filename || fileObject.filename // Preserve original, fallback to resolved
            };
        }
    } catch (error) {
        // If resolution fails, log but return original object
        logger.warn(`Failed to resolve short-lived URL for file ${fileObject.hash}: ${error.message}`);
    }
    
    // Fallback to original object if resolution fails
    return fileObject;
}

/**
 * Update a file's retention tag via cortex-file-handler (best-effort helper).
 * cortex-file-handler defaults uploads to retention=temporary; use this to set permanent retention.
 *
 * @param {string} hash
 * @param {'temporary'|'permanent'} retention
 * @param {string|null} contextId
 * @param {pathwayResolver|null} pathwayResolver
 */
/**
 * Set file retention (temporary or permanent) via file handler
 * @param {string} hash - File hash
 * @param {'temporary'|'permanent'} retention - Retention value
 * @param {string|null} contextId - Optional context ID for scoped file storage
 * @param {pathwayResolver|null} pathwayResolver - Optional pathway resolver for logging
 * @returns {Promise<Object|null>} Response data or null
 */
async function setRetentionForHash(hash, retention, contextId = null, pathwayResolver = null) {
    if (!hash || !retention) return null;
    const fileHandlerUrl = MEDIA_API_URL;
    if (!fileHandlerUrl || fileHandlerUrl === 'null') return null;

    const body = {
        hash,
        retention,
        setRetention: true,
        ...(contextId ? { contextId } : {})
    };

    try {
        const res = await axios.post(fileHandlerUrl, body, { timeout: 15000 });
        return res?.data || null;
    } catch (error) {
        const errorMsg = error?.message || String(error);
        if (pathwayResolver?.logWarning) {
            pathwayResolver.logWarning(`Failed to set retention=${retention} for hash ${hash}: ${errorMsg}`);
        } else {
            logger.warn(`Failed to set retention=${retention} for hash ${hash}: ${errorMsg}`);
        }
        return null;
    }
}

/**
 * Generic function to upload a file to cloud storage
 * Handles both URLs (downloads then uploads) and base64 data
 * Checks hash before uploading to avoid duplicates
 * @param {string|Buffer} fileInput - URL to download from, or base64 string, or Buffer
 * @param {string} mimeType - MIME type of the file (optional for URLs)
 * @param {string} filename - Optional filename (will be inferred if not provided)
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @param {string} contextId - Optional context ID for scoped file storage
 * @returns {Promise<Object>} {url, gcs, hash}
 */
async function uploadFileToCloud(fileInput, mimeType = null, filename = null, pathwayResolver = null, contextId = null) {
    let tempFilePath = null;
    let tempDir = null;
    let fileBuffer = null;
    let fileHash = null;
    
    try {
        const fileHandlerUrl = MEDIA_API_URL;
        if (!fileHandlerUrl) {
            throw new Error('WHISPER_MEDIA_API_URL is not set');
        }

        // Handle different input types
        if (typeof fileInput === 'string') {
            // Check if it's a URL or base64 data
            if (fileInput.startsWith('http://') || fileInput.startsWith('https://')) {
                // It's a URL (could be remote or cloud) - download it directly so we can compute the hash
                // Even if it's a cloud URL, we need to download it to compute hash and check if it exists
                // We'll upload the local file stream, not the URL, to avoid triggering remoteFile fetch
                // Download the file to a temporary location
                tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-upload-'));
                
                // Determine file extension from URL or filename
                let extension = 'bin';
                if (filename) {
                    extension = path.extname(filename).slice(1) || 'bin';
                } else {
                    try {
                        const urlObj = new URL(fileInput);
                        const pathname = urlObj.pathname;
                        extension = path.extname(pathname).slice(1) || 'bin';
                    } catch (e) {
                        // URL parsing failed, use default
                    }
                }
                
                const downloadFilename = filename || `download_${Date.now()}.${extension}`;
                tempFilePath = path.join(tempDir, downloadFilename);
                
                // Download the file directly using axios so we can compute hash
                const downloadResponse = await axios.get(fileInput, {
                    responseType: 'stream',
                    timeout: 60000,
                    validateStatus: (status) => status >= 200 && status < 400
                });
                
                if (downloadResponse.status !== 200) {
                    throw new Error(`Failed to download file: ${downloadResponse.status}`);
                }
                
                const writeStream = fs.createWriteStream(tempFilePath);
                await pipeline(downloadResponse.data, writeStream);
                
                // Read the downloaded file into buffer to compute hash
                fileBuffer = fs.readFileSync(tempFilePath);
            } else {
                // It's base64 data
                fileBuffer = Buffer.from(fileInput, 'base64');
            }
        } else if (Buffer.isBuffer(fileInput)) {
            fileBuffer = fileInput;
        } else {
            throw new Error('fileInput must be a URL string, base64 string, or Buffer');
        }

        // For buffer data, compute hash and check if file exists
        if (fileBuffer) {
            fileHash = await computeBufferHash(fileBuffer);
            
            // Check if file already exists using checkHash (context-scoped when possible)
            const existingFile = await checkHashExists(fileHash, fileHandlerUrl, pathwayResolver, contextId);
            if (existingFile) {
                return existingFile;
            }
            
            // File doesn't exist or checkHash failed - proceed with upload
            // If we don't already have a tempFilePath (from URL download), create one
            if (!tempFilePath) {
                // Determine file extension from mime type or filename
                let extension = 'bin';
                if (mimeType) {
                    extension = mimeType.split('/')[1] || 'bin';
                } else if (filename) {
                    extension = path.extname(filename).slice(1) || 'bin';
                }
                
                const uploadFilename = filename || `upload_${Date.now()}.${extension}`;
                
                // Create temporary file
                if (!tempDir) {
                    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-upload-'));
                }
                tempFilePath = path.join(tempDir, uploadFilename);
                
                // Write buffer to temp file
                fs.writeFileSync(tempFilePath, fileBuffer);
            }
            // If tempFilePath already exists (from URL download), we can use it directly
        }

        // Upload the file (only if we have buffer data and created tempFilePath)
        if (!tempFilePath) {
            throw new Error('No file to upload - tempFilePath not created');
        }
        
        const requestId = uuidv4();
        const formData = new FormData();
        formData.append('file', fs.createReadStream(tempFilePath), {
            filename: path.basename(tempFilePath),
            contentType: mimeType || 'application/octet-stream'
        });
        // Add hash for deduplication if we computed it
        if (fileHash) {
            formData.append('hash', fileHash);
        }
        // container is no longer supported; include contextId (recommended) for scoped hashes
        // contextId goes in formData body for POST requests, not in URL
        if (contextId) {
            formData.append('contextId', contextId);
        }
        
        // Build upload URL with requestId (contextId goes in formData body, not URL)
        const uploadUrl = buildFileHandlerUrl(fileHandlerUrl, {
            requestId
        });
        
        // Upload file
        const uploadResponse = await axios.post(uploadUrl, formData, {
            headers: {
                ...formData.getHeaders()
            },
            timeout: 30000
        });
        
        if (uploadResponse.data && uploadResponse.data.url) {
            // Return both url and gcs if available
            return {
                url: uploadResponse.data.url,
                gcs: uploadResponse.data.gcs || null,
                hash: uploadResponse.data.hash || fileHash
            };
        } else {
            throw new Error('No URL returned from file handler');
        }
        
    } catch (error) {
        let errorMsg;
        if (error?.message) {
            errorMsg = error.message;
        } else if (error?.errors && Array.isArray(error.errors)) {
            // Handle AggregateError
            errorMsg = error.errors.map(e => e?.message || String(e)).join('; ');
        } else {
            errorMsg = String(error);
        }
        const errorMessage = `Failed to upload file: ${errorMsg}`;
        if (pathwayResolver && pathwayResolver.logError) {
            pathwayResolver.logError(errorMessage);
        } else {
            logger.error(errorMessage);
        }
        throw error;
    } finally {
        // Clean up temp files - always runs regardless of success or failure
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                const warningMessage = `Failed to clean up temp directory: ${cleanupError.message}`;
                if (pathwayResolver && pathwayResolver.logWarning) {
                    pathwayResolver.logWarning(warningMessage);
                } else {
                    logger.warn(warningMessage);
                }
            }
        } else if (tempFilePath && fs.existsSync(tempFilePath)) {
            // Fallback: if tempDir doesn't exist but tempFilePath does, delete just the file
            try {
                fs.unlinkSync(tempFilePath);
            } catch (cleanupError) {
                const warningMessage = `Failed to clean up temp file: ${cleanupError.message}`;
                if (pathwayResolver && pathwayResolver.logWarning) {
                    pathwayResolver.logWarning(warningMessage);
                } else {
                    logger.warn(warningMessage);
                }
            }
        }
    }
}

// Helper function to upload base64 image data to cloud storage
// Now uses the generic uploadFileToCloud function
const uploadImageToCloud = async (base64Data, mimeType, pathwayResolver = null, contextId = null) => {
    return await uploadFileToCloud(base64Data, mimeType, null, pathwayResolver, contextId);
};

/**
 * Convert file hashes to content format suitable for LLM processing
 * @param {Array<string>} fileHashes - Array of file hashes to resolve
 * @param {Object} config - Configuration object with file service endpoints
 * @returns {Promise<Array<string>>} Array of stringified file content objects
 */
async function resolveFileHashesToContent(fileHashes, config, contextId = null) {
    if (!fileHashes || fileHashes.length === 0) return [];

    const fileContentPromises = fileHashes.map(async (hash) => {
        try {
            // Use the existing file handler (cortex-file-handler) to resolve file hashes
            const fileHandlerUrl = config?.get?.('whisperMediaApiUrl');
            
            if (fileHandlerUrl && fileHandlerUrl !== 'null') {
                // Use shared checkHashExists function - it returns shortLivedUrl, gcs, hash, and filename
                // This makes a single API call instead of two
                const existingFile = await checkHashExists(hash, fileHandlerUrl, null, contextId, 5);
                if (existingFile) {
                    // checkHashExists already returns:
                    // - shortLivedUrl (prefers converted) in url field
                    // - GCS URL (prefers converted) in gcs field
                    // - filename in filename field
                    return JSON.stringify({
                        type: "image_url",
                        url: existingFile.url, // Already has shortLivedUrl (prefers converted)
                        image_url: { url: existingFile.url },
                        gcs: existingFile.gcs || null, // GCS URL (prefers converted, no short-lived)
                        originalFilename: existingFile.filename || null, // Filename from single API call
                        hash: hash
                    });
                }
            }
            
            // Fallback: create a placeholder that indicates file resolution is needed
            return JSON.stringify({
                type: "file_hash",
                hash: hash,
                _cortex_needs_resolution: true
            });
        } catch (error) {
            // Return error indicator
            return JSON.stringify({
                type: "file_error",
                hash: hash,
                error: error.message
            });
        }
    });

    return Promise.all(fileContentPromises);
}

/**
 * Get MIME type from filename or file path
 * Uses the mime-types package for comprehensive MIME type detection
 * @param {string} filenameOrPath - Filename or full file path
 * @param {string} defaultMimeType - Optional default MIME type if detection fails (default: 'application/octet-stream')
 * @returns {string} MIME type string
 */
function getMimeTypeFromFilename(filenameOrPath, defaultMimeType = 'application/octet-stream') {
    if (!filenameOrPath) {
        return defaultMimeType;
    }
    
    // mime.lookup can handle both filenames and paths
    const mimeType = mime.lookup(filenameOrPath);
    return mimeType || defaultMimeType;
}

/**
 * Get MIME type from file extension
 * @param {string} extension - File extension (with or without leading dot, e.g., '.txt' or 'txt')
 * @param {string} defaultMimeType - Optional default MIME type if detection fails (default: 'application/octet-stream')
 * @returns {string} MIME type string
 */
function getMimeTypeFromExtension(extension, defaultMimeType = 'application/octet-stream') {
    if (!extension) {
        return defaultMimeType;
    }
    
    // Ensure extension starts with a dot for mime.lookup
    const normalizedExt = extension.startsWith('.') ? extension : `.${extension}`;
    const mimeType = mime.lookup(normalizedExt);
    return mimeType || defaultMimeType;
}

/**
 * Check if a MIME type represents a text-based file that can be read as text
 * @param {string} mimeType - MIME type to check
 * @returns {boolean} - Returns true if it's a text-based MIME type
 */
function isTextMimeType(mimeType) {
    if (!mimeType || typeof mimeType !== 'string') {
        return false;
    }
    
    // Extract base MIME type (remove charset and other parameters)
    // e.g., "application/json; charset=utf-8" -> "application/json"
    const baseMimeType = mimeType.split(';')[0].trim().toLowerCase();
    
    // All text/* types
    if (baseMimeType.startsWith('text/')) {
        return true;
    }
    
    // Text-based application types (consistent with sys_tool_writefile and sys_tool_editfile)
    const textApplicationTypes = [
        'application/json',
        'application/javascript',
        'application/x-javascript',
        'application/typescript',
        'application/xml',
        'application/x-yaml',
        'application/yaml',
        'application/x-python',
        'application/x-sh',
        'application/x-shellscript',
        'application/x-c',
        'application/x-c++',
        'application/x-cpp',
        'application/x-java',
        'application/x-go',
        'application/x-rust',
        'application/x-ruby',
        'application/x-php',
        'application/x-perl',
        'application/x-lua',
        'application/x-sql',
        'application/x-toml',
        'application/x-ini',
        'application/x-config',
    ];
    
    // Also check for common code file patterns in application types
    if (baseMimeType.startsWith('application/x-') || baseMimeType.startsWith('application/vnd.')) {
        // Check if it's a known text-based subtype
        const knownTextSubtypes = [
            'json', 'javascript', 'typescript', 'xml', 'yaml', 'python', 'sh', 'shellscript',
            'c', 'cpp', 'c++', 'java', 'go', 'rust', 'ruby', 'php', 'perl', 'lua', 'sql',
            'toml', 'ini', 'config', 'csv', 'tsv', 'plain', 'text', 'source', 'script'
        ];
        const subtype = baseMimeType.split('/').pop().split('+')[0];
        if (knownTextSubtypes.some(known => subtype.includes(known))) {
            return true;
        }
    }
    
    return textApplicationTypes.includes(baseMimeType);
}

export { 
    computeFileHash,
    computeBufferHash,
    deleteTempPath,
    deleteFileByHash,
    downloadFile,
    generateUniqueFilename,
    fetchFileFromUrl,
    getMediaChunks,
    markCompletedForCleanUp,
    extractFileMetadataFromContent,
    extractFilesFromChatHistory,
    syncFilesToCollection,
    getAvailableFilesFromCollection,
    formatFilesForTemplate,
    getAvailableFiles,
    findFileInCollection,
    // resolveFileParameter is exported inline above
    generateFileMessageContent,
    injectFileIntoChatHistory,
    addFileToCollection,
    loadFileCollection,
    saveFileCollection,
    modifyFileCollectionWithLock,
    checkHashExists,
    ensureShortLivedUrl,
    uploadFileToCloud,
    uploadImageToCloud,
    resolveFileHashesToContent,
    getMimeTypeFromFilename,
    getMimeTypeFromExtension,
    isTextMimeType,
    // Exported for testing
    extractFilenameFromUrl,
    ensureFilenameExtension,
    determineMimeTypeFromUrl
};

