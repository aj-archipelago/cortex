import { sanitizeFilename } from "./filenameUtils.js";

export function sanitizeTargetBlobPath(targetBlobPath) {
  const decoded = (() => {
    try {
      return decodeURIComponent(targetBlobPath);
    } catch {
      return targetBlobPath;
    }
  })();

  const normalized = String(decoded || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");

  if (!normalized) return "";

  const sanitizedSegments = normalized.split("/").map((segment) => {
    if (!segment || segment === "." || segment === "..") {
      return "";
    }
    return sanitizeFilename(segment);
  });

  if (sanitizedSegments.some((segment) => !segment)) {
    return "";
  }

  return sanitizedSegments.join("/");
}
