/**
 * Security utilities for logging - redacts sensitive information from logs
 */

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
 * Recursively sanitizes an object by redacting SAS tokens from URLs
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
      sanitized[key] = sanitizeForLogging(value);
    }
    return sanitized;
  }
  
  return obj;
}

