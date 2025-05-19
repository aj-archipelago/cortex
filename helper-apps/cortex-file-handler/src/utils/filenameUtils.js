import path from 'path';

/**
 * Sanitize a filename so that it is safe and consistent across all back-ends
 * – Decode any existing URI encoding
 * – Strip directory components
 * – Replace characters that are not alphanum, dash, dot, or underscore with `_`
 * – Convert spaces to underscores to avoid unintended encoding by some SDKs
 *
 * @param {string} raw The raw filename/path/URL component
 * @returns {string} A sanitized filename suitable for Azure, GCS, local FS, etc.
 */
export function sanitizeFilename(raw = '') {
    let name = raw;
    try {
        name = decodeURIComponent(name);
    } catch (_) {
        // Already decoded / not URI encoded – ignore
    }

    name = path.basename(name);
    // Replace spaces first so they don't become %20 anywhere
    name = name.replace(/\s+/g, '_');
    // Replace any remaining invalid characters
    name = name.replace(/[^\w\-\.]/g, '_');

    return name;
} 