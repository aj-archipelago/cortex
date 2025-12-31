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
import mimeDb from 'mime-db';
import { encrypt, decrypt } from './crypto.js';

const pipeline = promisify(stream.pipeline);
const MEDIA_API_URL = config.get('whisperMediaApiUrl');

/**
 * Check if a URL is a YouTube URL
 * Validates URL structure to ensure it's a valid YouTube video URL
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is a valid YouTube video URL
 */
export function isYoutubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const urlObj = new URL(url);

        // Check for standard youtube.com domains
        if (
            urlObj.hostname === "youtube.com" ||
            urlObj.hostname === "www.youtube.com"
        ) {
            // For standard watch URLs, verify they have a video ID
            if (urlObj.pathname === "/watch") {
                return !!urlObj.searchParams.get("v");
            }
            // For embed URLs, verify they have a video ID in the path
            if (urlObj.pathname.startsWith("/embed/")) {
                return urlObj.pathname.length > 7; // '/embed/' is 7 chars
            }
            // For shorts URLs, verify they have a video ID in the path
            if (urlObj.pathname.startsWith("/shorts/")) {
                return urlObj.pathname.length > 8; // '/shorts/' is 8 chars
            }
            return false;
        }

        // Check for shortened youtu.be domain
        if (urlObj.hostname === "youtu.be") {
            // Verify there's a video ID in the path
            return urlObj.pathname.length > 1; // '/' is 1 char
        }

        return false;
    } catch (err) {
        return false;
    }
}

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
// Note: displayFilename is not extracted from messages - it's set by CFH on upload,
// or by sys_update_file_metadata.js, or by file collection tools
function extractFileMetadataFromContent(contentObj) {
    const files = [];
    
    if (contentObj.type === 'image_url' && contentObj.image_url?.url) {
        files.push({
            url: contentObj.image_url.url,
            gcs: contentObj.gcs || null,
            hash: contentObj.hash || null,
            type: 'image_url'
        });
    } else if (contentObj.type === 'file' && contentObj.url) {
        files.push({
            url: contentObj.url,
            gcs: contentObj.gcs || null,
            hash: contentObj.hash || null,
            type: 'file'
        });
    } else if (contentObj.url && (contentObj.type === 'image_url' || !contentObj.type)) {
        // Handle direct URL objects
        files.push({
            url: contentObj.url,
            gcs: contentObj.gcs || null,
            hash: contentObj.hash || null,
            type: contentObj.type || 'file'
        });
    }
    
    return files;
}

// Cache for file collections during a request lifecycle
// Stores raw parsed file data (all files from Redis) to support flexible filtering
// Structure: { rawFiles: Array<parsed file data>, timestamp: number }
const fileCollectionCache = new Map();
const CACHE_TTL = 5000; // 5 seconds

// Singleton Redis client for file collection operations
let redisClientSingleton = null;

// Helper to get Redis client for direct hash map access
async function getRedisClient() {
    if (redisClientSingleton) {
        return redisClientSingleton;
    }
    
    try {
        const { config } = await import('../config.js');
        const connectionString = config.get('storageConnectionString');
        if (!connectionString) {
            return null;
        }
        
        // Import Redis and create client
        const Redis = (await import('ioredis')).default;
        redisClientSingleton = new Redis(connectionString, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            lazyConnect: false,
            connectTimeout: 10000,
        });
        
        // Handle errors
        redisClientSingleton.on('error', async (error) => {
            const logger = (await import('./logger.js')).default;
            logger.error(`Redis client error in fileUtils: ${error}`);
        });
        
        return redisClientSingleton;
    } catch (e) {
        return null;
    }
}


/**
 * Get cache key for file collection
 */
function getCollectionCacheKey(contextId, contextKey) {
    // Cache key for file collection (legacy format maintained for cache compatibility)
    return `${contextId}-fileCollection-${contextKey || 'default'}`;
}

