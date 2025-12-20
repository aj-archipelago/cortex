import test from "ava";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import { port } from "../src/start.js";
import { gcs } from "../src/blobHandler.js";
import {
  cleanupHashAndFile,
  getFolderNameFromUrl,
  startTestServer,
  stopTestServer,
  setupTestDirectory,
} from "./testUtils.helper.js";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to determine if GCS is configured
function isGCSConfigured() {
  return (
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
    process.env.GCP_SERVICE_ACCOUNT_KEY
  );
}

// Helper function to create test files
async function createTestFile(content, extension) {
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const filename = path.join(testDir, `${uuidv4()}.${extension}`);
  fs.writeFileSync(filename, content);
  return filename;
}

// Helper function to upload file
async function uploadFile(filePath, requestId = null, hash = null) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  if (requestId) form.append("requestId", requestId);
  if (hash) form.append("hash", hash);

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return response;
}

// Helper function to verify GCS file
async function verifyGCSFile(gcsUrl) {
  if (!isGCSConfigured() || !gcs) return true;

  try {
    const bucket = gcsUrl.split("/")[2];
    const filename = gcsUrl.split("/").slice(3).join("/");
    const [exists] = await gcs.bucket(bucket).file(filename).exists();
    return exists;
  } catch (error) {
    console.error("Error verifying GCS file:", error);
    return false;
  }
}

// Helper function to fetch file content from a URL
async function fetchFileContent(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

// Setup: Create test directory and start server
test.before(async (t) => {
  await startTestServer();
  await setupTestDirectory(t);
});

// Cleanup
test.after.always(async (t) => {
  await stopTestServer();

  // Clean up test directory
  if (t.context?.testDir) {
    await fs.promises.rm(t.context.testDir, { recursive: true, force: true });
  }

  // Clean up any remaining files in the files directory
  const filesDir = path.join(__dirname, "..", "files");
  if (fs.existsSync(filesDir)) {
    const dirs = await fs.promises.readdir(filesDir);
    for (const dir of dirs) {
      const dirPath = path.join(filesDir, dir);
      try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
      } catch (e) {
        console.error("Error cleaning up directory:", {
          dir: dirPath,
          error: e.message,
        });
      }
    }
  }
});

// Basic File Upload Tests
test.serial("should handle basic file upload", async (t) => {
  const fileContent = "test content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);

    t.is(response.status, 200);
    t.truthy(response.data.url);
    t.truthy(response.data.filename);

    // Verify file content matches
    const uploadedContent = await fetchFileContent(response.data.url);
    t.deepEqual(
      uploadedContent,
      Buffer.from(fileContent),
      "Uploaded file content should match",
    );
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

test.serial("should handle file upload with hash", async (t) => {
  const fileContent = "test content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  const hash = "test-hash-" + uuidv4();
  let uploadedUrl;
  let convertedUrl;
  let response;

  try {
    // First upload the file
    response = await uploadFile(filePath, requestId, hash);
    t.is(response.status, 200);
    t.truthy(response.data.url);
    uploadedUrl = response.data.url;
    if (response.data.converted && response.data.converted.url) {
      convertedUrl = response.data.converted.url;
    }
    console.log("Upload hash response.data", response.data);

    // Wait for Redis operations to complete and verify storage
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: (status) => true,
    });
    console.log("Upload hash checkResponse", checkResponse);
    if (checkResponse.status !== 200) {
      // Only log if not 200
      console.error("Hash check failed:", {
        status: checkResponse.status,
        data: checkResponse.data,
      });
    }
    // Hash should exist since we just uploaded it
    t.is(checkResponse.status, 200);
    t.truthy(checkResponse.data.hash);

    // Verify file exists and content matches
    const fileResponse = await axios.get(response.data.url, {
      responseType: "arraybuffer",
    });
    t.is(fileResponse.status, 200);
    t.deepEqual(
      Buffer.from(fileResponse.data),
      Buffer.from(fileContent),
      "Uploaded file content should match",
    );
  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
    if (convertedUrl) {
      await cleanupHashAndFile(null, convertedUrl, baseUrl);
    }
  }
});

