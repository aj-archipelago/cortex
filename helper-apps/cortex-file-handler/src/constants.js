export const DOC_EXTENSIONS = [
  ".txt",
  ".json",
  ".csv",
  ".md",
  ".xml",
  ".js",
  ".html",
  ".css",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
];

export const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".pdf",
];

export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mpeg",
  ".mov",
  ".avi",
  ".flv",
  ".mpg",
  ".webm",
  ".wmv",
  ".3gp",
];

export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".aac", ".ogg", ".flac"];

export const ACCEPTED_MIME_TYPES = {
  // Document types
  "text/plain": [".txt"],
  "application/json": [".json"],
  "text/csv": [".csv"],
  "text/markdown": [".md"],
  "application/xml": [".xml"],
  "text/javascript": [".js"],
  "text/html": [".html"],
  "text/css": [".css"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],
  "application/msword": [".doc"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.ms-word.document.macroEnabled.12": [".docm"],
  "application/vnd.ms-excel.sheet.macroEnabled.12": [".xlsm"],
  "application/vnd.ms-word.template.macroEnabled.12": [".dotm"],
  "application/vnd.ms-excel.template.macroEnabled.12": [".xltm"],

  // Image types
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
  "image/heif": [".heif"],
  "application/octet-stream": [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".heic",
    ".heif",
  ],
  "application/pdf": [".pdf"],

  // Audio types
  "audio/wav": [".wav"],
  "audio/x-wav": [".wav"],
  "audio/mpeg": [".mp3"],
  "audio/aac": [".aac"],
  "audio/ogg": [".ogg"],
  "audio/flac": [".flac"],
  "audio/m4a": [".m4a"],
  "audio/x-m4a": [".m4a"],
  "audio/mp3": [".mp3"],
  "audio/mp4": [".mp4"],

  // Video types
  "video/mp4": [".mp4"],
  "video/mpeg": [".mpeg", ".mpg"],
  "video/mov": [".mov"],
  "video/quicktime": [".mov"],
  "video/x-msvideo": [".avi"],
  "video/x-flv": [".flv"],
  "video/mpg": [".mpeg", ".mpg"],
  "video/webm": [".webm"],
  "video/wmv": [".wmv"],
  "video/3gpp": [".3gp"],
  "video/m4v": [".m4v"],
};

// Helper function to check if a mime type is accepted
export function isAcceptedMimeType(mimeType) {
  return mimeType in ACCEPTED_MIME_TYPES;
}

// Helper function to get accepted extensions for a mime type
export function getExtensionsForMimeType(mimeType) {
  return ACCEPTED_MIME_TYPES[mimeType] || [];
}

// Helper function to check if an extension is accepted
export function isAcceptedExtension(extension) {
  return (
    DOC_EXTENSIONS.includes(extension) ||
    IMAGE_EXTENSIONS.includes(extension) ||
    VIDEO_EXTENSIONS.includes(extension) ||
    AUDIO_EXTENSIONS.includes(extension)
  );
}

export const CONVERTED_EXTENSIONS = [
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

// Azure Storage constants
export const AZURITE_ACCOUNT_NAME = "devstoreaccount1";

// Get single container name from environment variable
// CFH operates on a single Azure container and single GCS bucket
export const getContainerName = () => {
  const envValue = process.env.AZURE_STORAGE_CONTAINER_NAME;
  
  // Default to cortextempfiles if not set, empty, or the string "undefined"
  if (!envValue || (typeof envValue === 'string' && envValue.trim() === "") || envValue === "undefined") {
    return "cortextempfiles";
  }
  
  // Handle legacy comma-separated values (take the last one)
  if (envValue.includes(",")) {
    const containers = envValue.split(",").map(c => c.trim()).filter(c => c.length > 0);
    if (containers.length > 0) {
      const containerName = containers[containers.length - 1];
      console.warn(
        `[WARNING] AZURE_STORAGE_CONTAINER_NAME contains comma-separated values (legacy format). ` +
        `Using last container: "${containerName}". ` +
        `Full value: "${envValue}". ` +
        `Please update to use a single container name.`
      );
      return containerName;
    }
    // If all containers were empty after splitting, fall back to default
    return "cortextempfiles";
  }
  
  return envValue;
};

// Helper function to get current container name at runtime
export const getDefaultContainerName = () => {
  return getContainerName();
};

// Export constant - evaluated at module load time, but getContainerName() handles defaults
export const AZURE_STORAGE_CONTAINER_NAME = getContainerName();
export const GCS_BUCKETNAME = process.env.GCS_BUCKETNAME || "cortextempfiles";

function buildContainerName(baseName, sanitized) {
  if (!sanitized) return baseName;
  return `${baseName}-${sanitized}`;
}

function sanitizeContainerContextId(contextId) {
  return contextId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function sanitizeLegacyContainerContextId(contextId) {
  return contextId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 50);
}

/**
 * Derive a per-user blob container name from the base name and a contextId.
 * MIRROR: Keep in sync with vendor/cortex/lib/blobContainerUtils.js getUserContainerName()
 * Returns baseName unchanged if no contextId is provided.
 * @param {string} baseName - Base container name (e.g. 'cortexfiles-local')
 * @param {string} [contextId] - User/entity context ID
 * @returns {string} Per-user container name
 */
export function getUserContainerName(baseName, contextId) {
  if (!contextId) return baseName;
  return buildContainerName(baseName, sanitizeContainerContextId(contextId));
}

/**
 * Legacy compound-context container naming used before scoped contexts preserved
 * separators. Keep this for storage compatibility when probing older blobs.
 * @param {string} baseName - Base container name (e.g. 'cortexfiles-local')
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
 * Return current and legacy-compatible container names for the same context ID.
 * Current naming is listed first; legacy aliases are included only when distinct.
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