/**
 * Invalidate file collection cache for a given context
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 */
export function invalidateFileCollectionCache(contextId, contextKey = null) {
    const cacheKey = getCollectionCacheKey(contextId, contextKey);
    fileCollectionCache.delete(cacheKey);
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
 * Check if a file should be included in the collection based on inCollection metadata
 * Supports both boolean (backward compat) and array format
 * @param {boolean|Array<string>|undefined} inCollection - inCollection metadata value
 * @param {string|null} chatId - Optional chat ID to filter by (if null, only global files are included)
 * @returns {boolean} True if file should be included
 */
function isFileInCollection(inCollection, chatId = null) {
    // If not set, file is not in collection
    if (inCollection === undefined || inCollection === null || inCollection === false) {
        return false;
    }
    
    // Backward compatibility: boolean true means global
    if (inCollection === true) {
        return true;
    }
    
    // Array format: check if it includes '*' (global) or the specific chatId
    if (Array.isArray(inCollection)) {
        // If no chatId specified, only include global files
        if (chatId === null) {
            return inCollection.includes('*');
        }
        // Include if global or matches specific chatId
        return inCollection.includes('*') || inCollection.includes(chatId);
    }
    
    // Unknown format, exclude
    return false;
}

/**
 * Load file collection from memory system or cache
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption
 * @param {boolean} useCache - Whether to check cache first (default: true)
 * @param {string|null} chatId - Optional chat ID to filter files by (if provided, only includes files with '*' or this chatId in inCollection)
 * @returns {Promise<Array>} File collection array
 */
/**
 * Write file data to Redis with encryption of sensitive fields
 * Follows the same pattern as setvWithDoubleEncryption - skips encryption for empty values
 * @param {Object} redisClient - Redis client
 * @param {string} contextMapKey - Redis hash map key
 * @param {string} hash - File hash (key in hash map)
 * @param {Object} fileData - File data object
 * @param {string} contextKey - Optional context key for encryption
 */
async function writeFileDataToRedis(redisClient, contextMapKey, hash, fileData, contextKey = null) {
    const dataToStore = { ...fileData };
    
    // Encrypt sensitive fields if contextKey is provided (same pattern as memory encryption)
    if (contextKey && contextKey.trim() !== '') {
        // Encrypt tags (array of strings) - skip if empty (consistent with memory encryption)
        if (dataToStore.tags && Array.isArray(dataToStore.tags) && dataToStore.tags.length > 0) {
            try {
                const tagsJson = JSON.stringify(dataToStore.tags);
                const encrypted = encrypt(tagsJson, contextKey);
                if (encrypted !== null) {
                    dataToStore.tags = encrypted;
                }
                // If encryption fails, continue with unencrypted (same pattern as memory)
            } catch (error) {
                logger.warn(`Failed to encrypt tags: ${error.message}`);
            }
        }
        
        // Encrypt notes (string) - skip if empty (consistent with memory encryption)
        if (dataToStore.notes && typeof dataToStore.notes === 'string' && dataToStore.notes.trim() !== '') {
            try {
                const encrypted = encrypt(dataToStore.notes, contextKey);
                if (encrypted !== null) {
                    dataToStore.notes = encrypted;
                }
                // If encryption fails, continue with unencrypted (same pattern as memory)
            } catch (error) {
                logger.warn(`Failed to encrypt notes: ${error.message}`);
            }
        }
    }
    
    await redisClient.hset(contextMapKey, hash, JSON.stringify(dataToStore));
}

/**
 * Read file data from Redis with decryption of sensitive fields
 * Follows the same pattern as getvWithDoubleDecryption - tries decrypt, falls back to original
 * @param {string} dataStr - JSON string from Redis
 * @param {string} contextKey - Optional context key for decryption
 * @returns {Object|null} Parsed and decrypted file data, or null if invalid
 */
function readFileDataFromRedis(dataStr, contextKey = null) {
    if (!dataStr) return null;
    
    try {
        const fileData = JSON.parse(dataStr);
        
        // Decrypt sensitive fields if contextKey is provided (same pattern as memory decryption)
        if (contextKey && contextKey.trim() !== '') {
            // Decrypt tags (array of strings)
            if (fileData.tags !== undefined && fileData.tags !== null) {
                // If already an array, it's unencrypted legacy data - keep as-is
                if (!Array.isArray(fileData.tags) && typeof fileData.tags === 'string') {
                    // Try to decrypt (encrypted strings have ':' separator from IV)
                    if (fileData.tags.includes(':')) {
                        try {
                            const decrypted = decrypt(fileData.tags, contextKey);
                            if (decrypted !== null) {
                                // Try to parse as JSON array, fallback to array with single string
                                try {
                                    fileData.tags = JSON.parse(decrypted);
                                } catch (e) {
                                    fileData.tags = [decrypted];
                                }
                            }
                            // If decryption returns null, keep original (might be unencrypted legacy data)
                        } catch (error) {
                            // Decryption failed, keep as-is (unencrypted legacy data)
                        }
                    } else {
                        // No ':' means not encrypted - try parsing as JSON, fallback to array
                        try {
                            fileData.tags = JSON.parse(fileData.tags);
                        } catch (e) {
                            fileData.tags = [fileData.tags];
                        }
                    }
                }
            } else {
                fileData.tags = [];
            }
            
            // Decrypt notes (string)
            if (fileData.notes !== undefined && fileData.notes !== null) {
                if (typeof fileData.notes === 'string' && fileData.notes.includes(':')) {
                    // Try to decrypt
                    try {
                        const decrypted = decrypt(fileData.notes, contextKey);
                        if (decrypted !== null) {
                            fileData.notes = decrypted;
                        }
                        // If decryption returns null, keep original (might be unencrypted legacy data)
                    } catch (error) {
                        // Decryption failed, keep as-is (unencrypted legacy data)
                    }
                }
                // If not encrypted (no ':'), keep as-is (legacy unencrypted data)
            } else {
                fileData.notes = '';
            }
        }
        
        return fileData;
    } catch (e) {
        return null;
    }
}

/**
 * Parse raw Redis hash map data into file objects (without filtering)
 * @param {Object} allFiles - Redis HGETALL result {hash: fileDataStr}
 * @param {string} contextKey - Optional context key for decryption
 * @returns {Array} Array of parsed file data objects (includes inCollection metadata)
 */
function parseRawFileData(allFiles, contextKey = null) {
    return Object.entries(allFiles).map(([hash, fileDataStr]) => {
        const decryptedData = readFileDataFromRedis(fileDataStr, contextKey);
        if (!decryptedData) {
            return null;
        }
        
        // Use converted URL, GCS, and mimeType if converted block exists
        // This ensures we use the converted file (the actual processable content) as the primary values
        // Keep displayFilename as the original (e.g., "foo.docx" even if URL is "foo.md")
        const url = decryptedData.converted?.url || decryptedData.url;
        const gcs = decryptedData.converted?.gcs || decryptedData.gcs || null;
        const mimeType = decryptedData.converted?.mimeType || decryptedData.mimeType || null;
        
        // Return parsed file data with hash and inCollection preserved for filtering
        return {
            id: decryptedData.id || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            url: url, // Use converted URL if available
            gcs: gcs, // Use converted GCS if available
            displayFilename: decryptedData.displayFilename || decryptedData.filename || null,
            mimeType: mimeType, // Use converted mimeType if available
            tags: decryptedData.tags || [],
            notes: decryptedData.notes || '',
            hash: hash,
            permanent: decryptedData.permanent || false,
            addedDate: decryptedData.addedDate || decryptedData.timestamp || new Date().toISOString(),
            lastAccessed: decryptedData.lastAccessed || decryptedData.timestamp || new Date().toISOString(),
            // Mark as converted if converted block exists (for edit prevention)
            ...(decryptedData.converted && { _isConverted: true }),
            // Preserve inCollection for filtering
            inCollection: decryptedData.inCollection
        };
    }).filter(Boolean);
}

/**
 * Filter and format file collection based on inCollection and chatId
 * @param {Array} rawFiles - Array of parsed file data objects
 * @param {string|null} chatId - Optional chat ID to filter by
 * @returns {Array} Filtered and sorted file collection (includes inCollection for reference counting)
 */
function filterAndFormatFileCollection(rawFiles, chatId = null) {
    // Filter by inCollection and optional chatId
    const filtered = rawFiles.filter(file => isFileInCollection(file.inCollection, chatId));
    
    // Keep inCollection in output (needed for reference counting display)
    // Sort by lastAccessed (most recent first)
    filtered.sort((a, b) => {
        const aDate = new Date(a.lastAccessed || a.addedDate || 0);
        const bDate = new Date(b.lastAccessed || b.addedDate || 0);
        return bDate - aDate;
    });
    
    return filtered;
}

async function loadFileCollection(contextId, contextKey = null, useCache = true, chatId = null) {
    if (!contextId) {
        return [];
    }

    const cacheKey = getCollectionCacheKey(contextId, contextKey);

    // Check cache first - cache stores raw parsed file data, so we can filter by chatId from cache
    if (useCache && fileCollectionCache.has(cacheKey)) {
        const cached = fileCollectionCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            // Apply filtering to cached raw data
            return filterAndFormatFileCollection(cached.rawFiles, chatId);
        }
    }

    // Load from context-scoped Redis hash map (FileStoreMap:ctx:<contextId>)
    let rawFiles = [];
    
    try {
        const redisClient = await getRedisClient();
        
        if (redisClient) {
            const contextMapKey = `FileStoreMap:ctx:${contextId}`;
            const allFiles = await redisClient.hgetall(contextMapKey);
            
            // Parse raw file data (preserves inCollection metadata for filtering)
            // Pass contextKey for decryption
            rawFiles = parseRawFileData(allFiles, contextKey);
        }
    } catch (e) {
        // Collection doesn't exist yet or error reading, start with empty array
        rawFiles = [];
    }

    // Update cache with raw file data (supports any filtering on retrieval)
    if (useCache) {
        fileCollectionCache.set(cacheKey, {
            rawFiles: rawFiles,
            timestamp: Date.now()
        });
    }

    // Filter and format for return
    return filterAndFormatFileCollection(rawFiles, chatId);
}