// Document Processing Tests
test.serial("should handle PDF document upload and conversion", async (t) => {
  // Create a simple PDF file
  const fileContent = "%PDF-1.4\nTest PDF content";
  const filePath = await createTestFile(fileContent, "pdf");
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200);
    t.truthy(response.data.url);

    // Verify original PDF content matches
    const uploadedContent = await fetchFileContent(response.data.url);
    t.deepEqual(
      uploadedContent,
      Buffer.from(fileContent),
      "Uploaded PDF content should match",
    );

    // Check if converted version exists
    if (response.data.converted) {
      t.truthy(response.data.converted.url);
      const convertedResponse = await axios.get(response.data.converted.url, {
        responseType: "arraybuffer",
      });
      t.is(convertedResponse.status, 200);
      // For conversion, just check non-empty
      t.true(
        Buffer.from(convertedResponse.data).length > 0,
        "Converted file should not be empty",
      );
    }
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
    if (response?.data?.converted?.url) {
      await cleanupHashAndFile(null, response.data.converted.url, baseUrl);
    }
  }
});

// Media Chunking Tests
test.serial("should handle media file chunking", async (t) => {
  // Create a large test file to trigger chunking
  const chunkContent = "x".repeat(1024 * 1024);
  const filePath = await createTestFile(chunkContent, "mp4");
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200);
    t.truthy(response.data);

    // For media files, we expect either an array of chunks or a single URL
    if (Array.isArray(response.data)) {
      t.true(response.data.length > 0);

      // Verify each chunk
      for (const chunk of response.data) {
        t.truthy(chunk.uri);
        t.truthy(chunk.offset);

        // Verify chunk exists and content matches
        const chunkResponse = await axios.get(chunk.uri, {
          responseType: "arraybuffer",
        });
        t.is(chunkResponse.status, 200);
        // Each chunk should be a slice of the original content
        const expectedChunk = Buffer.from(chunkContent).slice(
          chunk.offset,
          chunk.offset + chunk.length || undefined,
        );
        t.deepEqual(
          Buffer.from(chunkResponse.data),
          expectedChunk,
          "Chunk content should match original",
        );

        // If GCS is configured, verify backup
        if (isGCSConfigured() && chunk.gcs) {
          const exists = await verifyGCSFile(chunk.gcs);
          t.true(exists, "GCS chunk should exist");
        }
      }
    } else {
      // Single file response
      t.truthy(response.data.url);
      const fileResponse = await axios.get(response.data.url, {
        responseType: "arraybuffer",
      });
      t.is(fileResponse.status, 200);
      t.deepEqual(
        Buffer.from(fileResponse.data),
        Buffer.from(chunkContent),
        "Uploaded file content should match",
      );
    }
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data) {
      if (Array.isArray(response.data)) {
        for (const chunk of response.data) {
          if (chunk.uri) {
            await cleanupHashAndFile(null, chunk.uri, baseUrl);
          }
        }
      } else if (response.data.url) {
        await cleanupHashAndFile(null, response.data.url, baseUrl);
      }
    }
  }
});

// Error Handling Tests
test.serial("should handle invalid file upload", async (t) => {
  const requestId = uuidv4();
  const form = new FormData();
  // Send a file with no name and no content
  form.append("file", Buffer.from(""), { filename: "" });
  form.append("requestId", requestId);

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
    timeout: 30000,
  });

  // Log the response for debugging
  console.log("Invalid file upload response:", {
    status: response.status,
    data: response.data,
  });

  t.is(response.status, 400, "Should reject invalid file with 400 status");
  t.is(
    response.data,
    "Invalid file: missing filename",
    "Should return correct error message",
  );
});

// Cleanup Tests
test.serial("should handle file deletion", async (t) => {
  const filePath = await createTestFile("test content", "txt");
  const requestId = uuidv4();

  try {
    // Upload file
    const uploadResponse = await uploadFile(filePath, requestId);
    t.is(uploadResponse.status, 200);

    // Wait a moment for file to be fully written
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Extract the file identifier from the URL
    const fileIdentifier = getFolderNameFromUrl(uploadResponse.data.url);
    console.log("File identifier for deletion:", fileIdentifier);

    // Delete file using the correct identifier
    const deleteUrl = `${baseUrl}?operation=delete&requestId=${fileIdentifier}`;
    console.log("Deleting file with URL:", deleteUrl);
    const deleteResponse = await axios.delete(deleteUrl);
    t.is(deleteResponse.status, 200);

    // Wait a moment for deletion to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify file is gone
    const verifyResponse = await axios.get(uploadResponse.data.url, {
      validateStatus: (status) => true,
    });
    t.is(verifyResponse.status, 404, "File should be deleted");

    // If GCS is configured, verify backup is gone
    if (isGCSConfigured() && uploadResponse.data.gcs) {
      const exists = await verifyGCSFile(uploadResponse.data.gcs);
      t.false(exists, "GCS file should be deleted");
    }
  } finally {
    fs.unlinkSync(filePath);
  }
});

