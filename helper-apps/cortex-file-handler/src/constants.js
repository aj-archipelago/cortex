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

// Parse comma-separated container names from environment variable
export const parseContainerNames = () => {
  const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
  return containerStr.split(',').map(name => name.trim());
};

// Helper function to get current container names at runtime
// Useful for runtime validation when env vars might change (e.g., in tests)
export const getCurrentContainerNames = () => {
  return parseContainerNames();
};

export const AZURE_STORAGE_CONTAINER_NAMES = parseContainerNames();

// Helper function to get the default container name at runtime
// This allows tests to change the environment variable and have the correct default
export const getDefaultContainerName = () => {
  return process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME || getCurrentContainerNames()[0];
};

export const DEFAULT_AZURE_STORAGE_CONTAINER_NAME = process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME || AZURE_STORAGE_CONTAINER_NAMES[0];
export const GCS_BUCKETNAME = process.env.GCS_BUCKETNAME || "cortextempfiles";

// Validate if a container name is allowed
export const isValidContainerName = (containerName) => {
  // Read from environment at runtime to support dynamically changing env in tests
  const currentContainerNames = getCurrentContainerNames();
  return currentContainerNames.includes(containerName);
};