/**
 * Load ALL files from a context's file collection, bypassing inCollection filtering.
 * Used when merging alt contexts where we want all files regardless of chat scope.
 * @param {string} contextId - Context ID
 * @param {string|null} contextKey - Optional encryption key
 * @returns {Promise<Array>} All files in the collection
 */
async function loadFileCollectionAll(contextId, contextKey = null) {
    if (!contextId) {
        return [];
    }

    try {
        const redisClient = await getRedisClient();
        
        if (redisClient) {
            const contextMapKey = `FileStoreMap:ctx:${contextId}`;
            const allFiles = await redisClient.hgetall(contextMapKey);
            
            // Parse raw file data
            const rawFiles = parseRawFileData(allFiles, contextKey);
            
            // Return all files without inCollection filtering (keep inCollection for reference counting)
            // Sort by lastAccessed (most recent first)
            rawFiles.sort((a, b) => {
                const aDate = new Date(a.lastAccessed || a.addedDate || 0);
                const bDate = new Date(b.lastAccessed || b.addedDate || 0);
                return bDate - aDate;
            });
            
            return rawFiles;
        }
    } catch (e) {
        // Collection doesn't exist yet or error reading
    }
    
    return [];
}

/**
 * Normalize inCollection value to array format
 * @param {boolean|Array<string>|undefined} inCollection - inCollection value to normalize
 * @returns {Array<string>|undefined} Normalized array or undefined if false/null
 */
function normalizeInCollection(inCollection) {
    // If explicitly false or null, return undefined (file not in collection)
    if (inCollection === false || inCollection === null) {
        return undefined;
    }
    
    // If undefined, return undefined (preserve existing state)
    if (inCollection === undefined) {
        return undefined;
    }
    
    // Boolean true means global
    if (inCollection === true) {
        return ['*'];
    }
    
    // Already an array, return as-is
    if (Array.isArray(inCollection)) {
        return inCollection;
    }
    
    // Unknown format, default to global
    return ['*'];
}

/**
 * Get the appropriate inCollection value based on chatId
 * Centralized function to ensure consistent behavior across all file operations
 * @param {string|null|undefined} chatId - Optional chat ID
 * @returns {Array<string>} Array with chatId if provided, otherwise ['*'] for global
 */
function getInCollectionValue(chatId = null) {
    if (chatId && typeof chatId === 'string' && chatId.trim() !== '') {
        return [chatId];
    }
    return ['*'];
}

/**
 * Add a chatId to an existing inCollection array (reference counting)
 * If the chatId is already present, returns the array unchanged.
 * 
 * IMPORTANT: inCollection is either ['*'] (global) OR [chatId, ...] (chat-scoped), never mixed.
 * If inCollection contains '*' (global), it stays global - no chatIds are added.
 * 
 * @param {Array<string>|undefined} existingInCollection - Current inCollection value
 * @param {string|null} chatId - Chat ID to add
 * @returns {Array<string>} Updated inCollection array
 */
function addChatIdToInCollection(existingInCollection, chatId) {
    // Normalize existing to array
    const existing = Array.isArray(existingInCollection) ? existingInCollection : [];
    
    // If already global, stay global
    if (existing.includes('*')) {
        return existing;
    }
    
    // If no chatId provided, return existing or default to global
    if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
        return existing.length > 0 ? existing : ['*'];
    }
    
    // Add chatId if not already present
    if (!existing.includes(chatId)) {
        return [...existing, chatId];
    }
    
    return existing;
}

/**
 * Remove a chatId from an inCollection array (reference counting)
 * Returns the updated array without the chatId.
 * 
 * IMPORTANT: Global files (['*']) are not reference-counted - they return unchanged.
 * Only chat-scoped files have chatIds removed. When removing from collection,
 * global files should be fully deleted, not reference-counted.
 * 
 * @param {Array<string>|undefined} existingInCollection - Current inCollection value
 * @param {string|null} chatId - Chat ID to remove
 * @returns {Array<string>} Updated inCollection array (may be empty for chat-scoped files)
 */
function removeChatIdFromInCollection(existingInCollection, chatId) {
    // Normalize existing to array
    const existing = Array.isArray(existingInCollection) ? existingInCollection : [];
    
    // If no chatId provided, can't remove anything
    if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
        return existing;
    }
    
    // If global, removing a specific chatId doesn't make sense - return as-is
    // (global files aren't scoped to chats)
    if (existing.includes('*')) {
        return existing;
    }
    
    // Remove the chatId
    return existing.filter(id => id !== chatId);
}

/**
 * Update file metadata in Redis hash map (direct atomic operation)
 * @param {string} contextId - Context ID
 * @param {string} hash - File hash
 * @param {Object} metadata - Metadata to update (displayFilename, id, tags, notes, mimeType, addedDate, lastAccessed, permanent, inCollection)
 * @param {string} contextKey - Optional context key for encryption
 * @param {string|null} chatId - Optional chat ID, used as default for inCollection if not provided in metadata and not already set
 * Note: Does NOT update CFH core fields (url, gcs, hash, filename) - those are managed by CFH
 * @returns {Promise<boolean>} True if successful
 */
async function updateFileMetadata(contextId, hash, metadata, contextKey = null, chatId = null) {
    if (!contextId || !hash) {
        return false;
    }
    
    try {
        const redisClient = await getRedisClient();
        if (!redisClient) {
            return false;
        }
        
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        // Get existing file data - must exist to update
        const existingDataStr = await redisClient.hget(contextMapKey, hash);
        if (!existingDataStr) {
            // File doesn't exist in this context - don't create new entries
            return false;
        }
        const existingData = readFileDataFromRedis(existingDataStr, contextKey) || {};
        
        // Merge CFH data with Cortex metadata
        // Only update Cortex-managed fields, preserve CFH fields (url, gcs, hash, filename)
        const fileData = {
            ...existingData, // Preserve all CFH data (url, gcs, hash, filename, etc.)
            // Handle inCollection: normalize if provided, otherwise preserve existing or default based on chatId
            inCollection: metadata.inCollection !== undefined
                ? normalizeInCollection(metadata.inCollection)
                : (existingData.inCollection !== undefined
                    ? normalizeInCollection(existingData.inCollection)
                    : getInCollectionValue(chatId)),
            // Update only Cortex-managed metadata fields
            ...(metadata.displayFilename !== undefined && { displayFilename: metadata.displayFilename }),
            ...(metadata.id !== undefined && { id: metadata.id }),
            ...(metadata.tags !== undefined && { tags: metadata.tags }),
            ...(metadata.notes !== undefined && { notes: metadata.notes }),
            ...(metadata.mimeType !== undefined && { mimeType: metadata.mimeType }),
            ...(metadata.addedDate !== undefined && { addedDate: metadata.addedDate }),
            ...(metadata.lastAccessed !== undefined && { lastAccessed: metadata.lastAccessed }),
            ...(metadata.permanent !== undefined && { permanent: metadata.permanent })
        };
        
        // Remove inCollection if it's undefined (file not in collection)
        if (fileData.inCollection === undefined) {
            delete fileData.inCollection;
        }
        
        // Write back to hash map (atomic operation) - encryption happens in helper
        await writeFileDataToRedis(redisClient, contextMapKey, hash, fileData, contextKey);
        
        // Invalidate cache (use contextKey to match the correct cache key)
        invalidateFileCollectionCache(contextId, contextKey);
        
        return true;
    } catch (e) {
        const logger = (await import('./logger.js')).default;
        logger.warn(`Failed to update file metadata: ${e.message}`);
        return false;
    }
}