// Save Option Test
test.serial("should handle document upload with save option", async (t) => {
  // Create a minimal XLSX workbook in-memory
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Score"],
    ["Alice", 10],
    ["Bob", 8],
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");

  // Write it to a temp file inside the test directory
  const filePath = path.join(t.context.testDir, `${uuidv4()}.xlsx`);
  XLSX.writeFile(workbook, filePath);

  const initialRequestId = uuidv4();
  const saveRequestId = uuidv4();

  let uploadedUrl;
  let savedUrl;

  try {
    // First, upload the document so we have a publicly reachable URL
    const uploadResponse = await uploadFile(filePath, initialRequestId);
    t.is(uploadResponse.status, 200);
    t.truthy(uploadResponse.data.url, "Upload should return a URL");

    uploadedUrl = uploadResponse.data.url;

    // Now call the handler again with the save flag
    const saveResponse = await axios.get(baseUrl, {
      params: {
        uri: uploadedUrl,
        requestId: saveRequestId,
        save: true,
      },
      validateStatus: (status) => true,
    });

    // The save operation should return a 200 status with a result object
    t.is(saveResponse.status, 200, "Save request should succeed");
    t.truthy(saveResponse.data, "Response should have data");
    t.truthy(saveResponse.data.url, "Response should include a URL");
    t.true(
      saveResponse.data.url.includes(".csv"),
      "Response should include a CSV URL",
    );
    savedUrl = saveResponse.data.url;
  } finally {
    fs.unlinkSync(filePath);
    // Clean up both URLs
    if (uploadedUrl) {
      await cleanupHashAndFile(null, uploadedUrl, baseUrl);
    }
    if (savedUrl && savedUrl !== uploadedUrl) {
      await cleanupHashAndFile(null, savedUrl, baseUrl);
    }
  }
});

// Converted file persistence test – ensures needsConversion works for extension-only checks
test.serial(
  "should preserve converted version when checking hash for convertible file",
  async (t) => {
    // Create a minimal XLSX workbook in-memory
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Name", "Score"],
      ["Alice", 10],
      ["Bob", 8],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");

    // Write it to a temp file inside the test directory
    const filePath = path.join(t.context.testDir, `${uuidv4()}.xlsx`);
    XLSX.writeFile(workbook, filePath);

    const requestId = uuidv4();
    const hash = `test-hash-${uuidv4()}`;

    let uploadedUrl;
    let convertedUrl;

    try {
      // 1. Upload the XLSX file (conversion should run automatically)
      const uploadResponse = await uploadFile(filePath, requestId, hash);
      t.is(uploadResponse.status, 200, "Upload should succeed");
      t.truthy(
        uploadResponse.data.converted,
        "Upload response must contain converted info",
      );
      t.truthy(
        uploadResponse.data.converted.url,
        "Converted URL should be present",
      );

      uploadedUrl = uploadResponse.data.url;
      convertedUrl = uploadResponse.data.converted.url;

      // 2. Give Redis a moment to persist
      await new Promise((resolve) => setTimeout(resolve, 4000));

      // 3. Ask the handler for the hash – it will invoke ensureConvertedVersion
      const checkResponse = await axios.get(baseUrl, {
        params: { hash, checkHash: true },
        validateStatus: (status) => true,
        timeout: 30000,
      });

      t.is(checkResponse.status, 200, "Hash check should succeed");
      t.truthy(
        checkResponse.data.converted,
        "Hash response should include converted info",
      );
      t.truthy(
        checkResponse.data.converted.url,
        "Converted URL should still be present after hash check",
      );
    } finally {
      // Clean up temp file and remote artifacts
      fs.unlinkSync(filePath);
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
      if (convertedUrl) {
        await cleanupHashAndFile(null, convertedUrl, baseUrl);
      }
    }
  },
);

