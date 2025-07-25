import fs from "fs";
import http from "http";
import https from "https";
import path from "path";

import { ACCEPTED_MIME_TYPES, isAcceptedMimeType } from "./constants.js";

export async function deleteTempPath(path) {
  try {
    if (!path) {
      console.log("Temporary path is not defined.");
      return;
    }
    if (!fs.existsSync(path)) {
      console.log(`Temporary path ${path} does not exist.`);
      return;
    }
    const stats = fs.statSync(path);
    if (stats.isFile()) {
      fs.unlinkSync(path);
      console.log(`Temporary file ${path} deleted successfully.`);
    } else if (stats.isDirectory()) {
      fs.rmSync(path, { recursive: true });
      console.log(
        `Temporary folder ${path} and its contents deleted successfully.`,
      );
    }
  } catch (err) {
    console.error("Error occurred while deleting the temporary path:", err);
  }
}

// Get the first extension for a given mime type
export function getExtensionForMimeType(mimeType) {
  if (!mimeType) return "";
  const cleanMimeType = mimeType.split(";")[0].trim();
  const extensions = ACCEPTED_MIME_TYPES[cleanMimeType];
  return extensions ? extensions[0] : "";
}

// Ensure a filename has the correct extension based on its mime type
export function ensureFileExtension(filename, mimeType) {
  if (!mimeType) return filename;

  const extension = getExtensionForMimeType(mimeType);
  if (!extension) return filename;

  // If filename already has this extension, return as is
  if (filename.toLowerCase().endsWith(extension)) {
    return filename;
  }

  // Get the current extension if any
  const currentExt = path.extname(filename);

  // If there's no current extension, just append the new one
  if (!currentExt) {
    return `${filename}${extension}`;
  }

  // Replace the current extension with the new one
  return filename.slice(0, -currentExt.length) + extension;
}

export function ensureEncoded(url) {
  try {
    return decodeURIComponent(url) !== url ? url : encodeURI(url);
  } catch (error) {
    console.error("Error encoding URL:", error);
    return url;
  }
}

export async function urlExists(url) {
  if (!url) return false;

  try {
    // Basic URL validation
    const urlObj = new URL(url);
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new Error("Invalid protocol - only HTTP and HTTPS are supported");
    }

    const httpModule = urlObj.protocol === "https:" ? https : http;

    return new Promise((resolve) => {
      const request = httpModule.request(
        url,
        { method: "HEAD" },
        function (response) {
          if (response.statusCode >= 200 && response.statusCode < 400) {
            const contentType = response.headers["content-type"];
            const cleanContentType = contentType
              ? contentType.split(";")[0].trim()
              : "";
            // Check if the content type is one we accept
            if (cleanContentType && isAcceptedMimeType(cleanContentType)) {
              resolve({ valid: true, contentType: cleanContentType });
            } else {
              console.log(`Unsupported content type: ${contentType}`);
              resolve({ valid: false });
            }
          } else {
            resolve({ valid: false });
          }
        },
      );

      request.on("error", function (err) {
        console.error("URL validation error:", err.message);
        resolve({ valid: false });
      });

      request.end();
    });
  } catch (error) {
    console.error("URL validation error:", error.message);
    return { valid: false };
  }
}