/**
 * Save file collection to memory system
 * Only updates files that have changed (optimized)
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption (unused with hash maps)
 * @param {Array} collection - File collection array
 * @param {string|null} chatId - Optional chat ID, used for inCollection value (chat-scoped if provided, global if not)
 * @returns {Promise<boolean>} True if successful
 */
async function saveFileCollection(contextId, contextKey, collection, chatId = null) {
    const cacheKey = getCollectionCacheKey(contextId, contextKey);

    try {
        const redisClient = await getRedisClient();
        if (!redisClient) {
            return false;
        }
        
        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        
        // Get current state to detect changes
        const currentFiles = await redisClient.hgetall(contextMapKey);
        
        // Update only files that changed or are new
        for (const file of collection) {
            // Generate hash from URL if not present (for files added without hash)
            let fileHash = file.hash;
            if (!fileHash && file.url) {
                fileHash = await computeBufferHash(Buffer.from(file.url));
            }
            if (!fileHash) continue;
            
            const currentDataStr = currentFiles[fileHash];
            let needsUpdate = true;
            
            // Check if file actually changed
            if (currentDataStr) {
                const currentData = readFileDataFromRedis(currentDataStr, contextKey);
                if (currentData) {
                    // Compare metadata fields (ignore CFH fields like url, gcs, timestamp)
                    if (currentData.id === file.id &&
                        JSON.stringify(currentData.tags || []) === JSON.stringify(file.tags || []) &&
                        currentData.notes === (file.notes || '') &&
                        currentData.mimeType === (file.mimeType || null) &&
                        currentData.permanent === (file.permanent || false)) {
                        needsUpdate = false;
                    }
                }
            }
            
            if (needsUpdate) {
                // Get existing CFH data
                const existingData = readFileDataFromRedis(currentDataStr, contextKey) || {};
                
                // Merge CFH data with Cortex metadata
                // Preserve all CFH fields (url, gcs, filename, displayFilename, etc.)
                // Mark as inCollection: true (chat files that should appear in file collection)
                const fileData = {
                    ...existingData, // Preserve all CFH data first
                    id: file.id,
                    url: file.url || existingData.url, // Preserve URL (CFH-managed)
                    gcs: file.gcs || existingData.gcs || null, // Preserve GCS (CFH-managed)
                    // Preserve CFH's filename (CFH-managed), only update displayFilename (Cortex-managed)
                    displayFilename: file.displayFilename !== undefined ? file.displayFilename : (existingData.displayFilename || null),
                    tags: file.tags || [],
                    notes: file.notes || '',
                    mimeType: file.mimeType || existingData.mimeType || null,
                    addedDate: file.addedDate || existingData.timestamp || new Date().toISOString(),
                    lastAccessed: file.lastAccessed || new Date().toISOString(),
                    permanent: file.permanent !== undefined ? file.permanent : (existingData.permanent || false),
                    // Add chatId to existing inCollection (reference counting) - file may be used in multiple chats
                    inCollection: existingData.inCollection 
                        ? addChatIdToInCollection(existingData.inCollection, chatId)
                        : getInCollectionValue(chatId)
                };
                
                // Write back to hash map (atomic operation) - encryption happens in helper
                await writeFileDataToRedis(redisClient, contextMapKey, fileHash, fileData, contextKey);
            }
        }
        
        // Note: We don't remove files from hash map when removed from collection
        // CFH manages file lifecycle, and files might still exist in storage

        // Invalidate cache (will be repopulated on next loadFileCollection call with fresh Redis data)
        fileCollectionCache.delete(cacheKey);
        
        return true;
    } catch (e) {
        const logger = (await import('./logger.js')).default;
        logger.warn(`Failed to save file collection: ${e.message}`);
        return false;
    }
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
 * @param {boolean} permanent - If true, file is stored with permanent retention
 * @param {string|null} chatId - Optional chat ID, used for inCollection value (chat-scoped if provided, global if not)
 * @returns {Promise<Object>} File entry object with id
 */
async function addFileToCollection(contextId, contextKey, url, gcs, filename, tags = [], notes = '', hash = null, fileUrl = null, pathwayResolver = null, permanent = false, chatId = null) {
    if (!contextId || !filename) {
        throw new Error("contextId and filename are required");
    }

    // If permanent=true, set retention=permanent to keep file forever
    const desiredRetention = permanent ? 'permanent' : 'temporary';

    // YouTube URLs should not be added to the file collection (they are never uploaded to CFH)
    // They can be used directly in analyzer tools without being in the collection
    if (fileUrl && isYoutubeUrl(fileUrl)) {
        throw new Error("YouTube URLs cannot be added to the file collection. Use the YouTube URL directly with analyzer tools instead.");
    }
    if (url && isYoutubeUrl(url)) {
        throw new Error("YouTube URLs cannot be added to the file collection. Use the YouTube URL directly with analyzer tools instead.");
    }
    
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

    // Determine MIME type from URL (the actual stored content, which may be converted)
    // E.g., if user uploaded foo.docx but it was converted to foo.md, MIME type should be text/markdown
    const mimeType = determineMimeTypeFromUrl(finalUrl, finalGcs, null);
    
    // IMPORTANT: Keep the original user-provided filename as displayFilename
    // Do NOT "correct" the extension based on MIME type
    // The user's original filename (e.g., "foo.docx") should be preserved even if the
    // stored content is a converted format (e.g., "foo.md")
    // This allows users to recognize their files by original name while tools
    // use the actual URL to determine content type for operations

    // If no hash, generate one from URL for storage key (needed for Redis hash map)
    const storageHash = finalHash || await computeBufferHash(Buffer.from(finalUrl));
    
    // Create file entry (before locking to avoid recreating on retry)
    const fileEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        url: finalUrl,
        gcs: finalGcs || null,
        displayFilename: filename, // Keep original user-provided filename as displayFilename (NOT corrected by MIME type)
        mimeType: mimeType, // MIME type from actual URL content (may differ from displayFilename extension)
        tags: Array.isArray(tags) ? tags : [],
        notes: notes || '',
        hash: storageHash, // Use storageHash (actual hash or generated from URL)
        permanent: permanent,
        addedDate: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
    };

    // Write file metadata directly to Redis hash map (atomic operation)
    // No need for optimistic locking - Redis HSET is atomic per key
    // If a file with the same hash already exists, update it (same content, possibly different metadata)
    if (storageHash) {
        try {
            const redisClient = await getRedisClient();
            if (redisClient) {
                const contextMapKey = `FileStoreMap:ctx:${contextId}`;
                // Get existing file data from CFH (if any)
                const existingDataStr = await redisClient.hget(contextMapKey, storageHash);
                const existingData = readFileDataFromRedis(existingDataStr, contextKey) || {};
                
                // Merge CFH data with Cortex metadata
                // If file already exists with same hash, update metadata but keep the existing entry
                // Mark as inCollection: true (chat files that should appear in file collection)
                
                // IMPORTANT: Use existing ID if file already exists, to prevent ID mismatch
                // between what we return and what's actually stored in Redis
                const actualId = existingData.id || fileEntry.id;
                
                const fileData = {
                    ...existingData, // Preserve CFH data (url, gcs, filename, etc.)
                    // Update Cortex metadata (use existing ID if entry exists, otherwise new ID)
                    id: actualId,
                    url: finalUrl, // Use new URL (guaranteed to be truthy at this point)
                    gcs: finalGcs || existingData.gcs || null, // Use new GCS if provided, otherwise keep existing
                    // Preserve CFH's filename (managed by CFH), store user-provided filename as displayFilename
                    // Keep original user-provided filename (do NOT correct based on MIME type)
                    displayFilename: filename,
                    tags: fileEntry.tags.length > 0 ? fileEntry.tags : (existingData.tags || []), // Merge tags if new ones provided
                    notes: fileEntry.notes || existingData.notes || '', // Keep existing notes if new ones empty
                    mimeType: fileEntry.mimeType || existingData.mimeType || null, // MIME type from URL (actual content type)
                    // Add chatId to existing inCollection (reference counting) - file may be used in multiple chats
                    inCollection: existingData.inCollection 
                        ? addChatIdToInCollection(existingData.inCollection, chatId)
                        : getInCollectionValue(chatId),
                    addedDate: existingData.addedDate || fileEntry.addedDate, // Keep earliest addedDate
                    lastAccessed: new Date().toISOString(), // Always update lastAccessed
                    permanent: fileEntry.permanent !== undefined ? fileEntry.permanent : (existingData.permanent || false),
                    hash: storageHash // Store the hash used as key (actual hash or generated from URL)
                };
                
                // Write back to hash map (atomic operation) - encryption happens in helper
                await writeFileDataToRedis(redisClient, contextMapKey, storageHash, fileData, contextKey);
                
                // Update fileEntry.id to match what's actually stored in Redis
                // This ensures the caller gets the correct ID for subsequent operations
                fileEntry.id = actualId;
                
                // Invalidate cache to ensure subsequent operations see the updated data
                invalidateFileCollectionCache(contextId, contextKey);
            }
        } catch (e) {
            // Log but don't fail - metadata update is best effort
            const logger = (await import('./logger.js')).default;
            logger.warn(`Failed to update file metadata in Redis: ${e.message}`);
        }
    }

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
 * Get the actual content MIME type from a file object.
 * This determines the MIME type from the actual stored content (URL), not the displayFilename.
 * 
 * Use this for operations that need to know the actual content type (e.g., reading, editing),
 * not for display purposes where displayFilename should be used.
 * 
 * Example: A file with displayFilename="report.docx" but url="...report.md" 
 * will return "text/markdown" because that's what the actual content is.
 * 
 * @param {Object} file - File object with url, gcs, and optionally mimeType fields
 * @returns {string} MIME type of the actual content
 */
function getActualContentMimeType(file) {
    if (!file) {
        return 'application/octet-stream';
    }
    
    // If mimeType is already stored and valid, use it (it was computed from URL at add time)
    if (file.mimeType && file.mimeType !== 'application/octet-stream') {
        return file.mimeType;
    }
    
    // Determine MIME type from URL (the actual stored content)
    // Do NOT use displayFilename as it may have a different extension (e.g., docx for an md file)
    return determineMimeTypeFromUrl(file.url, file.gcs, null);
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

    // Format as compact one line per file: hash | displayFilename | url | date | tags
    const fileList = recentFiles.map((file) => {
        const hash = file.hash || '';
        // Fallback to filename if displayFilename is not set (for files uploaded before displayFilename was added)
        const displayFilename = file.displayFilename || file.filename || 'Unnamed file';
        const url = file.url || '';
        const dateAdded = file.addedDate 
            ? new Date(file.addedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
        const tags = Array.isArray(file.tags) && file.tags.length > 0 
            ? file.tags.join(',') 
            : '';
        return `${hash} | ${displayFilename} | ${url} | ${dateAdded}${tags ? ' | ' + tags : ''}`;
    }).join('\n');

    let result = fileList;
    
    if (hasMore) {
        result += `\n(${totalFiles - 10} more file(s) available - use ListFileCollection or SearchFileCollection)`;
    }

    return result;
}

/**
 * Extract default context from agentContext array (for writes/updates)
 * @param {Array} agentContext - Array of context objects { contextId, contextKey, default }
 * @returns {Object|null} Default context object or null if not found
 */
function getDefaultContext(agentContext) {
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        return null;
    }
    return agentContext.find(ctx => ctx.default === true) || agentContext[0] || null;
}

/**
 * Load merged file collection from agentContext array
 * Merges all contexts in the array for read operations
 * @param {Array} agentContext - Array of context objects { contextId, contextKey, default }
 * @param {string|null} chatId - Optional chat ID to filter files by (if provided, only includes files with '*' or this chatId in inCollection)
 * @returns {Promise<Array>} Merged file collection
 */
async function loadMergedFileCollection(agentContext, chatId = null) {
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        return [];
    }
    
    // Load first context as primary
    // If chatId is provided, use loadFileCollection to filter by chatId
    // Otherwise, use loadFileCollectionAll to get all files (we'll filter by inCollection below)
    const primaryCtx = agentContext[0];
    const primaryCollection = chatId 
        ? await loadFileCollection(primaryCtx.contextId, primaryCtx.contextKey || null, true, chatId)
        : await loadFileCollectionAll(primaryCtx.contextId, primaryCtx.contextKey || null);
    
    // Tag primary files with their source context
    let collection = primaryCollection.map(f => ({ ...f, _contextId: primaryCtx.contextId }));
    
    // Load and merge additional contexts
    for (let i = 1; i < agentContext.length; i++) {
        const ctx = agentContext[i];
        if (!ctx.contextId) continue;
        
        // Load alternate collection
        // If chatId is provided, use loadFileCollection to filter by chatId
        // Otherwise, use loadFileCollectionAll to get all files
        const altCollection = chatId
            ? await loadFileCollection(ctx.contextId, ctx.contextKey || null, true, chatId)
            : await loadFileCollectionAll(ctx.contextId, ctx.contextKey || null);
        
        // Build set of existing identifiers from current collection
        const existingHashes = new Set(collection.map(f => f.hash).filter(Boolean));
        const existingUrls = new Set(collection.map(f => f.url).filter(Boolean));
        const existingGcs = new Set(collection.map(f => f.gcs).filter(Boolean));
        
        // Add files from alt collection that aren't already in collection, tagged with alt context
        for (const file of altCollection) {
            const isDupe = (file.hash && existingHashes.has(file.hash)) ||
                           (file.url && existingUrls.has(file.url)) ||
                           (file.gcs && existingGcs.has(file.gcs));
            if (!isDupe) {
                collection.push({ ...file, _contextId: ctx.contextId });
            }
        }
    }
    
    // When chatId is null (includeAllChats=true), filter to only include files with inCollection set
    // Agent tools should only see files that are actually in the collection (have inCollection set)
    if (chatId === null) {
        collection = collection.filter(file => {
            const inCollection = file.inCollection;
            
            // Exclude files without inCollection set or with empty inCollection array/string
            if (inCollection === undefined || inCollection === null || inCollection === false || inCollection === '') {
                return false;
            }
            
            // Exclude empty arrays (file not in any collection)
            if (Array.isArray(inCollection) && inCollection.length === 0) {
                return false;
            }
            
            // Include files with inCollection set (truthy and non-empty)
            return true;
        });
    }
    
    return collection;
}

