import path from "path";

/**
 * Sanitize a filename by removing invalid characters and path traversal attempts
 * @param {string} filename - The filename to sanitize
 * @returns {string} - The sanitized filename
 */
export function sanitizeFilename(filename) {
  if (!filename) return "";

  // Decode URI if it's encoded
  let decoded = filename;
  try {
    decoded = decodeURIComponent(filename);
  } catch (e) {
    // If decoding fails, use the original
    decoded = filename;
  }

  // Get just the basename to prevent path traversal
  let basename = path.basename(decoded);

  // Replace invalid characters with underscores
  basename = basename.replace(/[<>:"/\\|?*]/g, "_");

  // Replace multiple underscores with a single one
  basename = basename.replace(/_+/g, "_");

  // Remove leading/trailing underscores
  basename = basename.replace(/^_+|_+$/g, "");

  // If the result is empty, use a default name
  if (!basename || basename === "") {
    basename = "file";
  }

  return basename;
}

/**
 * Generate an LLM-friendly unique ID
 * @returns {string} - A short, readable unique identifier
 */
export function generateShortId() {
  const timestamp = Date.now().toString(36); // Base36 timestamp
  const random = Math.random().toString(36).substring(2, 5); // 3 random chars
  return `${timestamp}-${random}`;
}

/**
 * Generate a blob name with consistent formatting
 * @param {string} requestId - The request ID (can be empty for single files)
 * @param {string} filename - The filename to use
 * @returns {string} - The formatted blob name
 */
export function generateBlobName(requestId, filename) {
  // If no requestId is provided, just return the filename (for single files like remote downloads)
  if (!requestId || requestId === '') {
    return filename;
  }
  return `${requestId}/${filename}`;
}
