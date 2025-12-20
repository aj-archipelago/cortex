/**
 * Security utilities for logging - redacts sensitive information from logs
 */

/**
 * Redacts contextId for security in logs - shows first 4 and last 4 characters
 * @param {string|null|undefined} contextId - The contextId to redact
 * @returns {string} - Redacted contextId (e.g., "abcd...xyz1") or empty string if null/undefined
 */
export function redactContextId(contextId) {
  if (!contextId || typeof contextId !== 'string') return '';
  
  // If contextId is 8 characters or less, just show first 2 and last 2
  if (contextId.length <= 8) {
    if (contextId.length <= 4) {
      return '****'; // Too short to show anything meaningful
    }
    return `${contextId.substring(0, 2)}...${contextId.substring(contextId.length - 2)}`;
  }
  
  // Show first 4 and last 4 characters for longer IDs
  return `${contextId.substring(0, 4)}...${contextId.substring(contextId.length - 4)}`;
}

/**
 * Redacts SAS tokens from Azure Blob Storage URLs for security in logs
 * @param {string} url - The URL that may contain a SAS token
 * @returns {string} - URL with SAS token redacted (everything after ? is replaced with ?[REDACTED])
 */
export function redactSasToken(url) {
  if (typeof url !== 'string') return url;
  // Check if it's an Azure blob URL
  if (url.includes('blob.core.windows.net') || url.includes('devstoreaccount1')) {
    const questionMarkIndex = url.indexOf('?');
    if (questionMarkIndex !== -1) {
      return url.substring(0, questionMarkIndex) + '?[REDACTED]';
    }
  }
  return url;
}

/**
 * Recursively sanitizes an object by redacting SAS tokens from URLs and contextIds
 * @param {any} obj - The object to sanitize
 * @returns {any} - Sanitized copy of the object
 */
export function sanitizeForLogging(obj) {
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'string') {
    return redactSasToken(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item));
  }
  
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      // Redact contextId fields specifically
      if (key === 'contextId' && typeof value === 'string') {
        sanitized[key] = redactContextId(value);
      } else {
        sanitized[key] = sanitizeForLogging(value);
      }
    }
    return sanitized;
  }
  
  return obj;
}