/**
 * Get available files from file collection (no syncing from chat history)
 * @param {Array} chatHistory - Unused, kept for API compatibility
 * @param {Array} agentContext - Array of context objects { contextId, contextKey, default }
 * @returns {Promise<string>} Formatted string of available files
 */
async function getAvailableFiles(chatHistory, agentContext) {
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        return 'No files available.';
    }
    const collection = await loadMergedFileCollection(agentContext);
    // Strip internal _contextId before formatting
    const cleanCollection = collection.map(({ _contextId, ...file }) => file);
    return formatFilesForTemplate(cleanCollection);
}

/**
 * Process files in chat history:
 * - Files IN collection (all agentContext contexts): update lastAccessed, add chatId to inCollection (reference counting), strip from message (tools can access)
 * - Files NOT in collection: leave in message (model sees directly)
 * 
 * @param {Array} chatHistory - Chat history array
 * @param {Array} agentContext - Array of context objects { contextId, contextKey, default }
 * @param {string|null} chatId - Optional chat ID, added to inCollection for reference counting when files are accessed
 * @returns {Promise<{chatHistory: Array, availableFiles: string}>}
 */
async function syncAndStripFilesFromChatHistory(chatHistory, agentContext, chatId = null) {
    if (!chatHistory || !Array.isArray(chatHistory)) {
        return { chatHistory: chatHistory || [], availableFiles: 'No files available.' };
    }

    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        // No agentContext - no collection to check, leave all files in messages
        return { chatHistory, availableFiles: 'No files available.' };
    }

    // Load merged collection once
    const collection = await loadMergedFileCollection(agentContext);
    
    // Build lookup map from contextId to contextKey for updates
    const contextKeyMap = new Map(agentContext.map(ctx => [ctx.contextId, ctx.contextKey || null]));
    
    // Build lookup maps for fast matching and context lookup (need Maps, not Sets, to get full file object)
    const collectionByHash = new Map(collection.filter(f => f.hash).map(f => [f.hash, f]));
    const collectionByUrl = new Map(collection.filter(f => f.url).map(f => [f.url, f]));
    const collectionByGcs = new Map(collection.filter(f => f.gcs).map(f => [f.gcs, f]));

    // Helper to get file from collection (by hash, URL, or GCS) to find _contextId
    const getFileFromCollection = (contentObj) => {
        const fileHash = contentObj.hash;
        const fileUrl = contentObj.url || contentObj.image_url?.url;
        const fileGcs = contentObj.gcs;
        
        if (fileHash && collectionByHash.has(fileHash)) {
            return collectionByHash.get(fileHash);
        }
        if (fileUrl && collectionByUrl.has(fileUrl)) {
            return collectionByUrl.get(fileUrl);
        }
        if (fileGcs && collectionByGcs.has(fileGcs)) {
            return collectionByGcs.get(fileGcs);
        }
        return null;
    };

    // Helper to check if a file content object is in the collection
    const isInCollection = (contentObj) => {
        return getFileFromCollection(contentObj) !== null;
    };
    
    // Helper to update file when stripped - use _contextId from collection to know which context to update
    const updateStrippedFile = (contentObj) => {
        const file = getFileFromCollection(contentObj);
        if (!file || !file._contextId) return;
        
        // Use hash from the found file (may not be in contentObj)
        const hash = file.hash;
        if (!hash) return;
        
        // Get the correct contextKey for this file's context
        const fileContextKey = contextKeyMap.get(file._contextId) || null;
        
        const now = new Date().toISOString();
        // Update lastAccessed and add chatId to inCollection (reference counting)
        // If this file is being used in a new chat, add that chat to the list
        const updatedInCollection = addChatIdToInCollection(file.inCollection, chatId);
        updateFileMetadata(file._contextId, hash, {
            lastAccessed: now,
            inCollection: updatedInCollection
        }, fileContextKey).catch((err) => {
            logger.warn(`Failed to update metadata for stripped file (hash=${hash}): ${err?.message || err}`);
        });
    };

    // Process chat history - only strip files that are in collection
    const processedHistory = chatHistory.map(message => {
        if (!message || message.role !== 'user' || !message.content) {
            return message;
        }

        // Handle array content
        if (Array.isArray(message.content)) {
            const newContent = message.content.map(item => {
                const contentObj = typeof item === 'string' ? tryParseJson(item) : item;
                if (contentObj && (contentObj.type === 'image_url' || contentObj.type === 'file')) {
                    if (isInCollection(contentObj)) {
                        // In collection - strip and update metadata
                        updateStrippedFile(contentObj); // fire and forget
                        const filename = extractFilenameFromFileContent(contentObj);
                        return { type: 'text', text: `[File: ${filename} - available via file tools]` };
                    }
                    // Not in collection - leave as-is
                    return item;
                }
                return item;
            });
            return { ...message, content: newContent };
        }

        // Handle object content
        if (typeof message.content === 'object' && message.content !== null) {
            if (message.content.type === 'image_url' || message.content.type === 'file') {
                if (isInCollection(message.content)) {
                    updateStrippedFile(message.content); // fire and forget
                    const filename = extractFilenameFromFileContent(message.content);
                    return { ...message, content: `[File: ${filename} - available via file tools]` };
                }
            }
        }

        // Handle string content (might be JSON)
        if (typeof message.content === 'string') {
            const contentObj = tryParseJson(message.content);
            if (contentObj && (contentObj.type === 'image_url' || contentObj.type === 'file')) {
                if (isInCollection(contentObj)) {
                    updateStrippedFile(contentObj); // fire and forget
                    const filename = extractFilenameFromFileContent(contentObj);
                    return { ...message, content: `[File: ${filename} - available via file tools]` };
                }
            }
        }

        return message;
    });

    // Strip internal _contextId before formatting (it's only needed for updates)
    const cleanCollection = collection.map(({ _contextId, ...file }) => file);
    const availableFiles = formatFilesForTemplate(cleanCollection);
    return { chatHistory: processedHistory, availableFiles };
}

