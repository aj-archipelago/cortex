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
import latencyTrace from './latencyTrace.js';

const pipeline = promisify(stream.pipeline);
const MEDIA_API_URL = config.get('whisperMediaApiUrl');

// Feature flag for folder-based storage (default ON)
const USE_FOLDER_STORAGE = process.env.USE_FOLDER_STORAGE !== 'false';


/**
 * Build a fileLocation object for folder-based storage.
 * Returns null if folder storage is disabled or required fields are missing.
 * @param {string} contextId - Logical file context ID
 * @param {Object} options - Additional options
 * @param {string|null} options.userId - Physical user container owner ID
 * @param {string|null} options.chatId - Chat ID (if chat-scoped)
 * @param {string|null} options.workspaceId - Workspace ID (if workspace/applet-scoped)
 * @param {string|null} options.appletId - Applet ID (if applet-scoped)
 * @param {string|null} options.fileScope - File scope override (default: derived from chatId)
 * @returns {Object|null} fileLocation object or null
 */
function parseAppletUserContextId(contextId = null) {
    if (typeof contextId !== 'string' || !contextId.startsWith('applet-user:')) {
        return { appletId: null, userId: null };
    }

    const parts = contextId.split(':');
    if (parts.length < 3) {
        return { appletId: null, userId: null };
    }

    return {
        appletId: parts[1] || null,
        userId: parts.slice(2).join(':') || null,
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

function buildFileLocation(
    contextId,
    {
        userId = null,
        chatId = null,
        workspaceId = null,
        appletId = null,
        fileScope = null,
    } = {},
) {
    if (!USE_FOLDER_STORAGE) return null;
    if (!fileScope) fileScope = chatId ? 'chat' : 'global';

    if (fileScope === 'workspace-shared-legacy') {
        const resolvedContextId = workspaceId || contextId || null;
        if (!resolvedContextId) return null;
        return {
            contextId: resolvedContextId,
            userId: null,
            chatId,
            workspaceId,
            appletId: null,
            fileScope,
        };
    }

    let resolvedContextId = contextId || userId || null;
    let resolvedUserId = userId;
    let resolvedAppletId = appletId;

    if (fileScope === 'applet-user') {
        const parsed = parseAppletUserContextId(resolvedContextId);
        resolvedUserId = resolvedUserId || parsed.userId || resolvedContextId || null;
        resolvedAppletId = resolveAppletScopeId({
            appletId: resolvedAppletId,
            workspaceId,
            contextId: resolvedContextId,
        });
        resolvedContextId = resolvedUserId && resolvedAppletId
            ? buildAppletUserContextId(resolvedUserId, resolvedAppletId)
            : null;
    }

    if (!resolvedContextId) return null;

    return {
        contextId: resolvedContextId,
        userId: resolvedUserId,
        chatId,
        workspaceId,
        appletId: resolvedAppletId,
        fileScope,
    };
}

function getFileLocationContextId(fileLocation = null) {
    if (!fileLocation || typeof fileLocation !== 'object') {
        return null;
    }
    if (fileLocation.contextId) {
        return fileLocation.contextId;
    }
    if (fileLocation.fileScope === 'workspace-shared-legacy') {
        return fileLocation.workspaceId || null;
    }
    return fileLocation.userId || null;
}

/**
 * Construct folder path for file storage based on parsed context.
 * MIRROR: Keep in sync with cortex-file-handler/src/blobHandler.js constructFolderPath()
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
    // ownerId is not interpolated into the folder path; it is only used for
    // container selection and may be a compound scoped context ID.
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
 * Uses xxhash64 to match the hash format used by the file handler
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

/**
 * List files in a folder via the cortex-file-handler API
 * @param {string} folderPath - Folder path to list (e.g., 'users/123/global')
 * @returns {Promise<Array>} Array of file objects
 */
async function listFolderViaAPI(folderPath) {
    const fileHandlerUrl = MEDIA_API_URL;
    if (!fileHandlerUrl || fileHandlerUrl === 'null') {
        return [];
    }

    try {
        // Parse folder path to extract userId, chatId, workspaceId, fileScope
        // Folder path format: users/{userId}/global, users/{userId}/chats/{chatId}, etc.
        const parts = folderPath.split('/');
        let userId = null;
        let chatId = null;
        let workspaceId = null;
        let fileScope = 'global';

        if (parts[0] === 'users' && parts.length >= 3) {
            userId = parts[1];
            if (parts[2] === 'global') {
                fileScope = 'global';
            } else if (parts[2] === 'chats' && parts.length >= 4) {
                fileScope = 'chat';
                chatId = parts[3];
            } else if (parts[2] === 'workspaces' && parts.length >= 4) {
                fileScope = 'workspace';
                workspaceId = parts[3];
            }
        } else if (parts[0] === 'workspaces' && parts.length >= 3) {
            workspaceId = parts[1];
            if (parts[2] === 'artifacts') {
                fileScope = 'workspace-shared-legacy';
            }
        }

        const url = buildFileHandlerUrl(fileHandlerUrl, {
            listFolder: true,
            userId,
            chatId,
            workspaceId,
            fileScope
        });

        const response = await axios.get(url, { timeout: 30000 });

        if (response.data && response.data.files) {
            return response.data.files;
        }
        return [];
    } catch (error) {
        logger.warn(`Failed to list folder ${folderPath}: ${error.message}`);
        return [];
    }
}

/**
 * List files for a given context via the CFH listFolder API.
 * This is the primary way to list files — cloud storage is the source of truth.
 * @param {string} contextId - Logical scoped context ID
 * @param {Object} options
 * @param {string|null} options.userId - Physical user container owner ID
 * @param {string|null} options.appletId - Applet ID for app-private routing
 * @param {string|null} options.chatId - Chat ID (when fileScope='chat')
 * @param {string|null} options.workspaceId - Workspace ID (when fileScope='workspace-user-legacy' or 'workspace-shared-legacy')
 * @param {string} options.fileScope - 'all' | 'global' | 'chat' | 'workspace-user-legacy' (default: 'all')
 * @returns {Promise<Array>} Array of file objects from cloud listing
 */
async function listFilesForContext(
    contextId,
    {
        userId = null,
        appletId = null,
        chatId = null,
        workspaceId = null,
        fileScope = 'all',
    } = {},
) {
    const fileHandlerUrl = MEDIA_API_URL;
    if (!fileHandlerUrl || fileHandlerUrl === 'null' || !contextId) return [];

    const span = latencyTrace.start('files.listContext', {
        contextId,
        userId,
        appletId,
        chatId,
        workspaceId,
        fileScope,
    });
    try {
        const url = buildFileHandlerUrl(fileHandlerUrl, {
            listFolder: true,
            contextId,
            userId,
            appletId,
            chatId,
            workspaceId,
            fileScope
        });

        const response = await axios.get(url, { timeout: 30000 });
        latencyTrace.end(span, {
            status: response?.status,
            fileCount: response.data?.files?.length || 0,
        });
        return response.data?.files || [];
    } catch (error) {
        latencyTrace.end(span, { error: error.message });
        logger.warn(`Failed to list files for context ${contextId}: ${error.message}`);
        return [];
    }
}

function buildAppletUserContextId(userContextId, appletId) {
    if (!userContextId || !appletId) {
        return null;
    }
    return `applet-user:${appletId}:${userContextId}`;
}

function buildAppletSharedContextId(appletId) {
    if (!appletId) {
        return null;
    }
    return `applet-shared:${appletId}`;
}

function normalizeFileAccessPlan(fileAccessPlan) {
    if (!Array.isArray(fileAccessPlan)) {
        return [];
    }

    return fileAccessPlan
        .map((target) => {
            if (!target || typeof target !== 'object') {
                return null;
            }

            if (typeof target.kind === 'string' && target.kind.length > 0) {
                return target;
            }

            return null;
        })
        .filter(Boolean);
}

function resolveFileAccessTargetCandidates(target) {
    if (!target?.kind) {
        return [];
    }

    const contextKey = target.contextKey || null;
    const write = target.write === true;
    const resolved = [];

    switch (target.kind) {
        case 'chat':
            if (!target.userContextId || !target.chatId) {
                return [];
            }
            resolved.push({
                ...target,
                contextId: target.userContextId,
                contextKey,
                fileScope: 'chat',
                readFileScope: 'chat',
                writeFileScope: 'chat',
                chatId: target.chatId,
                workspaceId: null,
                write,
            });
            break;

        case 'user-global':
            if (!target.userContextId) {
                return [];
            }
            resolved.push({
                ...target,
                contextId: target.userContextId,
                contextKey,
                fileScope: 'global',
                readFileScope: 'global',
                writeFileScope: 'global',
                chatId: null,
                workspaceId: null,
                write,
            });
            break;

        case 'user-files':
            if (!target.userContextId) {
                return [];
            }
            resolved.push({
                ...target,
                contextId: target.userContextId,
                contextKey,
                fileScope: 'all',
                readFileScope: 'all',
                writeFileScope: null,
                chatId: null,
                workspaceId: null,
                write: false,
            });
            break;

        case 'app-private': {
            if (!target.userContextId) {
                return [];
            }

            const appletUserContextId = buildAppletUserContextId(
                target.userContextId,
                target.appletId,
            );
            if (appletUserContextId) {
                resolved.push({
                    ...target,
                    contextId: appletUserContextId,
                    contextKey,
                    fileScope: 'applet-user',
                    readFileScope: 'applet-user',
                    writeFileScope: 'applet-user',
                    chatId: null,
                    workspaceId: target.workspaceId || null,
                    write,
                });
            }

            if (target.workspaceId) {
                resolved.push({
                    ...target,
                    contextId: target.userContextId,
                    contextKey,
                    fileScope: 'workspace-user-legacy',
                    readFileScope: 'workspace-user-legacy',
                    writeFileScope: 'workspace-user-legacy',
                    chatId: null,
                    workspaceId: target.workspaceId,
                    write: write && !appletUserContextId,
                });
            }
            break;
        }

        case 'app-shared': {
            const appletSharedContextId = buildAppletSharedContextId(
                target.appletId,
            );
            if (appletSharedContextId) {
                resolved.push({
                    ...target,
                    contextId: appletSharedContextId,
                    contextKey,
                    fileScope: 'applet-shared',
                    readFileScope: 'all',
                    writeFileScope: 'applet-shared',
                    chatId: null,
                    write,
                });
            }

            if (target.workspaceId) {
                resolved.push({
                    ...target,
                    contextId: target.workspaceId,
                    contextKey,
                    fileScope: 'workspace-shared-legacy',
                    readFileScope: 'all',
                    writeFileScope: 'workspace-shared-legacy',
                    chatId: null,
                    workspaceId: target.workspaceId,
                    write: write && !appletSharedContextId,
                });
            }
            break;
        }

        default:
            return [];
    }

    const seen = new Set();
    return resolved.filter((entry) => {
        const key = [
            entry.contextId || '',
            entry.fileScope || '',
            entry.chatId || '',
            entry.workspaceId || '',
        ].join('|');
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function resolveFileAccessPlanTargets(fileAccessPlan) {
    const targets = normalizeFileAccessPlan(fileAccessPlan);
    const resolved = [];
    const seen = new Set();

    targets.forEach((target, targetIndex) => {
        resolveFileAccessTargetCandidates(target).forEach((candidate, candidateIndex) => {
            const key = [
                candidate.contextId || '',
                candidate.fileScope || '',
                candidate.chatId || '',
                candidate.workspaceId || '',
            ].join('|');
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            resolved.push({
                ...candidate,
                _targetIndex: targetIndex,
                _candidateIndex: candidateIndex,
            });
        });
    });

    return resolved;
}

function mergeListedFileWithMetadata(file, metadataFiles = []) {
    if (!file || !Array.isArray(metadataFiles) || metadataFiles.length === 0) {
        return file;
    }

    const metadataMatch =
        (file.hash
            ? metadataFiles.find((candidate) => candidate?.hash === file.hash)
            : null)
        || (file.url ? findFileInCollection(file.url, metadataFiles) : null)
        || (file.gcs ? findFileInCollection(file.gcs, metadataFiles) : null)
        || (file.name ? findFileInCollection(file.name, metadataFiles) : null)
        || (file.filename
            ? findFileInCollection(file.filename, metadataFiles)
            : null)
        || (file.displayFilename
            ? findFileInCollection(file.displayFilename, metadataFiles)
            : null);

    if (!metadataMatch) {
        return file;
    }

    return {
        ...file,
        ...(file.hash ? {} : metadataMatch.hash ? { hash: metadataMatch.hash } : {}),
        ...(file.id ? {} : metadataMatch.id ? { id: metadataMatch.id } : {}),
        ...(file.filename ? {} : metadataMatch.filename ? { filename: metadataMatch.filename } : {}),
        ...(file.displayFilename
            ? {}
            : metadataMatch.displayFilename
              ? { displayFilename: metadataMatch.displayFilename }
              : {}),
        ...(file.gcs ? {} : metadataMatch.gcs ? { gcs: metadataMatch.gcs } : {}),
        ...(file.blobPath ? {} : metadataMatch.blobPath ? { blobPath: metadataMatch.blobPath } : {}),
        ...(file.lastAccessed ? {} : metadataMatch.lastAccessed ? { lastAccessed: metadataMatch.lastAccessed } : {}),
        ...(file.mimeType ? {} : metadataMatch.mimeType ? { mimeType: metadataMatch.mimeType } : {}),
        ...(file.permanent !== undefined
            ? {}
            : metadataMatch.permanent !== undefined
              ? { permanent: metadataMatch.permanent }
              : {}),
    };
}

async function listFilesForFileAccessPlan(fileAccessPlan) {
    const targets = resolveFileAccessPlanTargets(fileAccessPlan);
    if (targets.length === 0) {
        return [];
    }

    const span = latencyTrace.start('files.listAccessPlan', {
        targetCount: targets.length,
        contextIds: targets.map((target) => target.contextId).join(','),
    });
    const allFiles = [];
    for (const target of targets) {
        const targetSpan = latencyTrace.start('files.listAccessPlanTarget', {
            contextId: target.contextId,
            kind: target.kind,
            readFileScope: target.readFileScope || 'all',
            write: target.write === true,
        });
        const [files, metadataFiles] = await Promise.all([
            listFilesForContext(target.contextId, {
                userId: target.userContextId || null,
                appletId: target.appletId || null,
                chatId: target.chatId || null,
                workspaceId: target.workspaceId || null,
                fileScope: target.readFileScope || 'all',
            }),
            loadFileCollection([target], { useCache: true }),
        ]);
        latencyTrace.end(targetSpan, {
            fileCount: files.length,
            metadataFileCount: metadataFiles.length,
        });

        allFiles.push(
            ...files.map((file) => ({
                ...mergeListedFileWithMetadata(file, metadataFiles),
                _contextId: target.contextId,
                _contextKey: target.contextKey || null,
                _contextFileScope: target.fileScope || null,
                _fileAccessKind: target.kind,
                _readFileScope: target.readFileScope || 'all',
                _writeFileScope: target.writeFileScope || null,
                _writeTarget: target.write === true,
            })),
        );
    }

    const seenHashes = new Map();
    const seenUrls = new Map();
    const deduped = [];

    for (const file of allFiles) {
        const duplicateIndex =
            (file.hash && seenHashes.has(file.hash)
                ? seenHashes.get(file.hash)
                : null)
            ?? (file.url && seenUrls.has(file.url)
                ? seenUrls.get(file.url)
                : null);

        if (duplicateIndex !== null && duplicateIndex !== undefined) {
            const existing = deduped[duplicateIndex];
            if (existing && file._writeTarget === true && existing._writeTarget !== true) {
                deduped[duplicateIndex] = {
                    ...existing,
                    _contextId: file._contextId,
                    _contextKey: file._contextKey,
                    _contextFileScope: file._contextFileScope,
                    _fileAccessKind: file._fileAccessKind,
                    _readFileScope: file._readFileScope,
                    _writeFileScope: file._writeFileScope,
                    _writeTarget: true,
                };
            } else if (existing) {
                existing._writeTarget = existing._writeTarget === true || file._writeTarget === true;
            }
            continue;
        }

        deduped.push(file);
        const nextIndex = deduped.length - 1;
        if (file.hash) seenHashes.set(file.hash, nextIndex);
        if (file.url) seenUrls.set(file.url, nextIndex);
    }

    latencyTrace.end(span, {
        rawFileCount: allFiles.length,
        dedupedFileCount: deduped.length,
    });
    return deduped.sort((a, b) => getFileTimestampMs(b) - getFileTimestampMs(a));
}

const HASH_REF_RE = /^[a-f0-9]{16,128}$/i;

function extractHashFromFileRef(fileParam) {
    if (!fileParam || typeof fileParam !== 'string') return null;
    const trimmed = fileParam.trim();
    if (HASH_REF_RE.test(trimmed)) return trimmed;

    const normalizedPath = normalizePathForMatch(trimmed);
    const basename = normalizedPath
        ? path.posix.basename(normalizedPath)
        : trimmed.split(/[/?#]/).filter(Boolean).pop() || '';
    const hashPrefix = basename.match(/^([a-f0-9]{16,128})(?:[_-]|$)/i);
    return hashPrefix?.[1] || null;
}

function extractBlobPathFromManagedUrl(fileParam) {
    if (!fileParam || typeof fileParam !== 'string' || !/^https?:\/\//i.test(fileParam)) {
        return null;
    }

    try {
        const url = new URL(fileParam);
        const host = url.hostname.toLowerCase();
        const isAzureBlobUrl =
            host.endsWith('.blob.core.windows.net') ||
            url.pathname.split('/').filter(Boolean)[0] === 'devstoreaccount1';
        if (!isAzureBlobUrl) {
            return null;
        }

        let parts = url.pathname
            .split('/')
            .filter(Boolean)
            .map((segment) => safeDecodeURIComponent(segment));

        // Azurite URLs include the storage account before the container.
        if (parts[0] === 'devstoreaccount1') {
            parts = parts.slice(1);
        }

        // Azure blob URLs are /container/blob/path. If the URL shape does not
        // include a container and a blob path, leave it as a direct URL.
        if (parts.length < 2) {
            return null;
        }

        return parts.slice(1).join('/') || null;
    } catch {
        return null;
    }
}

function extractBlobPathFromFileRef(fileParam) {
    if (!fileParam || typeof fileParam !== 'string') return null;
    const trimmed = fileParam.trim();
    if (!trimmed) return null;

    const managedUrlBlobPath = extractBlobPathFromManagedUrl(trimmed);
    if (managedUrlBlobPath) {
        return managedUrlBlobPath;
    }

    const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
    const workspacePrefix = 'workspace/files/';
    if (normalized.startsWith(workspacePrefix)) {
        return normalized.slice(workspacePrefix.length).replace(/^\/+/, '') || null;
    }

    if (/^(global|chats|applets|applet-shared|media|profile|articles|skills)\//i.test(normalized)) {
        return normalized;
    }

    return null;
}

async function lookupFileByBlobPath(blobPath, fileHandlerUrl, target) {
    if (!blobPath || !fileHandlerUrl || !target) {
        return null;
    }

    try {
        const lookupUrl = buildFileHandlerUrl(fileHandlerUrl, {
            blobPath,
            contextId: target.contextId || null,
            userId: target.userContextId || null,
            chatId: target.chatId || null,
            workspaceId: target.workspaceId || null,
            appletId: target.appletId || null,
            fileScope: target.readFileScope || target.fileScope || null,
            shortLivedMinutes: 5,
        });
        const response = await axios.get(lookupUrl, {
            timeout: 2000,
            validateStatus: (status) => status >= 200 && status < 500,
        });

        if (response.status !== 200 || !response.data?.url) {
            return null;
        }

        const data = response.data;
        const url = data.shortLivedUrl || data.url;
        return {
            ...data,
            url,
            shortLivedUrl: data.shortLivedUrl || url,
            blobPath: data.blobPath || blobPath,
            name: data.blobPath || blobPath,
            filename: data.filename || path.posix.basename(blobPath),
            _contextId: target.contextId || null,
            _contextKey: target.contextKey || null,
            _contextFileScope: target.fileScope || null,
            _fileAccessKind: target.kind || null,
            _readFileScope: target.readFileScope || null,
            _writeTarget: target.write === true,
        };
    } catch (error) {
        logger.warn(`BlobPath lookup failed for ${blobPath}: ${error.message}`);
        return null;
    }
}

async function findFileInFileAccessPlanDirect(fileParam, fileAccessPlan, options = {}) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    const plan = resolveFileAccessPlanTargets(fileAccessPlan);
    if (plan.length === 0) {
        return null;
    }

    const trimmed = fileParam.trim();
    if (!trimmed) {
        return null;
    }

    const fileHandlerUrl = options.fileHandlerUrl || MEDIA_API_URL;
    const blobPath = extractBlobPathFromFileRef(trimmed);
    if (blobPath && fileHandlerUrl) {
        for (const target of plan) {
            const found = await lookupFileByBlobPath(blobPath, fileHandlerUrl, target);
            if (found?.url) return found;
        }
    }

    if (/^https?:\/\//i.test(trimmed)) {
        return {
            url: trimmed,
            hash: extractHashFromFileRef(trimmed),
            filename: extractFilenameFromUrl(trimmed) || trimmed,
        };
    }

    const hash = extractHashFromFileRef(trimmed);
    if (hash && fileHandlerUrl) {
        for (const target of plan) {
            const found = await checkHashExists(hash, fileHandlerUrl, null, target.contextId || null);
            if (found?.url) {
                return {
                    ...found,
                    _contextId: target.contextId || null,
                    filename: found.filename || hash,
                };
            }
        }
    }

    return null;
}

async function findFileInFileAccessPlan(fileParam, fileAccessPlan, options = {}) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    const direct = await findFileInFileAccessPlanDirect(fileParam, fileAccessPlan, options);
    if (direct) {
        return direct;
    }

    const files = await listFilesForFileAccessPlan(fileAccessPlan);
    return findFileInCollection(fileParam, files);
}

function getWriteFileAccessTarget(fileAccessPlan) {
    return resolveFileAccessPlanTargets(fileAccessPlan).find(
        (target) => target.write === true,
    ) || null;
}

function getFileContextId(fileObject, fileAccessPlan) {
    if (fileObject?._contextId) {
        return fileObject._contextId;
    }

    const writeTarget = getWriteFileAccessTarget(fileAccessPlan);
    return writeTarget?.contextId || null;
}

/**
 * Load legacy files from Redis for a given contextId
 * Used during migration to find files that haven't been migrated to folder storage yet
 * @param {string} contextId - Context ID to load files from
 * @param {string} contextKey - Optional context key for decryption
 * @returns {Promise<Array>} Array of legacy file objects from Redis
 */
async function loadLegacyFilesFromRedis(contextId, contextKey = null) {
    if (!contextId) return [];

    try {
        const redisClient = await getRedisClient();
        if (!redisClient) return [];

        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
        const filesData = await redisClient.hgetall(contextMapKey);

        if (!filesData || Object.keys(filesData).length === 0) {
            return [];
        }

        // Parse files and mark as legacy
        const files = [];
        for (const [hash, dataStr] of Object.entries(filesData)) {
            try {
                const fileData = JSON.parse(dataStr);
                // Only return files that don't have folderPath set (legacy flat storage)
                if (!fileData.folderPath) {
                    files.push({
                        ...fileData,
                        hash,
                        _isLegacy: true
                    });
                }
            } catch (e) {
                // Skip malformed entries
            }
        }

        return files;
    } catch (error) {
        logger.warn(`Failed to load legacy files from Redis for ${contextId}: ${error.message}`);
        return [];
    }
}

/**
 * Migrate legacy files to folder-based storage asynchronously
 * Fire-and-forget - doesn't block reads on migration
 * @param {Array} legacyFiles - Array of legacy file objects
 * @param {string} userId - User ID for target folder path
 * @param {string} workspaceId - Optional workspace ID
 * @param {string} contextId - Context ID for cleanup after migration
 */
async function migrateFilesToFoldersAsync(legacyFiles, userId, workspaceId = null, contextId = null) {
    if (!legacyFiles || legacyFiles.length === 0 || !userId) return;

    // Fire-and-forget async migration
    (async () => {
        const fileHandlerUrl = MEDIA_API_URL;
        if (!fileHandlerUrl) {
            logger.warn('Cannot migrate files: WHISPER_MEDIA_API_URL not set');
            return;
        }

        let migratedCount = 0;
        let failedCount = 0;

        for (const file of legacyFiles) {
            try {
                // Determine target folder based on inCollection metadata
                let fileScope = 'global';
                let chatId = null;

                if (file.inCollection) {
                    const inCol = Array.isArray(file.inCollection) ? file.inCollection : [];
                    // If inCollection has specific chatIds (not just '*'), migrate to first chat folder
                    const chatIds = inCol.filter(id => id !== '*');
                    if (chatIds.length > 0) {
                        fileScope = 'chat';
                        chatId = chatIds[0]; // Use first chatId
                    }
                }

                // Skip files without URL
                if (!file.url) {
                    logger.warn(`Skipping migration for file ${file.hash}: no URL`);
                    continue;
                }

                // Re-upload file to folder-based storage
                const fileLocation = { userId, chatId, workspaceId, fileScope };
                await uploadFileToCloud(file.url, null, file.displayFilename || file.filename, null, fileLocation);

                // After successful migration, update Redis entry to mark as migrated
                // (Don't delete yet - let lazy cleanup handle that)
                try {
                    const redisClient = await getRedisClient();
                    if (redisClient && contextId) {
                        const contextMapKey = `FileStoreMap:ctx:${contextId}`;
                        const existingStr = await redisClient.hget(contextMapKey, file.hash);
                        if (existingStr) {
                            const existing = JSON.parse(existingStr);
                            existing.folderPath = constructFolderPath(fileLocation);
                            existing._migratedAt = new Date().toISOString();
                            await redisClient.hset(contextMapKey, file.hash, JSON.stringify(existing));
                        }
                    }
                } catch (e) {
                    // Non-critical - migration still succeeded
                    logger.warn(`Failed to update Redis after migration: ${e.message}`);
                }

                migratedCount++;
            } catch (error) {
                failedCount++;
                logger.warn(`Failed to migrate file ${file.hash}: ${error.message}`);
            }
        }

        if (migratedCount > 0 || failedCount > 0) {
            logger.info(`Migration complete: ${migratedCount} files migrated, ${failedCount} failed`);
        }
    })().catch(error => {
        logger.error(`Migration batch failed: ${error.message}`);
    });
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
            try {
                fs.unlinkSync(localFilePath);
            } catch (_unlinkErr) {
                // Ignore cleanup errors (file may not have been created)
            }
            reject(error);
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
async function getMediaChunks(file, requestId, contextId = null, options = {}) {
    try {
        if (MEDIA_API_URL) {
            const url = buildFileHandlerUrl(MEDIA_API_URL, {
                uri: file,
                requestId,
                ...(contextId ? { contextId } : {}),
                ...(options.chunkOverlapSeconds
                    ? { chunkOverlapSeconds: options.chunkOverlapSeconds }
                    : {})
            });
            const res = await axios.get(url, { timeout: 600000 });
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
        return JSON.parse(dataStr);
    } catch (e) {
        return null;
    }
}

/**
 * Parse raw Redis hash map data into file objects (without filtering)
 * @param {Object} allFiles - Redis HGETALL result {hash: fileDataStr}
 * @param {string} contextKey - Optional context key for decryption
 * @returns {Array} Array of parsed file data objects
 */
function parseRawFileData(allFiles, contextKey = null) {
    return Object.entries(allFiles).map(([hash, fileDataStr]) => {
        const decryptedData = readFileDataFromRedis(fileDataStr, contextKey);
        if (!decryptedData) {
            return null;
        }

        // Return parsed file data with hash
        return {
            id: decryptedData.id || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            url: decryptedData.url,
            displayFilename: decryptedData.displayFilename || decryptedData.filename || null,
            mimeType: decryptedData.mimeType || null,
            hash: hash,
            permanent: decryptedData.permanent || false,
            lastAccessed: decryptedData.lastAccessed || decryptedData.timestamp || new Date().toISOString(),
        };
    }).filter(Boolean);
}

/**
 * Sort files by lastAccessed (most recent first)
 * @param {Array} files - Array of file objects
 * @returns {Array} Sorted array
 */
function sortFilesByLastAccessed(files) {
    return files.sort((a, b) => {
        const aDate = new Date(a.lastAccessed || 0);
        const bDate = new Date(b.lastAccessed || 0);
        return bDate - aDate;
    });
}

/**
 * Load file collection from an ordered file access plan.
 *
 * @param {Array} fileAccessPlan - Ordered file access targets
 * @param {Object} options - Load options
 * @param {boolean} options.useCache - Whether to use cache (default: true)
 * @returns {Promise<Array>} File collection (deduplicated across contexts, sorted by lastAccessed)
 */
async function loadFileCollection(fileAccessPlan, options = {}) {
    const targets = resolveFileAccessPlanTargets(fileAccessPlan);
    if (targets.length === 0) {
        return [];
    }

    const useCache = options.useCache !== false; // default true
    const span = latencyTrace.start('files.loadCollection', {
        targetCount: targets.length,
        useCache,
        contextIds: targets.map((target) => target.contextId).join(','),
    });

    // Load files from all contexts
    let allFiles = [];

    for (const target of targets) {
        const contextId = target.contextId;
        const contextKey = target.contextKey || null;
        const cacheKey = getCollectionCacheKey(contextId, contextKey);

        let rawFiles = [];
        let cacheHit = false;

        // Check cache first
        if (useCache && fileCollectionCache.has(cacheKey)) {
            const cached = fileCollectionCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                rawFiles = cached.rawFiles;
                cacheHit = true;
            }
        }

        // Load from Redis if not cached
        if (rawFiles.length === 0) {
            try {
                const redisClient = await getRedisClient();
                if (redisClient) {
                    const contextMapKey = `FileStoreMap:ctx:${contextId}`;
                    const filesData = await redisClient.hgetall(contextMapKey);
                    rawFiles = parseRawFileData(filesData, contextKey);

                    // Update cache
                    if (useCache) {
                        fileCollectionCache.set(cacheKey, {
                            rawFiles: rawFiles,
                            timestamp: Date.now()
                        });
                    }
                }
            } catch (e) {
                // Collection doesn't exist yet or error reading
                rawFiles = [];
            }
        }
        latencyTrace.mark('files.loadCollectionTarget', {
            contextId,
            cacheHit,
            rawFileCount: rawFiles.length,
        });

        // Tag files with their source context
        allFiles.push(...rawFiles.map(f => ({ ...f, _contextId: contextId })));
    }

    // Deduplicate by hash/url (keep first occurrence - primary context wins)
    const seenHashes = new Set();
    const seenUrls = new Set();
    const deduped = [];

    for (const file of allFiles) {
        const isDupe = (file.hash && seenHashes.has(file.hash)) ||
                       (file.url && seenUrls.has(file.url));
        if (!isDupe) {
            if (file.hash) seenHashes.add(file.hash);
            if (file.url) seenUrls.add(file.url);
            deduped.push(file);
        }
    }

    latencyTrace.end(span, {
        rawFileCount: allFiles.length,
        dedupedFileCount: deduped.length,
    });
    return sortFilesByLastAccessed(deduped);
}

/**
 * Update file metadata in Redis hash map (direct atomic operation)
 * @param {string} contextId - Context ID
 * @param {string} hash - File hash
 * @param {Object} metadata - Metadata to update (displayFilename, id, mimeType, lastAccessed, permanent)
 * @param {string} contextKey - Optional context key for encryption
 * Note: Does NOT update CFH core fields (url, hash, filename) - those are managed by CFH
 * @returns {Promise<boolean>} True if successful
 */
async function updateFileMetadata(contextId, hash, metadata, contextKey = null) {
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
        // Only update Cortex-managed fields, preserve CFH fields (url, hash, filename)
        const fileData = {
            ...existingData, // Preserve all CFH data (url, hash, filename, etc.)
            // Update only Cortex-managed metadata fields
            ...(metadata.displayFilename !== undefined && { displayFilename: metadata.displayFilename }),
            ...(metadata.id !== undefined && { id: metadata.id }),
            ...(metadata.mimeType !== undefined && { mimeType: metadata.mimeType }),
            ...(metadata.lastAccessed !== undefined && { lastAccessed: metadata.lastAccessed }),
            ...(metadata.permanent !== undefined && { permanent: metadata.permanent })
        };

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

async function updateFileMetadataInFileAccessPlan(fileAccessPlan, hash, metadata) {
    const plan = normalizeFileAccessPlan(fileAccessPlan);
    if (plan.length === 0 || !hash) {
        return false;
    }

    const files = await listFilesForFileAccessPlan(plan);
    const matchedFile = findFileInCollection(hash, files);
    if (matchedFile?._contextId) {
        const targetContext = resolveFileAccessPlanTargets(plan).find(
            (target) => target.contextId === matchedFile._contextId,
        );
        if (targetContext?.write === true) {
            return updateFileMetadata(
                targetContext.contextId,
                hash,
                metadata,
                targetContext.contextKey || null,
            );
        }
    }

    const writeTarget = getWriteFileAccessTarget(plan);
    if (!writeTarget?.contextId) {
        return false;
    }

    return updateFileMetadata(
        writeTarget.contextId,
        hash,
        metadata,
        writeTarget.contextKey || null,
    );
}

/**
 * Save file collection to memory system
 * Only updates files that have changed (optimized)
 * @param {string} contextId - Context ID for the file collection
 * @param {string} contextKey - Optional context key for encryption (unused with hash maps)
 * @param {Array} collection - File collection array
 * @returns {Promise<boolean>} True if successful
 */
async function saveFileCollection(contextId, contextKey, collection) {
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
                    // Compare metadata fields (ignore CFH fields like url, timestamp)
                    if (currentData.id === file.id &&
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
                // Preserve all CFH fields (url, filename, displayFilename, etc.)
                const fileData = {
                    ...existingData, // Preserve all CFH data first
                    id: file.id,
                    url: file.url || existingData.url, // Preserve URL (CFH-managed)
                    // Preserve CFH's filename (CFH-managed), only update displayFilename (Cortex-managed)
                    displayFilename: file.displayFilename !== undefined ? file.displayFilename : (existingData.displayFilename || null),
                    mimeType: file.mimeType || existingData.mimeType || null,
                    lastAccessed: file.lastAccessed || new Date().toISOString(),
                    permanent: file.permanent !== undefined ? file.permanent : (existingData.permanent || false)
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
 * @param {string} filename - Filename or title for the file
 * @param {string} hash - Optional file hash
 * @param {string} fileUrl - Optional: URL of file to upload (if not already in cloud storage)
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @param {boolean} permanent - If true, file is stored with permanent retention
 * @param {string|null} chatId - Optional chat ID for folder-based storage (chat-scoped if provided, global if not)
 * @param {Object} options - Additional routing options
 * @param {string|null} options.workspaceId - Workspace ID for workspace-user-legacy or workspace-shared-legacy scope
 * @param {string|null} options.appletId - Applet ID for app-private scope
 * @param {string|null} options.fileScope - File scope override (default: derived from chatId)
 * @returns {Promise<Object>} File entry object with id
 */
async function addFileToCollection(contextId, contextKey, url, filename, hash = null, fileUrl = null, pathwayResolver = null, permanent = false, chatId = null, { workspaceId, appletId = null, fileScope } = {}) {
    if (!contextId || !filename) {
        throw new Error("contextId and filename are required");
    }

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
    let finalHash = hash;

    if (fileUrl && (!url || (!url.includes('blob.core.windows.net') && !url.includes('storage.googleapis.com')))) {
        // Reject local/workspace paths — fileUrl must be an HTTP/HTTPS URL
        if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
            throw new Error(`fileUrl must be an HTTP/HTTPS URL, not a local path ("${fileUrl}"). To save workspace files, use WorkspaceSSH with 'files push' command.`);
        }
        // Upload the file from the URL
        // uploadFileToCloud will download it, compute hash, check if it exists, and upload if needed

        // Derive fileLocation from userId and routing options for folder-based storage
        // contextId is used as userId for backward compatibility
        const fileLocation = buildFileLocation(contextId, {
            chatId,
            workspaceId,
            appletId,
            fileScope,
        });

        const fileMimeType = getMimeTypeFromFilename(filename) || getMimeTypeFromFilename(fileUrl) || null;
        const uploadResult = await uploadFileToCloud(fileUrl, fileMimeType, filename, pathwayResolver, fileLocation);
        finalUrl = uploadResult.url;
        finalHash = uploadResult.hash || hash;
    }

    if (!finalUrl) {
        throw new Error("url or fileUrl is required");
    }

    // Determine MIME type from URL (the actual stored content)
    const mimeType = determineMimeTypeFromUrl(finalUrl, null, null);

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
        displayFilename: filename, // Keep original user-provided filename as displayFilename (NOT corrected by MIME type)
        mimeType: mimeType, // MIME type from actual URL content (may differ from displayFilename extension)
        hash: storageHash, // Use storageHash (actual hash or generated from URL)
        permanent: permanent,
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

                // IMPORTANT: Use existing ID if file already exists, to prevent ID mismatch
                // between what we return and what's actually stored in Redis
                const actualId = existingData.id || fileEntry.id;

                const fileData = {
                    ...existingData, // Preserve CFH data (url, filename, etc.)
                    // Update Cortex metadata (use existing ID if entry exists, otherwise new ID)
                    id: actualId,
                    url: finalUrl, // Use new URL (guaranteed to be truthy at this point)
                    // Preserve CFH's filename (managed by CFH), store user-provided filename as displayFilename
                    displayFilename: filename,
                    mimeType: fileEntry.mimeType || existingData.mimeType || null,
                    lastAccessed: new Date().toISOString(), // Always update lastAccessed
                    permanent: fileEntry.permanent !== undefined ? fileEntry.permanent : (existingData.permanent || false),
                    hash: storageHash, // Store the hash used as key (actual hash or generated from URL)
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
    return determineMimeTypeFromUrl(file.url, null, null);
}

function isFileLikeMessageContent(content) {
    const checkObject = (item) => {
        const contentObj = typeof item === 'string' ? tryParseJson(item) : item;
        return Boolean(contentObj && (contentObj.type === 'image_url' || contentObj.type === 'file'));
    };

    if (Array.isArray(content)) {
        return content.some(checkObject);
    }

    return checkObject(content);
}

function chatHistoryHasFileLikeContent(chatHistory) {
    return chatHistory.some((message) =>
        message?.role === 'user' &&
        message.content &&
        isFileLikeMessageContent(message.content)
    );
}

function getMinimalFilePlaceholder(contentObj) {
    if (!contentObj || typeof contentObj !== 'object') {
        return null;
    }

    const itemUrl = contentObj.url || contentObj.image_url?.url;
    if (itemUrl && isYoutubeUrl(itemUrl)) {
        const displayName = contentObj.displayFilename || contentObj.filename || contentObj.originalFilename || 'YouTube Video';
        return `[${displayName}: ${itemUrl}]`;
    }

    const directWorkspacePath =
        typeof contentObj.workspacePath === 'string' && contentObj.workspacePath.startsWith('/workspace/files/')
            ? contentObj.workspacePath
            : typeof contentObj.path === 'string' && contentObj.path.startsWith('/workspace/files/')
                ? contentObj.path
                : null;
    const hasCloudPathHint = Boolean(contentObj.name || contentObj.blobPath || contentObj.folderPath);
    const wsPath = directWorkspacePath || (hasCloudPathHint
        ? getWorkspacePathForFile({
            ...contentObj,
            name: contentObj.name || contentObj.blobPath,
        }, null)
        : null);
    const hash = contentObj.hash || null;
    const gcs = contentObj.gcs || contentObj.gcsUrl || null;
    const blobPathFromUrl = extractBlobPathFromManagedUrl(itemUrl);
    const isCloudStorageUrl = (() => {
        if (!itemUrl || typeof itemUrl !== 'string') return false;
        try {
            const host = new URL(itemUrl).hostname.toLowerCase();
            return host.endsWith('.blob.core.windows.net') ||
                host === 'storage.googleapis.com' ||
                host.endsWith('.storage.googleapis.com') ||
                host === '127.0.0.1' ||
                host === 'localhost';
        } catch {
            return false;
        }
    })();
    const isManagedUrl =
        itemUrl &&
        MEDIA_API_URL &&
        MEDIA_API_URL !== 'null' &&
        normalizeUrlForMatch(itemUrl)?.startsWith(normalizeUrlForMatch(MEDIA_API_URL));

    if (!gcs && !wsPath && !blobPathFromUrl && !isManagedUrl && !isCloudStorageUrl) {
        return null;
    }

    const filename =
        contentObj.displayFilename ||
        contentObj.filename ||
        contentObj.originalFilename ||
        extractFilenameFromFileContent(contentObj);
    const refs = [
        wsPath || (blobPathFromUrl ? path.posix.join('/workspace/files', blobPathFromUrl) : null),
        hash ? `hash: ${hash}` : null,
        gcs,
        isCloudStorageUrl ? itemUrl : null,
    ].filter(Boolean).join(', ');

    return `[File: ${filename}${refs ? ` (${refs})` : ''} - available via file tools]`;
}

function replaceFileLikeContentMinimal(content, { arrayItem = false } = {}) {
    const contentObj = typeof content === 'string' ? tryParseJson(content) : content;
    if (!contentObj || (contentObj.type !== 'image_url' && contentObj.type !== 'file')) {
        return content;
    }

    const placeholder = getMinimalFilePlaceholder(contentObj);
    if (!placeholder) {
        return contentObj;
    }

    return arrayItem ? { type: 'text', text: placeholder } : placeholder;
}

async function syncAndStripFilesFromChatHistory(chatHistory, fileAccessPlan) {
    if (!chatHistory || !Array.isArray(chatHistory)) {
        return { chatHistory: chatHistory || [] };
    }

    if (!fileAccessPlan || !Array.isArray(fileAccessPlan) || fileAccessPlan.length === 0) {
        return { chatHistory };
    }

    const targets = resolveFileAccessPlanTargets(fileAccessPlan);
    if (targets.length === 0) {
        return { chatHistory };
    }

    if (!chatHistoryHasFileLikeContent(chatHistory)) {
        return { chatHistory };
    }

    const processedHistory = chatHistory.map(message => {
        if (!message || message.role !== 'user' || !message.content) {
            return message;
        }

        if (Array.isArray(message.content)) {
            return {
                ...message,
                content: message.content.map(item => replaceFileLikeContentMinimal(item, { arrayItem: true })),
            };
        }

        if (typeof message.content === 'object' && message.content !== null) {
            return { ...message, content: replaceFileLikeContentMinimal(message.content) };
        }

        if (typeof message.content === 'string') {
            return { ...message, content: replaceFileLikeContentMinimal(message.content) };
        }

        return message;
    });

    return { chatHistory: processedHistory };
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
 * First tries exact matches, then falls back to simple "contains" matches on displayFilename, filename, and URL
 * @param {string} fileParam - File ID, URL (Azure or GCS), hash, or filename
 * @param {Array} collection - File collection array
 * @returns {Object|null} File entry from collection, or null if not found
 */
function safeDecodeURIComponent(value) {
    if (typeof value !== 'string') return value;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function normalizeUrlForMatch(urlValue) {
    if (!urlValue || typeof urlValue !== 'string') return null;
    const trimmed = urlValue.trim();
    if (!trimmed) return null;
    try {
        const parsed = new URL(trimmed);
        const pathname = safeDecodeURIComponent(parsed.pathname || '').replace(/\/+/g, '/');
        return `${parsed.protocol}//${parsed.host}${pathname}`.toLowerCase();
    } catch {
        return null;
    }
}

function normalizePathForMatch(pathValue) {
    if (!pathValue || typeof pathValue !== 'string') return null;
    let normalized = pathValue.trim();
    if (!normalized) return null;

    // If this is a URL, convert to a path-like shape first.
    try {
        const parsed = new URL(normalized);
        normalized = safeDecodeURIComponent(parsed.pathname || '');
        // Azure/GCS URLs: drop container/bucket segment to align with blob names.
        const urlParts = normalized.replace(/^\/+/, '').split('/').filter(Boolean);
        if (urlParts.length >= 2) {
            normalized = urlParts.slice(1).join('/');
        } else if (urlParts.length === 1) {
            normalized = urlParts[0];
        } else {
            normalized = '';
        }
    } catch {
        // Not a URL, continue.
    }

    normalized = normalized
        .replace(/[?#].*$/, '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\/+/, '');

    const lowered = normalized.toLowerCase();
    const prefixes = [
        '/workspace/files/',
        'workspace/files/',
        '/files/',
        'files/',
        '/workspace/',
        'workspace/',
    ];
    for (const prefix of prefixes) {
        if (lowered.startsWith(prefix)) {
            normalized = normalized.slice(prefix.length);
            break;
        }
    }

    normalized = safeDecodeURIComponent(normalized)
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/');

    if (!normalized) return null;
    return normalized.toLowerCase();
}

function getFilePathKeys(file) {
    const keys = new Set();
    if (!file || typeof file !== 'object') return keys;

    const add = (value) => {
        if (!value || typeof value !== 'string') return;
        const normalized = normalizePathForMatch(value);
        if (!normalized) return;
        keys.add(normalized);
        const basename = path.posix.basename(normalized);
        if (basename) keys.add(basename.toLowerCase());
    };

    add(file.name);
    add(file.filename);
    add(file.displayFilename);
    add(file.url);
    add(file.gcs);
    return keys;
}

function getFileTimestampMs(file) {
    if (!file || typeof file !== 'object') return 0;
    const ts = file.lastModified || file.lastAccessed || 0;
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function pickMostRecentFile(files) {
    if (!Array.isArray(files) || files.length === 0) return null;
    if (files.length === 1) return files[0];
    return [...files].sort((a, b) => getFileTimestampMs(b) - getFileTimestampMs(a))[0] || null;
}

function findFileInCollection(fileParam, collection) {
    if (!fileParam || typeof fileParam !== 'string' || !Array.isArray(collection)) {
        return null;
    }

    const trimmed = fileParam.trim();
    if (!trimmed) return null;

    const normalizedParam = trimmed.toLowerCase();
    const normalizedParamUrl = normalizeUrlForMatch(trimmed);
    const normalizedParamPath = normalizePathForMatch(trimmed);
    const paramBasename = normalizedParamPath
        ? path.posix.basename(normalizedParamPath)
        : path.posix.basename(normalizedParam);
    const basenameMatches = [];

    // First, try strong exact matches.
    for (const file of collection) {
        // Check by ID
        if (file.id === trimmed) {
            return file;
        }

        // Check by hash
        if (file.hash === trimmed) {
            return file;
        }

        // Check by URL (normalized; ignores query tokens).
        if (normalizedParamUrl) {
            const fileUrl = normalizeUrlForMatch(file.url);
            const fileGcs = normalizeUrlForMatch(file.gcs);
            if (fileUrl === normalizedParamUrl || fileGcs === normalizedParamUrl) {
                return file;
            }
        } else if (file.url === trimmed || file.gcs === trimmed) {
            return file;
        }

        const pathKeys = getFilePathKeys(file);
        if (normalizedParamPath) {
            // If the input includes directories, treat as a strong path match.
            if (normalizedParamPath.includes('/') && pathKeys.has(normalizedParamPath)) {
                return file;
            }

            // Exact basename match is common when caller provides a rough path.
            if (paramBasename && pathKeys.has(paramBasename)) {
                basenameMatches.push(file);
            }
        } else if (paramBasename && pathKeys.has(paramBasename)) {
            basenameMatches.push(file);
        }
    }

    if (basenameMatches.length > 0) {
        return pickMostRecentFile(basenameMatches);
    }

    // Fallback: broad contains match (best effort) across known identifiers.
    const fallbackNeedles = [normalizedParam];
    if (normalizedParamPath && normalizedParamPath !== normalizedParam) {
        fallbackNeedles.push(normalizedParamPath);
    }
    if (paramBasename && paramBasename !== normalizedParam && paramBasename !== normalizedParamPath) {
        fallbackNeedles.push(paramBasename);
    }

    const fallbackCandidates = [];
    for (const file of collection) {
        const haystacks = [
            file.displayFilename,
            file.filename,
            file.name,
            file.url,
            file.gcs,
            ...getFilePathKeys(file),
        ]
            .filter(Boolean)
            .map(v => String(v).toLowerCase());

        const hasMatch = fallbackNeedles.some((needle) => {
            // Avoid very short fuzzy matches (too many false positives).
            if (!needle || needle.length < 4) return false;
            return haystacks.some(h => h.includes(needle));
        });

        if (hasMatch) {
            fallbackCandidates.push(file);
        }
    }

    if (fallbackCandidates.length > 0) {
        // If caller provided any basename at all, prioritize basename matches first.
        if (paramBasename && paramBasename.length >= 2) {
            const basenameCandidates = fallbackCandidates.filter((file) => {
                const keys = getFilePathKeys(file);
                return keys.has(paramBasename);
            });
            if (basenameCandidates.length > 0) {
                return pickMostRecentFile(basenameCandidates);
            }
        }
        return pickMostRecentFile(fallbackCandidates);
    }

    return null;
}

/**
 * Resolve a file parameter to a URL by looking it up in the file collection.
 * Searches the ordered file access plan in precedence order.
 * @param {string} fileParam - File ID, URL (Azure or GCS), hash, or filename from collection
 * @param {Array} fileAccessPlan - Ordered file access targets
 * @param {Object} [options] - Options
 * @returns {Promise<string|null>} Resolved file URL, or null if not found
 */
export async function resolveFileParameter(fileParam, fileAccessPlan, options = {}) {
    if (!fileParam || typeof fileParam !== 'string') {
        return null;
    }

    const trimmed = fileParam.trim();

    const plan = normalizeFileAccessPlan(fileAccessPlan);
    if (plan.length === 0) {
        return null;
    }

    try {
        const foundFile = await findFileInFileAccessPlan(trimmed, plan, options);

        if (foundFile?.url) {
            return foundFile.url;
        }

        return null;
    } catch (error) {
        logger.warn(`Failed to resolve file parameter "${trimmed}": ${error.message}`);
        return null;
    }
}

/**
 * Generate file message content by looking up a file parameter in the file collection.
 * @param {string} fileParam - File URL (Azure or GCS), file ID from collection, or file hash
 * @param {Array} fileAccessPlan - Ordered file access targets
 * @returns {Promise<Object|null>} Content object in the format for chat history, or null if not found
 */
async function generateFileMessageContent(fileParam, fileAccessPlan) {
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
                hash: null
            };
        }
    } catch (error) {
        // If YouTube URL check fails, continue with normal file lookup
        logger.debug(`YouTube URL check failed for "${fileParam}": ${error.message}`);
    }

    const plan = normalizeFileAccessPlan(fileAccessPlan);
    if (plan.length === 0) {
        return null;
    }

    const foundFile = await findFileInFileAccessPlan(fileParam, plan);

    if (!foundFile) {
        // File not found in collection, return null
        return null;
    }

    // Resolve to short-lived URL if possible
    const fileWithShortLivedUrl = await ensureShortLivedUrl(
        foundFile,
        MEDIA_API_URL,
        getFileContextId(foundFile, plan),
    );

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
    const fileHash = fileContent.hash;

    // Check if file already exists in chat history
    const existingFiles = extractFilesFromChatHistory(chatHistory);
    const fileAlreadyExists = existingFiles.some(existingFile => {
        // Check by URL (existingFile uses url from extractFileMetadataFromContent)
        if (fileUrl && existingFile.url === fileUrl) {
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
 * @param {Object|null} fileLocation - Optional {userId, chatId, workspaceId, fileScope} to copy blob to target folder on match
 * @returns {Promise<Object|null>} {url, gcs, hash, filename} if file exists, null otherwise
 *   url: Long-lived URL for storage (prefers converted if available)
 *   gcs: GCS URL (prefers converted if available)
 *   filename: Original filename from file handler (if available)
 */
async function checkHashExists(hash, fileHandlerUrl, pathwayResolver = null, contextId = null, shortLivedMinutes = 5, fileLocation = null) {
    if (!hash || !fileHandlerUrl) {
        return null;
    }

    try {
        const checkHashUrl = buildFileHandlerUrl(fileHandlerUrl, {
            hash,
            checkHash: true,
            ...(contextId ? { contextId } : {}),
            ...(shortLivedMinutes ? { shortLivedMinutes } : {}),
            ...(fileLocation?.userId ? { userId: fileLocation.userId } : {}),
            ...(fileLocation?.chatId ? { chatId: fileLocation.chatId } : {}),
            ...(fileLocation?.workspaceId ? { workspaceId: fileLocation.workspaceId } : {}),
            ...(fileLocation?.appletId ? { appletId: fileLocation.appletId } : {}),
            ...(fileLocation?.fileScope ? { fileScope: fileLocation.fileScope } : {}),
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
 * Generic function to upload a file to cloud storage
 * Handles both URLs (downloads then uploads) and base64 data
 * Checks hash before uploading to avoid duplicates
 * @param {string|Buffer} fileInput - URL to download from, or base64 string, or Buffer
 * @param {string} mimeType - MIME type of the file (optional for URLs)
 * @param {string} filename - Optional filename (will be inferred if not provided)
 * @param {pathwayResolver} pathwayResolver - Optional pathway resolver for logging
 * @param {Object} fileLocation - Optional file location for folder-based storage
 * @param {string} fileLocation.contextId - Logical file context ID
 * @param {string} fileLocation.userId - Physical user container owner ID
 * @param {string} fileLocation.chatId - Chat ID (if file is chat-scoped)
 * @param {string} fileLocation.workspaceId - Workspace ID (if file is workspace/applet-scoped)
 * @param {string} fileLocation.appletId - Applet ID (if file is applet-scoped)
 * @param {string} fileLocation.fileScope - File scope: 'global', 'chat', 'workspace-user-legacy', 'profile', 'articles', 'workspace-shared-legacy'
 * @returns {Promise<Object>} {url, gcs, hash}
 */
async function uploadFileToCloud(fileInput, mimeType = null, filename = null, pathwayResolver = null, fileLocation = null) {
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

                // Determine file extension and try to extract a meaningful filename from URL
                let extension = 'bin';
                let urlFilename = null;
                if (filename) {
                    extension = path.extname(filename).slice(1) || 'bin';
                } else {
                    // Use existing extractFilenameFromUrl to get the basename
                    const extracted = extractFilenameFromUrl(fileInput);
                    if (extracted) {
                        extension = path.extname(extracted).slice(1) || 'bin';
                        // Use as filename if it looks meaningful (not just an extension or empty)
                        if (extracted.length > 1 && extracted !== `.${extension}`) {
                            urlFilename = extracted;
                        }
                    }
                }
                const downloadFilename = filename || urlFilename || `file-${Date.now()}.${extension}`;
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
            } else if (fileInput.startsWith('/') || fileInput.startsWith('./') || fileInput.startsWith('../')) {
                // Local/workspace path — not supported
                throw new Error(`uploadFileToCloud received a local path ("${fileInput}") instead of a URL or base64 data. To save workspace files, use WorkspaceSSH with 'files push'.`);
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
            // Use userId or workspaceId from fileLocation for scoped hash lookup
            const hashContextId = getFileLocationContextId(fileLocation);
            const existingFile = await checkHashExists(fileHash, fileHandlerUrl, pathwayResolver, hashContextId || null, 5, fileLocation);
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

                // Use mime type category for a more descriptive fallback name
                const mimeCategory = mimeType ? mimeType.split('/')[0] : 'file';
                const uploadFilename = filename || `${mimeCategory}-${Date.now()}.${extension}`;

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

        // IMPORTANT: Append metadata fields BEFORE the file stream.
        // Busboy processes multipart parts in order, so fields must come first
        // to be available when the file event fires in the handler.

        // Add hash for deduplication if we computed it
        if (fileHash) {
            formData.append('hash', fileHash);
        }

        // Add folder-based storage fields if USE_FOLDER_STORAGE is enabled and fileLocation is provided
        if (USE_FOLDER_STORAGE && fileLocation) {
            const targetContextId = getFileLocationContextId(fileLocation);
            if (targetContextId) {
                formData.append('contextId', targetContextId);
            }
            if (fileLocation.userId) {
                formData.append('userId', fileLocation.userId);
            }
            if (fileLocation.chatId) {
                formData.append('chatId', fileLocation.chatId);
            }
            if (fileLocation.workspaceId) {
                formData.append('workspaceId', fileLocation.workspaceId);
            }
            if (fileLocation.appletId) {
                formData.append('appletId', fileLocation.appletId);
            }
            if (fileLocation.fileScope) {
                formData.append('fileScope', fileLocation.fileScope);
            }
        }

        // Append file stream LAST so busboy field events fire before the file event
        formData.append('file', fs.createReadStream(tempFilePath), {
            filename: uploadFilename,
            contentType: mimeType || 'application/octet-stream'
        });

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

/**
 * Ensure parent directory exists for a file path.
 * @param {string} filePath
 */
function ensureParentDir(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * List all files in a user's per-user blob container.
 * @param {string} userId
 * @returns {Promise<Array>} list of file objects from CFH listFolder
 */
async function listUserFolderFiles(userId) {
    if (!userId) return [];
    // Per-user containers are already scoped by userId — list from root
    return await listFolderViaAPI('');
}

/**
 * Download a file from URL to a workspace path.
 * @param {string} url
 * @param {string} destPath
 */
async function downloadUrlToWorkspace(url, destPath) {
    ensureParentDir(destPath);
    const response = await axios.get(url, { responseType: 'stream', timeout: 60000 });
    await pipeline(response.data, fs.createWriteStream(destPath));
}

/**
 * Build a local workspace path from a CFH file object.
 * Prefers blob names (fileObj.name) which include hash prefixes and folder paths.
 * Handles both legacy (users/{userId}/...) and new (root-relative) folder paths.
 * @param {Object} fileObj
 * @param {string} userId
 */
function getWorkspacePathForFile(fileObj, userId) {
    if (!fileObj) return null;

    const normalizeRelative = (value) => {
        if (!value || typeof value !== 'string') return null;
        let rel = value.trim().replace(/^\/+/, '').replace(/\\/g, '/');
        // Strip legacy users/{userId}/ prefix if present (backward compat)
        rel = rel.replace(/^users\/[^/]+\/?/, '');
        rel = rel.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
        return rel || null;
    };

    // Prefer full blob name when available (includes folder path + hash prefix)
    const blobName = normalizeRelative(fileObj.name);
    if (blobName) {
        return path.posix.join('/workspace/files', blobName);
    }

    const folderPath = normalizeRelative(fileObj.folderPath);
    const filename = fileObj.filename || fileObj.displayFilename;
    if (!filename) return null;

    const relative = folderPath ? `${folderPath}/${filename}` : filename;
    return path.posix.join('/workspace/files', relative.replace(/^\/+/, ''));
}

/**
 * Sync cloud user folder to local workspace directory.
 * Downloads all files from the per-user container into /workspace.
 * Writes a manifest map into Redis for diffing on sync-out.
 * @param {string} userId
 * @param {string} [workspaceRoot]
 */
async function syncWorkspaceFromCloud(userId, workspaceRoot = '/workspace') {
    if (!userId) {
        throw new Error('userId is required');
    }

    const files = await listUserFolderFiles(userId);
    const manifest = {};

    for (const fileObj of files) {
        const destPath = getWorkspacePathForFile(fileObj, userId);
        if (!destPath) continue;

        const url = fileObj.shortLivedUrl || fileObj.url;
        if (!url) continue;

        await downloadUrlToWorkspace(url, destPath);
        const hash = fileObj.hash || null;
        manifest[destPath] = {
            hash,
            folderPath: fileObj.folderPath || null,
            filename: fileObj.filename || fileObj.displayFilename || path.basename(destPath)
        };
    }

    const redisClient = await getRedisClient();
    if (redisClient) {
        const key = `WorkspaceManifest:${userId}`;
        await redisClient.set(key, JSON.stringify({ ts: Date.now(), files: manifest }));
    }

    return { success: true, count: files.length };
}

/**
 * Sync local workspace directory back to cloud user folder.
 * Uploads new/changed files; removes deleted files from cloud.
 * @param {string} userId
 * @param {string} [workspaceRoot]
 */
async function syncWorkspaceToCloud(userId, workspaceRoot = '/workspace') {
    if (!userId) {
        throw new Error('userId is required');
    }

    const redisClient = await getRedisClient();
    let previous = {};
    if (redisClient) {
        const key = `WorkspaceManifest:${userId}`;
        const raw = await redisClient.get(key);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                previous = parsed.files || {};
            } catch {
                previous = {};
            }
        }
    }

    // Build current file list
    const current = {};
    const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                current[fullPath] = true;
            }
        }
    };
    if (fs.existsSync(workspaceRoot)) {
        walk(workspaceRoot);
    }

    const uploads = [];
    for (const filePath of Object.keys(current)) {
        const hash = await computeFileHash(filePath);
        const prior = previous[filePath];
        if (prior && prior.hash === hash) {
            continue; // unchanged
        }

        // Map workspace path to folderPath (root-relative in per-user container)
        const rel = path.relative(workspaceRoot, filePath);
        const dir = path.dirname(rel);
        const folderPath = dir && dir !== '.'
            ? dir
            : 'global';

        const fileLocation = {
            userId,
            fileScope: 'global'
        };

        if (dir && dir !== '.' && dir.startsWith('chats/')) {
            fileLocation.fileScope = 'chat';
            fileLocation.chatId = dir.split('/')[1];
        }

        const filename = path.basename(filePath);
        const mimeType = getMimeTypeFromFilename(filename);
        const buffer = fs.readFileSync(filePath);
        uploads.push(await uploadFileToCloud(buffer, mimeType, filename, null, fileLocation));

        previous[filePath] = {
            hash,
            folderPath,
            filename
        };
    }

    // Deletes: files present in previous but now missing
    const deleted = Object.keys(previous).filter((p) => !current[p]);
    for (const filePath of deleted) {
        const prior = previous[filePath];
        if (!prior?.hash) continue;
        try {
            await deleteFileByHash(prior.hash);
        } catch {
            // ignore delete errors
        }
        delete previous[filePath];
    }

    if (redisClient) {
        const key = `WorkspaceManifest:${userId}`;
        await redisClient.set(key, JSON.stringify({ ts: Date.now(), files: previous }));
    }

    return { success: true, uploaded: uploads.length, deleted: deleted.length };
}

/**
 * Derive a descriptive, human-readable filename from a prompt or description.
 * Used so that generated media gets meaningful blob names instead of random IDs.
 *
 * @param {string} prompt - The generation prompt or description
 * @param {string} extension - File extension without dot (e.g., 'png', 'mp4')
 * @param {Object} [options]
 * @param {string} [options.prefix] - Override: use this instead of deriving from prompt
 * @param {number} [options.index=0] - Index for multi-file batches (appended if > 0)
 * @param {number} [options.maxLength=60] - Max characters for the name portion
 * @returns {string} e.g. "sunset-over-the-mediterranean-sea.png"
 */
function promptToFilename(prompt, extension, options = {}) {
    const { prefix, index = 0, maxLength = 60 } = options;
    const ext = extension || 'bin';
    const suffix = index > 0 ? `-${index}` : '';

    // Slugify: lowercase, underscores/spaces to hyphens, strip non-alphanumeric
    const slugify = (str) => str
        .toLowerCase()
        .replace(/[_\s]+/g, '-')         // underscores & spaces → hyphens
        .replace(/[^a-z0-9-]/g, '')      // strip remaining special chars
        .replace(/-+/g, '-')             // collapse runs of hyphens
        .replace(/^-|-$/g, '');

    // If an explicit prefix is given, use it directly (no truncation)
    if (prefix) {
        const name = slugify(prefix) || 'file';
        return `${name}${suffix}.${ext}`;
    }

    if (!prompt || typeof prompt !== 'string') {
        return `file${suffix}.${ext}`;
    }

    let name = slugify(prompt);

    // Truncate at a word boundary
    if (name.length > maxLength) {
        name = name.substring(0, maxLength);
        const lastHyphen = name.lastIndexOf('-');
        if (lastHyphen > 20) {
            name = name.substring(0, lastHyphen);
        }
    }

    return `${name || 'file'}${suffix}.${ext}`;
}

// Helper function to upload base64 image data to cloud storage
// Now uses the generic uploadFileToCloud function
const uploadImageToCloud = async (base64Data, mimeType, pathwayResolver = null, fileLocation = null, filename = null) => {
    return await uploadFileToCloud(base64Data, mimeType, filename, pathwayResolver, fileLocation);
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
            };
        } else {
            return {
                hash: item.hash || null,
                displayFilename: null,
                url: item.url,
            };
        }
    });

    const count = files.length;

    // Build ready-to-use markdown for each file so the agent can copy-paste into its response
    const displayMarkdown = files.map((file) => {
        const name = file.displayFilename || 'generated file';
        if (mediaType === 'video') {
            return `[${name}](${file.url})`;
        }
        return `![${name}](${file.url})`;
    });

    const response = {
        success: true,
        count: count,
        message: `${action} complete. ${count} ${mediaType}(s) uploaded and added to file collection. IMPORTANT: Display the result to the user by including the markdown below in your response exactly as shown.`,
        displayMarkdown: displayMarkdown,
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
    syncAndStripFilesFromChatHistory,
    findFileInCollection,
    findFileInFileAccessPlan,
    findFileInFileAccessPlanDirect,
    // resolveFileParameter is exported inline above
    generateFileMessageContent,
    injectFileIntoChatHistory,
    addFileToCollection,
    loadFileCollection,
    saveFileCollection,
    updateFileMetadata,
    getCollectionCacheKey,
    getRedisClient,
    checkHashExists,
    ensureShortLivedUrl,
    buildFileCreationResponse,
    uploadFileToCloud,
    uploadImageToCloud,
    promptToFilename,
    resolveFileHashesToContent,
    getMimeTypeFromFilename,
    getMimeTypeFromExtension,
    isTextMimeType,
    writeFileDataToRedis,
    getActualContentMimeType,
    // isYoutubeUrl is exported inline above
    // Exported for testing
    extractFilenameFromUrl,
    ensureFilenameExtension,
    determineMimeTypeFromUrl,
    // Folder-based storage exports
    buildFileLocation,
    constructFolderPath,
    listFolderViaAPI,
    listFilesForContext,
    USE_FOLDER_STORAGE,
    // Migration functions
    loadLegacyFilesFromRedis,
    migrateFilesToFoldersAsync,
    // Workspace helpers (used by WorkspaceSSH sync command)
    listUserFolderFiles,
    getWorkspacePathForFile,
    updateFileMetadataInFileAccessPlan,
    getWriteFileAccessTarget,
    listFilesForFileAccessPlan,
    normalizeFileAccessPlan,
    getFileContextId,
};