// UTF-8 Encoding Test
test.serial("should preserve UTF-8 characters including emdash in uploaded files", async (t) => {
  // Create content with emdash and other UTF-8 characters
  const fileContent = `# Sesame AI (Maya) — Financial Overview

This document contains various UTF-8 characters:
• Em dash: —
• En dash: –
• Ellipsis: …
• Quotes: "smart quotes" and 'smart apostrophes'
• Accented: café, résumé, naïve
• Symbols: ©, ®, ™
• Currency: €, £, ¥
• Math: π, ∑, ∞
• Emoji: 🚀, ✅, ❌

The emdash should be preserved correctly when the file is downloaded.`;

  const filePath = await createTestFile(fileContent, "md");
  const requestId = uuidv4();
  let response;

  try {
    // Upload file with explicit content-type including charset
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), {
      filename: "test-utf8.md",
      contentType: "text/markdown; charset=utf-8",
    });
    form.append("requestId", requestId);

    response = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    t.is(response.status, 200, "Upload should succeed");
    t.truthy(response.data.url, "Response should include a URL");

    // Download the file and verify encoding is preserved
    const downloadResponse = await axios.get(response.data.url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

    t.is(downloadResponse.status, 200, "Download should succeed");

    // Verify content-type header includes charset
    const contentType = downloadResponse.headers["content-type"] || 
                       downloadResponse.headers["Content-Type"];
    t.truthy(contentType, "Content-Type header should be present");
    t.true(
      contentType.includes("charset=utf-8") || contentType.includes("charset=UTF-8"),
      "Content-Type should include charset=utf-8"
    );

    // Decode the downloaded content as UTF-8
    const downloadedContent = Buffer.from(downloadResponse.data).toString("utf8");

    // Verify the emdash is preserved (not corrupted)
    // Check that the emdash character (U+2014) is present and not corrupted
    t.true(
      downloadedContent.includes("—"),
      "Emdash should be preserved in downloaded content"
    );
    
    // Verify the emdash bytes are correct (not the common corruption pattern)
    // The corruption "â€"" occurs when UTF-8 bytes E2 80 94 are interpreted as ISO-8859-1
    // We check that the actual emdash character exists, not the corruption
    const emdashBytes = Buffer.from("—", "utf8");
    const downloadedBytes = Buffer.from(downloadedContent, "utf8");
    t.true(
      downloadedBytes.includes(emdashBytes),
      "Emdash bytes should be preserved correctly"
    );

    // Verify the entire content matches
    t.is(
      downloadedContent,
      fileContent,
      "Downloaded content should exactly match original content"
    );

    // Verify other UTF-8 characters are also preserved
    t.true(downloadedContent.includes("–"), "En dash should be preserved");
    t.true(downloadedContent.includes("…"), "Ellipsis should be preserved");
    t.true(downloadedContent.includes("©"), "Copyright symbol should be preserved");
    t.true(downloadedContent.includes("🚀"), "Emoji should be preserved");
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

// DisplayFilename persistence and retrieval tests
test.serial("should persist and return displayFilename in all responses", async (t) => {
  const originalFilename = "my-original-file-name-with-special-chars-123.txt";
  const fileContent = "test content for displayFilename";
  const hash = "test-displayfilename-" + uuidv4();
  
  // Create a temporary file
  const filePath = await createTestFile(fileContent, "txt");
  let uploadResponse;
  let checkHashResponse;
  let deleteResponse;
  
  try {
    // Upload file with original filename specified
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), originalFilename);
    form.append("hash", hash);
    
    uploadResponse = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    });
    
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.filename, "Response should contain filename");
    t.is(
      uploadResponse.data.displayFilename,
      originalFilename,
      "Upload response should contain displayFilename matching original filename"
    );
    
    // Wait for Redis operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    // Check hash - should return displayFilename
    checkHashResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: (status) => true,
    });
    
    t.is(checkHashResponse.status, 200, "Hash check should succeed");
    t.is(
      checkHashResponse.data.displayFilename,
      originalFilename,
      "checkHash response should contain displayFilename matching original filename"
    );
    t.is(
      checkHashResponse.data.filename,
      uploadResponse.data.filename,
      "checkHash response should contain same filename as upload"
    );
    
    // Test setRetention - should return displayFilename
    const retentionResponse = await axios.get(baseUrl, {
      params: {
        hash,
        setRetention: true,
        retention: "permanent",
      },
      validateStatus: (status) => true,
    });
    
    t.is(retentionResponse.status, 200, "setRetention should succeed");
    t.is(
      retentionResponse.data.displayFilename,
      originalFilename,
      "setRetention response should contain displayFilename"
    );
    
    // Test delete - should return displayFilename
    deleteResponse = await axios.delete(baseUrl, {
      params: {
        hash,
      },
      validateStatus: (status) => true,
    });
    
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.is(
      deleteResponse.data.deleted.filename,
      uploadResponse.data.filename,
      "Delete response should contain filename"
    );
    t.is(
      deleteResponse.data.deleted.displayFilename,
      originalFilename,
      "Delete response should contain displayFilename"
    );
  } finally {
    fs.unlinkSync(filePath);
    // Cleanup is handled by delete operation above
  }
});