/**
 * Try to parse JSON, return null if it fails
 */
function tryParseJson(str) {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

/**
 * Extract filename from file content object for placeholder
 */
function extractFilenameFromFileContent(content) {
    if (!content) return 'unknown file';
    
    // Try various filename sources
    if (content.originalFilename) return content.originalFilename;
    if (content.filename) return content.filename;
    if (content.name) return content.name;
    
    // Try to extract from URL
    const url = content.url || content.image_url?.url || content.gcs;
    if (url) {
        try {
            const urlPath = new URL(url).pathname;
            const basename = urlPath.split('/').pop();
            if (basename && basename.length > 0 && basename !== '/') {
                // Decode and clean up the filename
                return decodeURIComponent(basename).replace(/\?.*$/, '');
            }
        } catch {
            // URL parsing failed
        }
    }
    
    // Fallback based on type
    if (content.type === 'image_url') return 'image';
    if (content.type === 'file') return 'file';
    return 'unknown file';
}

/**
 * Find a file in the collection by ID, URL, hash, or filename
 * First tries exact matches, then falls back to simple "contains" matches on displayFilename, filename, URL, and GCS
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
        
        // Check by exact displayFilename (case-insensitive, using basename)
        if (file.displayFilename) {
            const normalizedDisplayFilename = file.displayFilename.toLowerCase();
            const fileDisplayFilename = path.basename(normalizedDisplayFilename);
            if (fileDisplayFilename === paramFilename) {
                return file;
            }
        }
    }

    // If no exact match, try simple "contains" matches on displayFilename, filename, url, and gcs
    // Only match if parameter is at least 4 characters to avoid false matches
    if (normalizedParam.length >= 4) {
        for (const file of collection) {
            // Check if displayFilename contains the parameter
            if (file.displayFilename) {
                const normalizedDisplayFilename = file.displayFilename.toLowerCase();
                if (normalizedDisplayFilename.includes(normalizedParam)) {
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
 * If agentContext is provided, looks up the file in the merged collection and returns its URL
 * @param {string} fileParam - File ID, URL (Azure or GCS), hash, or filename from collection
 * @param {Array} agentContext - Array of context objects { contextId, contextKey, default }
 * @param {Object} options - Optional configuration
 * @param {boolean} options.preferGcs - If true, prefer GCS URL over Azure URL when available
 * @param {boolean} options.useCache - If false, bypass cache (default: true, only used for single context)
 * @returns {Promise<string|null>} Resolved file URL, or null if not found
 */
export async function resolveFileParameter(fileParam, agentContext, options = {}) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    const trimmed = fileParam.trim();
    const { preferGcs = false, useCache = true } = options;

    // If no agentContext, can't look up in collection - return null
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        return null;
    }

    try {
        // Load merged file collection (always use merged to get all files, not just global ones)
        // Note: useCache option is ignored for merged collections (they always load fresh)
        const collection = await loadMergedFileCollection(agentContext);
        
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
 * @param {Array} agentContext - Array of context objects { contextId, contextKey, default }
 * @returns {Promise<Object|null>} Content object in the format for chat history, or null if not found
 */
async function generateFileMessageContent(fileParam, agentContext) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    // If fileParam is a YouTube URL, return it directly (doesn't need to be in collection)
    // Wrap in try-catch to prevent errors from breaking file lookup
    try {
        if (isYoutubeUrl(fileParam)) {
            return {
                type: 'image_url',
                url: fileParam,
                gcs: null,
                hash: null
            };
        }
    } catch (error) {
        // If YouTube URL check fails, continue with normal file lookup
        logger.debug(`YouTube URL check failed for "${fileParam}": ${error.message}`);
    }

    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        // Without agentContext, we can't look up in collection
        return null;
    }

    // Load merged file collection
    const collection = await loadMergedFileCollection(agentContext);

    // Find the file using shared matching logic
    const foundFile = findFileInCollection(fileParam, collection);

    if (!foundFile) {
        // File not found in collection, return null
        return null;
    }

    // Resolve to short-lived URL if possible
    // Use default context for ensureShortLivedUrl
    const defaultCtx = getDefaultContext(agentContext);
    const fileWithShortLivedUrl = await ensureShortLivedUrl(foundFile, MEDIA_API_URL, defaultCtx?.contextId || null);

    return {
        type: 'image_url',
        url: fileWithShortLivedUrl.url,
        gcs: fileWithShortLivedUrl.gcs || null,
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
 * Returns long-lived URL for storage; use ensureShortLivedUrl() for LLM processing
 * @param {string} hash - File hash to check
 * @param {string} fileHandlerUrl - File handler service URL
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @param {string|null} contextId - Optional but strongly recommended context id for scoped hashes
 * @param {number} shortLivedMinutes - Optional duration for short-lived URL (default: 5) - unused, kept for API compatibility
 * @returns {Promise<Object|null>} {url, gcs, hash, filename} if file exists, null otherwise
 *   url: Long-lived URL for storage (prefers converted if available)
 *   gcs: GCS URL (prefers converted if available)
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
        
        // If file exists (200), return URLs with long-lived URL for storage
        if (checkResponse.status === 200 && checkResponse.data && checkResponse.data.url) {
            const data = checkResponse.data;
            // Return long-lived URL for storage purposes
            // Use ensureShortLivedUrl() when you need short-lived URLs for LLM processing
            // For GCS, always use the GCS URL from checkHash (prefers converted)
            const url = data.converted?.url || data.url;
            const gcs = data.converted?.gcs || data.gcs || null;
            
            return {
                url: url, // Long-lived URL for storage; use ensureShortLivedUrl() for LLM processing
                gcs: gcs, // GCS URL (prefers converted if available)
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
 * @param {string} contextId - Optional context ID for scoped hashes
 * @param {number} shortLivedMinutes - Optional duration for short-lived URL (default: 5)
 * @returns {Promise<Object>} File object with url set to shortLivedUrl (or original if not available)
 */
async function ensureShortLivedUrl(fileObject, fileHandlerUrl, contextId = null, shortLivedMinutes = 5) {
    if (!fileObject || !fileObject.hash || !fileHandlerUrl) {
        // No hash or no file handler - return original object
        return fileObject;
    }
    
    // Note: YouTube URLs should not be in the file collection, but if one somehow got through,
    // we'll skip hash resolution for it (defensive check)
    if (fileObject.url && isYoutubeUrl(fileObject.url)) {
        return fileObject;
    }
    
    try {
        // Make a direct call to checkHash to get short-lived URL for LLM processing
        const checkHashUrl = buildFileHandlerUrl(fileHandlerUrl, {
            hash: fileObject.hash,
            checkHash: true,
            shortLivedMinutes: shortLivedMinutes,
            ...(contextId ? { contextId } : {})
        });
        
        const checkResponse = await axios.get(checkHashUrl, {
            timeout: 10000,
            validateStatus: (status) => status >= 200 && status < 500
        });
        
        if (checkResponse.status === 200 && checkResponse.data && checkResponse.data.url) {
            const data = checkResponse.data;
            // For LLM processing, prefer short-lived URLs
            const shortLivedUrl = data.converted?.shortLivedUrl || data.shortLivedUrl || data.converted?.url || data.url;
            const gcs = data.converted?.gcs || data.gcs || null;
            
            return {
                ...fileObject,
                url: shortLivedUrl, // Short-lived URL for LLM processing
                gcs: gcs || fileObject.gcs || null,
                filename: fileObject.filename || data.filename || fileObject.filename
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
        
        // Use the original filename if provided, otherwise fall back to temp file basename
        // This preserves the friendly filename from the user's message
        const uploadFilename = filename || path.basename(tempFilePath);
        
        formData.append('file', fs.createReadStream(tempFilePath), {
            filename: uploadFilename,
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
            const data = uploadResponse.data;
            // Return the long-lived URL for storage purposes
            // Use ensureShortLivedUrl() when you need short-lived URLs for LLM processing
            // For GCS, prefer converted GCS URL if available
            const url = data.converted?.url || data.url;
            const gcs = data.converted?.gcs || data.gcs || null;
            
            // Return both url and gcs if available
            return {
                url: url, // Long-lived URL for storage; use ensureShortLivedUrl() for LLM processing
                gcs: gcs, // GCS URL (prefers converted if available)
                hash: data.hash || fileHash
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
                // Make a single API call with shortLivedMinutes to get short-lived URL for LLM processing
                const checkHashUrl = buildFileHandlerUrl(fileHandlerUrl, {
                    hash,
                    checkHash: true,
                    shortLivedMinutes: 5,
                    ...(contextId ? { contextId } : {})
                });
                
                const checkResponse = await axios.get(checkHashUrl, {
                    timeout: 10000,
                    validateStatus: (status) => status >= 200 && status < 500
                });
                
                if (checkResponse.status === 200 && checkResponse.data && checkResponse.data.url) {
                    const data = checkResponse.data;
                    // For LLM processing, prefer short-lived URLs
                    const shortLivedUrl = data.converted?.shortLivedUrl || data.shortLivedUrl || data.converted?.url || data.url;
                    const gcs = data.converted?.gcs || data.gcs || null;
                    
                    return JSON.stringify({
                        type: "image_url",
                        url: shortLivedUrl, // Short-lived URL for LLM processing
                        image_url: { url: shortLivedUrl },
                        gcs: gcs,
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
    
    // 1. All text/* types are text (text/plain, text/html, text/css, text/csv, text/markdown, etc.)
    if (baseMimeType.startsWith('text/')) {
        return true;
    }
    
    // 2. Structured text formats with +json, +xml, +yaml suffix
    // (application/ld+json, application/rss+xml, application/vnd.api+json, etc.)
    if (baseMimeType.endsWith('+json') || baseMimeType.endsWith('+xml') || baseMimeType.endsWith('+yaml')) {
        return true;
    }
    
    // 3. Check mime-db for charset property - if a MIME type has a default charset, it's text
    // This catches application/json, application/javascript, etc.
    const dbEntry = mimeDb[baseMimeType];
    if (dbEntry && dbEntry.charset) {
        return true;
    }
    
    // 4. Well-known text-based application/* types not in mime-db with charset
    // These are common formats that are definitely text but don't have charset in the database
    const knownTextTypes = new Set([
        'application/xml',
        'application/x-yaml',
        'application/yaml',
        'application/toml',
        'application/x-toml',
        'application/x-sh',
        'application/x-shellscript',
        'application/x-httpd-php',
        'application/x-perl',
        'application/x-python',
        'application/x-sql',
        'application/sql',
        'application/graphql',
        'application/x-tex',
        'application/x-latex',
        'application/rtf',
    ]);
    
    if (knownTextTypes.has(baseMimeType)) {
        return true;
    }
    
    // 5. Check for source code patterns in application/x-* types
    if (baseMimeType.startsWith('application/x-')) {
        const subtype = baseMimeType.substring('application/x-'.length);
        // Common patterns indicating source code
        if (subtype.includes('source') || subtype.includes('script') || 
            subtype.includes('src') || subtype.includes('code')) {
            return true;
        }
    }
    
    // 6. Check if charset parameter is present in original MIME string
    // e.g., "application/octet-stream; charset=utf-8" is likely text
    if (mimeType.toLowerCase().includes('charset=')) {
        return true;
    }
    
    return false;
}

/**
 * Build a standardized JSON response for file creation tools (image, video, slides).
 * Provides consistent format with structured file objects and instructional message.
 * 
 * @param {Array} successfulFiles - Array of successful file objects, each with optional fileEntry and url/hash
 * @param {Object} options - Configuration options
 * @param {string} options.mediaType - Type of media: 'image' or 'video' (default: 'image')
 * @param {string} options.action - Action description for message: 'Image generation', 'Video generation', etc.
 * @param {Array} options.legacyUrls - Optional array of URLs for backward compatibility (imageUrls field)
 * @returns {string} JSON string with success, count, message, files, and optional imageUrls
 */
function buildFileCreationResponse(successfulFiles, options = {}) {
    const { 
        mediaType = 'image', 
        action = 'Generation',
        legacyUrls = []
    } = options;
    
    const files = successfulFiles.map((item) => {
        if (item.fileEntry) {
            const fe = item.fileEntry;
            return {
                hash: fe.hash || null,
                displayFilename: fe.displayFilename || null,
                url: fe.url || item.url,
                addedDate: fe.addedDate || null,
                tags: Array.isArray(fe.tags) ? fe.tags : []
            };
        } else {
            return {
                hash: item.hash || null,
                displayFilename: null,
                url: item.url,
                addedDate: null,
                tags: []
            };
        }
    });
    
    const count = files.length;
    const displayInstruction = mediaType === 'video'
        ? 'Display videos using markdown link: [video description](url).'
        : 'Display images using markdown: ![description](url).';
    
    const response = {
        success: true,
        count: count,
        message: `${action} complete. ${count} ${mediaType}(s) uploaded and added to file collection. ${displayInstruction} Reference files by hash or displayFilename.`,
        files: files
    };
    
    // Add legacyUrls as imageUrls for backward compatibility if provided
    if (legacyUrls && legacyUrls.length > 0) {
        response.imageUrls = legacyUrls;
    }
    
    return JSON.stringify(response);
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
    getAvailableFilesFromCollection,
    getDefaultContext,
    loadMergedFileCollection,
    formatFilesForTemplate,
    getAvailableFiles,
    syncAndStripFilesFromChatHistory,
    findFileInCollection,
    // resolveFileParameter is exported inline above
    generateFileMessageContent,
    injectFileIntoChatHistory,
    addFileToCollection,
    loadFileCollection,
    loadFileCollectionAll,
    saveFileCollection,
    updateFileMetadata,
    getCollectionCacheKey,
    getRedisClient,
    checkHashExists,
    ensureShortLivedUrl,
    buildFileCreationResponse,
    uploadFileToCloud,
    uploadImageToCloud,
    resolveFileHashesToContent,
    getInCollectionValue,
    addChatIdToInCollection,
    removeChatIdFromInCollection,
    getMimeTypeFromFilename,
    getMimeTypeFromExtension,
    isTextMimeType,
    isFileInCollection,
    writeFileDataToRedis,
    getActualContentMimeType,
    // isYoutubeUrl is exported inline above
    // Exported for testing
    extractFilenameFromUrl,
    ensureFilenameExtension,
    determineMimeTypeFromUrl
};

