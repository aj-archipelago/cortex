// blobContainerUtils.js
// Utility functions for per-user blob container naming, creation, and SAS generation.

import {
    BlobServiceClient,
    StorageSharedKeyCredential,
    generateAccountSASQueryParameters,
    AccountSASPermissions,
    AccountSASResourceTypes,
    AccountSASServices,
    ContainerSASPermissions,
    generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import logger from './logger.js';

function buildContainerName(baseName, sanitized) {
    if (!sanitized) return baseName;
    return `${baseName}-${sanitized}`;
}

function trimLeadingTrailingDashes(value) {
    let start = 0;
    let end = value.length;
    while (start < end && value[start] === '-') start++;
    while (end > start && value[end - 1] === '-') end--;
    return value.slice(start, end);
}

function sanitizeContainerContextId(contextId) {
    let sanitized = '';
    let lastWasDash = false;

    for (const char of contextId.toLowerCase()) {
        const isAllowed =
            (char >= 'a' && char <= 'z')
            || (char >= '0' && char <= '9');

        if (isAllowed) {
            sanitized += char;
            lastWasDash = false;
        } else if (!lastWasDash) {
            sanitized += '-';
            lastWasDash = true;
        }
    }

    return trimLeadingTrailingDashes(sanitized).slice(0, 50);
}

function sanitizeLegacyContainerContextId(contextId) {
    let sanitized = '';
    for (const char of contextId.toLowerCase()) {
        if (
            (char >= 'a' && char <= 'z')
            || (char >= '0' && char <= '9')
            || char === '-'
        ) {
            sanitized += char;
        }
    }
    return sanitized.slice(0, 50);
}

/**
 * Derive the per-user blob container name.
 * MIRROR: Keep in sync with cortex-file-handler/src/constants.js getUserContainerName()
 * @param {string} baseName - Base container name (e.g. 'cortexfiles-local')
 * @param {string} [contextId] - User/entity context ID
 * @returns {string} Container name: `{baseName}-{contextId}` or baseName if no contextId
 */
export function getUserContainerName(baseName, contextId) {
    if (!contextId) return baseName;
    return buildContainerName(baseName, sanitizeContainerContextId(contextId));
}

/**
 * Legacy per-user blob container naming used before scoped contexts preserved
 * separators. Keep this for compatibility probes against older blobs.
 * MIRROR: Keep in sync with cortex-file-handler/src/constants.js getLegacyUserContainerName()
 * @param {string} baseName - Base container name
 * @param {string} [contextId] - Legacy compound context ID
 * @returns {string} Legacy container name
 */
export function getLegacyUserContainerName(baseName, contextId) {
    if (!contextId) return baseName;
    return buildContainerName(
        baseName,
        sanitizeLegacyContainerContextId(contextId),
    );
}

/**
 * Return current and legacy-compatible container names for a context ID.
 * MIRROR: Keep in sync with cortex-file-handler/src/constants.js getUserContainerNameCandidates()
 * @param {string} baseName - Base container name
 * @param {string} [contextId] - Context ID
 * @returns {string[]} Candidate container names
 */
export function getUserContainerNameCandidates(baseName, contextId) {
    if (!contextId) return [baseName];
    const current = getUserContainerName(baseName, contextId);
    const legacy = getLegacyUserContainerName(baseName, contextId);
    return legacy === current ? [current] : [current, legacy];
}

/**
 * Ensure a blob container exists, creating it if necessary.
 * @param {string} accountName - Azure storage account name
 * @param {string} accountKey - Azure storage account key
 * @param {string} containerName - Container name to create
 * @returns {Promise<void>}
 */
export async function ensureContainer(accountName, accountKey, containerName) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential,
    );
    const containerClient = blobServiceClient.getContainerClient(containerName);
    try {
        await containerClient.createIfNotExists();
    } catch (e) {
        // 409 = already exists, which is fine
        if (e.statusCode !== 409) {
            logger.error(`Failed to ensure container ${containerName}: ${e.message}`);
            throw e;
        }
    }
}

/**
 * Generate a container-scoped SAS token with read/write/delete/list permissions.
 * @param {string} accountName - Azure storage account name
 * @param {string} accountKey - Azure storage account key
 * @param {string} containerName - Target container name
 * @param {number} [lifetimeDays=30] - Token lifetime in days
 * @returns {string} SAS query string (without leading '?')
 */
export function generateContainerSASToken(accountName, accountKey, containerName, lifetimeDays = 30) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);

    const startsOn = new Date();
    const expiresOn = new Date(startsOn.valueOf() + lifetimeDays * 24 * 60 * 60 * 1000);

    const sasOptions = {
        containerName,
        permissions: ContainerSASPermissions.parse('rwdl'), // read, write, delete, list
        startsOn,
        expiresOn,
    };

    return generateBlobSASQueryParameters(sasOptions, credential).toString();
}
