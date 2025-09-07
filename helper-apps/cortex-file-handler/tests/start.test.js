/* eslint-disable no-unused-vars */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

import test from "ava";
import axios from "axios";
// eslint-disable-next-line import/no-extraneous-dependencies
import FormData from "form-data";
import { v4 as uuidv4 } from "uuid";

import { port, publicFolder, ipAddress } from "../src/start.js";
import {
  cleanupHashAndFile,
  getFolderNameFromUrl,
  startTestServer,
  stopTestServer,
} from "./testUtils.helper.js";

// Add these helper functions at the top after imports
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to determine if Azure is configured
function isAzureConfigured() {
  return (
    process.env.AZURE_STORAGE_CONNECTION_STRING &&
    process.env.AZURE_STORAGE_CONNECTION_STRING !== "UseDevelopmentStorage=true"
  );
}

// Helper function to convert URLs for testing
function convertToLocalUrl(url) {
  // If it's an Azurite URL (contains 127.0.0.1:10000), use it as is
  if (url.includes("127.0.0.1:10000")) {
    return url;
  }
  // For local storage URLs, convert any IP:port to localhost:port
  const urlObj = new URL(url);
  return url.replace(urlObj.host, `localhost:${port}`);
}

// Helper function to clean up uploaded files
async function cleanupUploadedFile(t, url) {
  // Convert URL to use localhost
  url = convertToLocalUrl(url);
  const folderName = getFolderNameFromUrl(url);

  // Delete the file
  const deleteResponse = await axios.delete(
    `${baseUrl}?operation=delete&requestId=${folderName}`,
  );
  t.is(deleteResponse.status, 200, "Delete should succeed");
  t.true(
    Array.isArray(deleteResponse.data.body),
    "Delete response should be an array",
  );
  t.true(
    deleteResponse.data.body.length > 0,
    "Should have deleted at least one file",
  );

  // Verify file is gone
  const verifyResponse = await axios.get(url, {
    validateStatus: (status) => true,
    timeout: 5000,
  });
  t.is(verifyResponse.status, 404, "File should not exist after deletion");
}

// Helper function to upload files
async function uploadFile(file, requestId, hash = null) {
  const form = new FormData();

  // If file is a Buffer, create a Readable stream
  if (Buffer.isBuffer(file)) {
    const { Readable } = await import("stream");
    const stream = Readable.from(file);
    form.append("file", stream, { filename: "test.txt" });
  } else {
    form.append("file", file);
  }

  if (requestId) form.append("requestId", requestId);
  if (hash) form.append("hash", hash);

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
    timeout: 5000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  if (response.data?.url) {
    response.data.url = convertToLocalUrl(response.data.url);
  }

  return response;
}

// Ensure server is ready before tests
test.before(async (t) => {
  await startTestServer();
});

// Clean up server after tests
test.after.always(async () => {
  await stopTestServer();
});

// Configuration Tests
test("should have valid server configuration", (t) => {
  t.truthy(port, "Port should be defined");
  t.truthy(publicFolder, "Public folder should be defined");
  t.truthy(ipAddress, "IP address should be defined");
});

// Parameter Validation Tests
test.serial(
  "should validate required parameters on CortexFileHandler endpoint",
  async (t) => {
    const response = await axios.get(
      `http://localhost:${port}/api/CortexFileHandler`,
      {
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(response.status, 400, "Should return 400 for missing parameters");
    t.is(
      response.data,
      "Please pass a uri and requestId on the query string or in the request body",
      "Should return proper error message",
    );
  },
);

test.serial(
  "should validate required parameters on MediaFileChunker legacy endpoint",
  async (t) => {
    const response = await axios.get(
      `http://localhost:${port}/api/MediaFileChunker`,
      {
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(response.status, 400, "Should return 400 for missing parameters");
    t.is(
      response.data,
      "Please pass a uri and requestId on the query string or in the request body",
      "Should return proper error message",
    );
  },
);

// Static Files Tests
test.serial("should serve static files from public directory", async (t) => {
  try {
    const response = await axios.get(`http://localhost:${port}/files`, {
      timeout: 5000,
      validateStatus: (status) => status === 200 || status === 404,
    });

    t.true(
      response.status === 200 || response.status === 404,
      "Should respond with 200 or 404 for static files",
    );
  } catch (error) {
    t.fail(`Failed to connect to files endpoint: ${error.message}`);
  }
});

// Hash Operation Tests
test.serial("should handle non-existent hash check", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        hash: "nonexistent-hash",
        checkHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 404, "Should return 404 for non-existent hash");
  t.is(
    response.data,
    "Hash nonexistent-hash not found",
    "Should return proper error message",
  );
});

test.serial("should handle hash clearing for non-existent hash", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        hash: "nonexistent-hash",
        clearHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 404, "Should return 404 for non-existent hash");
  t.is(
    response.data,
    "Hash nonexistent-hash not found",
    "Should return proper message",
  );
});

test.serial(
  "should handle hash operations without hash parameter",
  async (t) => {
    const response = await axios.get(
      `http://localhost:${port}/api/CortexFileHandler`,
      {
        params: {
          checkHash: true,
        },
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(response.status, 400, "Should return 400 for missing hash");
    t.is(
      response.data,
      "Please pass a uri and requestId on the query string or in the request body",
      "Should return proper error message",
    );
  },
);

// URL Validation Tests
test.serial("should reject invalid URLs", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        uri: "not-a-valid-url",
        requestId: "test-request",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should return 400 for invalid URL");
  t.is(
    response.data,
    "Invalid URL format",
    "Should indicate invalid URL format in error message",
  );
});

test.serial("should reject unsupported protocols", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        uri: "ftp://example.com/test.mp3",
        requestId: "test-request",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should return 400 for unsupported protocol");
  t.is(
    response.data,
    "Invalid URL protocol - only HTTP, HTTPS, and GCS URLs are supported",
    "Should indicate invalid protocol in error message",
  );
});

// Remote File Operation Tests
test.serial("should validate remote file URL format", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        fetch: "not-a-valid-url",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should return 400 for invalid remote URL");
  t.is(
    response.data,
    "Invalid or inaccessible URL",
    "Should return proper error message",
  );
});

test.serial("should handle restore operation with invalid URL", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        restore: "not-a-valid-url",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should return 400 for invalid restore URL");
  t.is(
    response.data,
    "Invalid or inaccessible URL",
    "Should return proper error message",
  );
});

test.serial("should handle load operation with invalid URL", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        load: "not-a-valid-url",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should return 400 for invalid load URL");
  t.is(
    response.data,
    "Invalid or inaccessible URL",
    "Should return proper error message",
  );
});

// Delete Operation Tests
test.serial("should validate requestId for delete operation", async (t) => {
  const response = await axios.delete(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should return 400 for missing requestId");
  t.is(
    response.data,
    "Please pass either a requestId or hash on the query string",
    "Should return proper error message",
  );
});

test.serial("should handle delete with valid requestId", async (t) => {
  const testRequestId = "test-delete-request";
  const testContent = "test content";
  const form = new FormData();
  form.append("file", Buffer.from(testContent), "test.txt");

  // Upload a file first
  const uploadResponse = await axios.post(baseUrl, form, {
    headers: form.getHeaders(),
    validateStatus: (status) => true,
    timeout: 5000,
  });
  t.is(uploadResponse.status, 200, "Upload should succeed");

  // Extract the folder name from the URL
  const url = uploadResponse.data.url;
  const folderName = getFolderNameFromUrl(url);

  // Delete the file
  const deleteResponse = await axios.delete(
    `${baseUrl}?operation=delete&requestId=${folderName}`,
  );
  t.is(deleteResponse.status, 200, "Delete should succeed");
  t.true(
    Array.isArray(deleteResponse.data.body),
    "Response should be an array of deleted files",
  );
  t.true(
    deleteResponse.data.body.length > 0,
    "Should have deleted at least one file",
  );
  t.true(
    deleteResponse.data.body[0].includes(folderName),
    "Deleted file should contain folder name",
  );
});

test.serial("should handle delete with non-existent requestId", async (t) => {
  const response = await axios.delete(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        requestId: "nonexistent-request",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    },
  );

  t.is(
    response.status,
    200,
    "Should return 200 even for non-existent requestId",
  );
  t.deepEqual(
    response.data.body,
    [],
    "Should return empty array for non-existent requestId",
  );
});

test("should handle delete with invalid requestId", async (t) => {
  const response = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        requestId: "nonexistent-request",
        operation: "delete",
      },
      timeout: 5000,
    },
  );
  t.is(
    response.status,
    200,
    "Should return 200 for delete with invalid requestId",
  );
  t.true(Array.isArray(response.data.body), "Response should be an array");
  t.is(
    response.data.body.length,
    0,
    "Response should be empty array for non-existent requestId",
  );
});

// POST Operation Tests
test("should handle empty POST request", async (t) => {
  const form = new FormData();
  try {
    await axios.post(`http://localhost:${port}/api/CortexFileHandler`, form, {
      headers: form.getHeaders(),
      timeout: 5000,
    });
    t.fail("Should have thrown error");
  } catch (error) {
    t.is(
      error.response.status,
      400,
      "Should return 400 for empty POST request",
    );
    t.is(
      error.response.data,
      "No file provided in request",
      "Should return proper error message",
    );
  }
});

// Upload Tests
test.serial("should handle successful file upload with hash", async (t) => {
  const form = new FormData();
  const testHash = "test-hash-123";
  const testContent = "test content";
  form.append("file", Buffer.from(testContent), "test.txt");
  form.append("hash", testHash);

  let uploadedUrl;
  try {
    // Upload file with hash
    const uploadResponse = await axios.post(
      `http://localhost:${port}/api/CortexFileHandler`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          "Content-Type": "multipart/form-data",
        },
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Response should contain file URL");
    uploadedUrl = uploadResponse.data.url;

    // Wait a bit for Redis to be updated
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify hash exists and returns the file info
    const hashCheckResponse = await axios.get(
      `http://localhost:${port}/api/CortexFileHandler`,
      {
        params: {
          hash: testHash,
          checkHash: true,
        },
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(
      hashCheckResponse.status,
      200,
      "Hash check should return 200 for uploaded hash",
    );
    t.truthy(hashCheckResponse.data.url, "Hash check should return file URL");
  } finally {
    await cleanupHashAndFile(testHash, uploadedUrl, baseUrl);
  }
});

test.serial("should handle hash clearing", async (t) => {
  const testHash = "test-hash-to-clear";
  const form = new FormData();
  form.append("file", Buffer.from("test content"), "test.txt");
  form.append("hash", testHash);

  // First upload a file with the hash
  const uploadResponse = await axios.post(
    `http://localhost:${port}/api/CortexFileHandler`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(uploadResponse.status, 200, "Upload should succeed");
  t.truthy(uploadResponse.data.url, "Response should contain file URL");

  // Wait a bit for Redis to be updated
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Clear the hash (should succeed)
  const clearResponse = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        hash: testHash,
        clearHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(
    clearResponse.status,
    200,
    "Hash clearing should return 200 for existing hash",
  );
  t.is(
    clearResponse.data,
    `Hash ${testHash} removed`,
    "Should indicate hash was removed",
  );

  // Second clear (should return 404)
  const clearAgainResponse = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        hash: testHash,
        clearHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );
  t.is(
    clearAgainResponse.status,
    404,
    "Hash clearing should return 404 for already removed hash",
  );
  t.is(
    clearAgainResponse.data,
    `Hash ${testHash} not found`,
    "Should indicate hash not found",
  );

  // Verify hash no longer exists
  const verifyResponse = await axios.get(
    `http://localhost:${port}/api/CortexFileHandler`,
    {
      params: {
        hash: testHash,
        checkHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(verifyResponse.status, 404, "Hash should not exist");
  t.is(
    verifyResponse.data,
    `Hash ${testHash} not found`,
    "Should indicate hash not found",
  );

  // Clean up the uploaded file
  await cleanupUploadedFile(t, uploadResponse.data.url);
});

test.serial("should handle file upload without hash", async (t) => {
  const form = new FormData();
  form.append("file", Buffer.from("test content"), "test.txt");

  const response = await axios.post(
    `http://localhost:${port}/api/CortexFileHandler`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 200, "Upload should succeed");
  t.truthy(response.data.url, "Response should contain file URL");

  await cleanupUploadedFile(t, response.data.url);
});

test.serial("should handle upload with empty file", async (t) => {
  const form = new FormData();
  // Empty file
  form.append("file", Buffer.from(""), "empty.txt");

  const response = await axios.post(
    `http://localhost:${port}/api/CortexFileHandler`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );

  t.is(response.status, 400, "Should reject empty file");
  t.is(
    response.data,
    "Invalid file: file is empty",
    "Should return proper error message",
  );
});

test.serial(
  "should handle complete upload-request-delete-verify sequence",
  async (t) => {
    const testContent = "test content for sequence";
    const testHash = "test-sequence-hash";
    const form = new FormData();
    form.append("file", Buffer.from(testContent), "sequence-test.txt");
    form.append("hash", testHash);

    // Upload file with hash
    const uploadResponse = await axios.post(baseUrl, form, {
      headers: form.getHeaders(),
      validateStatus: (status) => true,
      timeout: 5000,
    });
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Response should contain URL");

    await cleanupHashAndFile(testHash, uploadResponse.data.url, baseUrl);

    // Verify hash is gone by trying to get the file URL
    const hashCheckResponse = await axios.get(`${baseUrl}`, {
      params: {
        hash: testHash,
        checkHash: true,
      },
      validateStatus: (status) => true,
    });
    t.is(hashCheckResponse.status, 404, "Hash should not exist after deletion");
  },
);

test.serial(
  "should handle multiple file uploads with unique hashes",
  async (t) => {
    const uploadedFiles = [];

    // Upload 10 files
    for (let i = 0; i < 10; i++) {
      const content = `test content for file ${i}`;
      const form = new FormData();
      form.append("file", Buffer.from(content), `file-${i}.txt`);

      const uploadResponse = await axios.post(baseUrl, form, {
        headers: form.getHeaders(),
        validateStatus: (status) => true,
        timeout: 5000,
      });
      t.is(uploadResponse.status, 200, `Upload should succeed for file ${i}`);

      const url = uploadResponse.data.url;
      t.truthy(url, `Response should contain URL for file ${i}`);

      uploadedFiles.push({
        url: convertToLocalUrl(url),
        content,
      });

      // Small delay between uploads
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Verify files are stored and can be fetched
    for (const file of uploadedFiles) {
      const fileResponse = await axios.get(file.url, {
        validateStatus: (status) => true,
        timeout: 5000,
      });
      t.is(
        fileResponse.status,
        200,
        `File should be accessible at ${file.url}`,
      );
      t.is(
        fileResponse.data,
        file.content,
        "File content should match original content",
      );
    }

    // Clean up all files
    for (const file of uploadedFiles) {
      await cleanupUploadedFile(t, file.url);
    }
  },
);

// Example of a hash-specific test that only runs with Azure
test.serial("should handle hash reuse with Azure storage", async (t) => {
  if (!isAzureConfigured()) {
    t.pass("Skipping hash test - Azure not configured");
    return;
  }

  const testHash = "test-hash-reuse";
  const testContent = "test content for hash reuse";
  const form = new FormData();
  form.append("file", Buffer.from(testContent), "test.txt");
  form.append("hash", testHash);

  // First upload
  const upload1 = await axios.post(baseUrl, form, {
    headers: form.getHeaders(),
    validateStatus: (status) => true,
    timeout: 5000,
  });
  t.is(upload1.status, 200, "First upload should succeed");
  const originalUrl = upload1.data.url;

  // Check hash exists and returns the correct URL
  const hashCheck1 = await axios.get(
    baseUrl,
    { hash: testHash, checkHash: true },
    {
      validateStatus: (status) => true,
    },
  );
  t.is(hashCheck1.status, 200, "Hash should exist after first upload");
  t.truthy(hashCheck1.data.url, "Hash check should return URL");
  t.is(
    hashCheck1.data.url,
    originalUrl,
    "Hash check should return original upload URL",
  );

  // Verify file is accessible via URL from hash check
  const fileResponse = await axios.get(convertToLocalUrl(hashCheck1.data.url), {
    validateStatus: (status) => true,
    timeout: 5000,
  });
  t.is(fileResponse.status, 200, "File should be accessible");
  t.is(fileResponse.data, testContent, "File content should match original");

  // Second upload with same hash
  const upload2 = await axios.post(baseUrl, form, {
    headers: form.getHeaders(),
    validateStatus: (status) => true,
    timeout: 5000,
  });
  t.is(upload2.status, 200, "Second upload should succeed");
  t.is(upload2.data.url, originalUrl, "URLs should match for same hash");

  // Verify file is still accessible after second upload
  const fileResponse2 = await axios.get(convertToLocalUrl(upload2.data.url), {
    validateStatus: (status) => true,
    timeout: 5000,
  });
  t.is(fileResponse2.status, 200, "File should still be accessible");
  t.is(
    fileResponse2.data,
    testContent,
    "File content should still match original",
  );

  // Clean up
  await cleanupUploadedFile(t, originalUrl);

  // Verify hash is now gone
  const hashCheckAfterDelete = await axios.get(
    baseUrl,
    { hash: testHash, checkHash: true },
    {
      validateStatus: (status) => true,
    },
  );
  t.is(
    hashCheckAfterDelete.status,
    404,
    "Hash should be gone after file deletion",
  );
});

// Helper to check if GCS is configured
function isGCSConfigured() {
  return (
    process.env.GCP_SERVICE_ACCOUNT_KEY && process.env.STORAGE_EMULATOR_HOST
  );
}

// Helper function to check if file exists in fake GCS
async function checkGCSFile(gcsUrl) {
  // Convert gs:// URL to bucket and object path
  const [, , bucket, ...objectParts] = gcsUrl.split("/");
  const object = objectParts.join("/");

  console.log(`[checkGCSFile] Checking file in GCS: ${gcsUrl}`);
  console.log(`[checkGCSFile] Bucket: ${bucket}, Object: ${object}`);
  console.log(
    `[checkGCSFile] Using emulator at ${process.env.STORAGE_EMULATOR_HOST}`,
  );

  // Query fake-gcs-server
  const response = await axios.get(
    `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`,
    {
      validateStatus: (status) => true,
    },
  );
  console.log(`[checkGCSFile] Response status: ${response.status}`);
  console.log(
    `[checkGCSFile] File ${response.status === 200 ? "exists" : "does not exist"}`,
  );
  return response.status === 200;
}

// Helper function to verify file exists in both storages
async function verifyFileInBothStorages(t, uploadResponse) {
  // Verify Azure URL is accessible
  const azureResponse = await axios.get(
    convertToLocalUrl(uploadResponse.data.url),
    {
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );
  t.is(azureResponse.status, 200, "File should be accessible in Azure");

  if (isGCSConfigured()) {
    // Verify GCS URL exists and is in correct format
    t.truthy(uploadResponse.data.gcs, "Response should contain GCS URL");
    t.true(
      uploadResponse.data.gcs.startsWith("gs://"),
      "GCS URL should use gs:// protocol",
    );

    // Check if file exists in fake GCS
    const exists = await checkGCSFile(uploadResponse.data.gcs);
    t.true(exists, "File should exist in GCS");
  }
}

// Helper function to verify file is deleted from both storages
async function verifyFileDeletedFromBothStorages(t, uploadResponse) {
  // Verify Azure URL is no longer accessible
  const azureResponse = await axios.get(
    convertToLocalUrl(uploadResponse.data.url),
    {
      validateStatus: (status) => true,
      timeout: 5000,
    },
  );
  t.is(azureResponse.status, 404, "File should not be accessible in Azure");

  if (isGCSConfigured()) {
    // Verify file is also deleted from GCS
    const exists = await checkGCSFile(uploadResponse.data.gcs);
    t.false(exists, "File should not exist in GCS");
  }
}

test.serial(
  "should handle dual storage upload and cleanup when GCS configured",
  async (t) => {
    if (!isGCSConfigured()) {
      t.pass("Skipping test - GCS not configured");
      return;
    }

    const requestId = uuidv4();
    const testContent = "test content for dual storage";
    const form = new FormData();
    form.append("file", Buffer.from(testContent), "dual-test.txt");
    form.append("requestId", requestId);

    // Upload file
    const uploadResponse = await uploadFile(
      Buffer.from(testContent),
      requestId,
    );
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Response should contain Azure URL");
    t.truthy(uploadResponse.data.gcs, "Response should contain GCS URL");
    t.true(
      uploadResponse.data.gcs.startsWith("gs://"),
      "GCS URL should use gs:// protocol",
    );

    // Verify file exists in both storages
    await verifyFileInBothStorages(t, uploadResponse);

    // Get the folder name (requestId) from the URL
    const fileRequestId = getFolderNameFromUrl(uploadResponse.data.url);

    // Delete file using the correct requestId
    const deleteResponse = await axios.delete(
      `${baseUrl}?operation=delete&requestId=${fileRequestId}`,
    );
    t.is(deleteResponse.status, 200, "Delete should succeed");

    // Verify file is deleted from both storages
    await verifyFileDeletedFromBothStorages(t, uploadResponse);
  },
);

test.serial("should handle GCS URL format and accessibility", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const requestId = uuidv4();
  const testContent = "test content for GCS URL verification";
  const form = new FormData();
  form.append("file", Buffer.from(testContent), "gcs-url-test.txt");

  // Upload with explicit GCS preference
  const uploadResponse = await axios.post(
    `http://localhost:${port}/api/CortexFileHandler`,
    form,
    {
      params: {
        operation: "upload",
        requestId,
        useGCS: true,
      },
      headers: form.getHeaders(),
    },
  );

  t.is(uploadResponse.status, 200, "Upload should succeed");
  t.truthy(uploadResponse.data.gcs, "Response should contain GCS URL");
  t.true(
    uploadResponse.data.gcs.startsWith("gs://"),
    "GCS URL should use gs:// protocol",
  );

  // Verify content is accessible via normal URL since we can't directly access gs:// URLs
  const fileResponse = await axios.get(uploadResponse.data.url);
  t.is(fileResponse.status, 200, "File should be accessible");
  t.is(fileResponse.data, testContent, "Content should match original");

  // Clean up
  await cleanupUploadedFile(t, uploadResponse.data.url);
});

// Add this helper function after other helper functions
async function createAndUploadTestFile() {
  // Create a temporary file path
  const tempDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, "test.mp3");

  // Generate a real MP3 file using ffmpeg
  try {
    execSync(
      `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 10 -q:a 9 -acodec libmp3lame "${tempFile}"`,
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Upload the real media file
    const form = new FormData();
    form.append("file", fs.createReadStream(tempFile));

    const uploadResponse = await axios.post(baseUrl, form, {
      headers: form.getHeaders(),
      validateStatus: (status) => true,
      timeout: 5000,
    });

    // Wait a short time to ensure file is available
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Clean up temp file
    fs.rmSync(tempDir, { recursive: true, force: true });

    return uploadResponse.data.url;
  } catch (error) {
    console.error("Error creating test file:", error);
    throw error;
  }
}

test.serial(
  "should handle chunking with GCS integration when configured",
  async (t) => {
    if (!isGCSConfigured()) {
      t.pass("Skipping test - GCS not configured");
      return;
    }

    // Create a large test file first
    const testFileUrl = await createAndUploadTestFile();
    const requestId = uuidv4();

    // Request chunking via GET
    const chunkResponse = await axios.get(baseUrl, {
      params: {
        uri: testFileUrl,
        requestId,
        useGCS: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    });

    t.is(chunkResponse.status, 200, "Chunked request should succeed");
    t.truthy(chunkResponse.data, "Response should contain data");
    t.true(Array.isArray(chunkResponse.data), "Response should be an array");
    t.true(
      chunkResponse.data.length > 0,
      "Should have created at least one chunk",
    );

    // Verify each chunk exists in both Azure/Local and GCS
    for (const chunk of chunkResponse.data) {
      // Verify Azure/Local URL is accessible
      const azureResponse = await axios.get(convertToLocalUrl(chunk.uri), {
        validateStatus: (status) => true,
        timeout: 5000,
      });
      t.is(
        azureResponse.status,
        200,
        `Chunk should be accessible in Azure/Local: ${chunk.uri}`,
      );

      // Verify GCS URL exists and is in correct format
      t.truthy(chunk.gcs, "Chunk should contain GCS URL");
      t.true(
        chunk.gcs.startsWith("gs://"),
        "GCS URL should use gs:// protocol",
      );

      // Check if chunk exists in fake GCS
      const exists = await checkGCSFile(chunk.gcs);
      t.true(exists, `Chunk should exist in GCS: ${chunk.gcs}`);
    }

    // Clean up chunks
    const deleteResponse = await axios.delete(
      `${baseUrl}?operation=delete&requestId=${requestId}`,
    );
    t.is(deleteResponse.status, 200, "Delete should succeed");

    // Verify all chunks are deleted from both storages
    for (const chunk of chunkResponse.data) {
      // Verify Azure/Local chunk is gone
      const azureResponse = await axios.get(convertToLocalUrl(chunk.uri), {
        validateStatus: (status) => true,
        timeout: 5000,
      });
      t.is(
        azureResponse.status,
        404,
        `Chunk should not be accessible in Azure/Local after deletion: ${chunk.uri}`,
      );

      // Verify GCS chunk is gone
      const exists = await checkGCSFile(chunk.gcs);
      t.false(
        exists,
        `Chunk should not exist in GCS after deletion: ${chunk.gcs}`,
      );
    }
  },
);

test.serial("should handle chunking errors gracefully with GCS", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  // Create a test file to get a valid URL format
  const validFileUrl = await createAndUploadTestFile();

  // Test with invalid URL that matches the format of our real URLs
  const invalidUrl = validFileUrl.replace(/[^/]+$/, "nonexistent-file.mp3");
  const invalidResponse = await axios.get(baseUrl, {
    params: {
      uri: invalidUrl,
      requestId: uuidv4(),
    },
    validateStatus: (status) => true,
    timeout: 5000,
  });

  t.is(invalidResponse.status, 500, "Should reject nonexistent file URL");
  t.true(
    invalidResponse.data.includes("Error processing media file"),
    "Should indicate error processing media file",
  );

  // Test with missing URI
  const noUriResponse = await axios.get(baseUrl, {
    params: {
      requestId: uuidv4(),
    },
    validateStatus: (status) => true,
    timeout: 5000,
  });

  t.is(noUriResponse.status, 400, "Should reject request with no URI");
  t.is(
    noUriResponse.data,
    "Please pass a uri and requestId on the query string or in the request body",
    "Should return proper error message",
  );
});

// Legacy MediaFileChunker Tests
test.serial(
  "should handle file upload through legacy MediaFileChunker endpoint",
  async (t) => {
    const form = new FormData();
    form.append("file", Buffer.from("test content"), "test.txt");

    const response = await axios.post(
      `http://localhost:${port}/api/MediaFileChunker`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          "Content-Type": "multipart/form-data",
        },
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(response.status, 200, "Upload through legacy endpoint should succeed");
    t.truthy(response.data.url, "Response should contain file URL");

    await cleanupUploadedFile(t, response.data.url);
  },
);

test.serial(
  "should handle hash operations through legacy MediaFileChunker endpoint",
  async (t) => {
    const testHash = "test-hash-legacy";
    const form = new FormData();
    form.append("file", Buffer.from("test content"), "test.txt");
    form.append("hash", testHash);

    let uploadedUrl;
    try {
      // Upload file with hash through legacy endpoint
      const uploadResponse = await axios.post(
        `http://localhost:${port}/api/MediaFileChunker`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            "Content-Type": "multipart/form-data",
          },
          validateStatus: (status) => true,
          timeout: 5000,
        },
      );

      t.is(
        uploadResponse.status,
        200,
        "Upload should succeed through legacy endpoint",
      );
      t.truthy(uploadResponse.data.url, "Response should contain file URL");
      uploadedUrl = uploadResponse.data.url;

      // Wait a bit for Redis to be updated
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check hash through legacy endpoint
      const hashCheckResponse = await axios.get(
        `http://localhost:${port}/api/MediaFileChunker`,
        {
          params: {
            hash: testHash,
            checkHash: true,
          },
          validateStatus: (status) => true,
          timeout: 5000,
        },
      );

      t.is(
        hashCheckResponse.status,
        200,
        "Hash check should return 200 for uploaded hash",
      );
      t.truthy(hashCheckResponse.data.url, "Hash check should return file URL");
    } finally {
      await cleanupHashAndFile(
        testHash,
        uploadedUrl,
        `http://localhost:${port}/api/MediaFileChunker`,
      );
    }
  },
);

test.serial(
  "should handle delete operation through legacy MediaFileChunker endpoint",
  async (t) => {
    const testRequestId = "test-delete-request-legacy";
    const testContent = "test content";
    const form = new FormData();
    form.append("file", Buffer.from(testContent), "test.txt");

    // Upload a file first through legacy endpoint
    const uploadResponse = await axios.post(
      `http://localhost:${port}/api/MediaFileChunker`,
      form,
      {
        headers: form.getHeaders(),
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );
    t.is(
      uploadResponse.status,
      200,
      "Upload should succeed through legacy endpoint",
    );

    // Extract the folder name from the URL
    const url = uploadResponse.data.url;
    const folderName = getFolderNameFromUrl(url);

    // Delete the file through legacy endpoint
    const deleteResponse = await axios.delete(
      `http://localhost:${port}/api/MediaFileChunker?operation=delete&requestId=${folderName}`,
    );
    t.is(
      deleteResponse.status,
      200,
      "Delete should succeed through legacy endpoint",
    );
    t.true(
      Array.isArray(deleteResponse.data.body),
      "Response should be an array of deleted files",
    );
    t.true(
      deleteResponse.data.body.length > 0,
      "Should have deleted at least one file",
    );
    t.true(
      deleteResponse.data.body[0].includes(folderName),
      "Deleted file should contain folder name",
    );
  },
);

test.serial(
  "should handle parameter validation through legacy MediaFileChunker endpoint",
  async (t) => {
    // Test missing parameters
    const response = await axios.get(
      `http://localhost:${port}/api/MediaFileChunker`,
      {
        validateStatus: (status) => true,
        timeout: 5000,
      },
    );

    t.is(response.status, 400, "Should return 400 for missing parameters");
    t.is(
      response.data,
      "Please pass a uri and requestId on the query string or in the request body",
      "Should return proper error message",
    );
  },
);

test.serial(
  "should handle empty POST request through legacy MediaFileChunker endpoint",
  async (t) => {
    const form = new FormData();
    try {
      await axios.post(`http://localhost:${port}/api/MediaFileChunker`, form, {
        headers: form.getHeaders(),
        timeout: 5000,
      });
      t.fail("Should have thrown error");
    } catch (error) {
      t.is(
        error.response.status,
        400,
        "Should return 400 for empty POST request",
      );
      t.is(
        error.response.data,
        "No file provided in request",
        "Should return proper error message",
      );
    }
  },
);

test.serial(
  "should handle complete upload-request-delete-verify sequence through legacy MediaFileChunker endpoint",
  async (t) => {
    const testContent = "test content for legacy sequence";
    const testHash = "test-legacy-sequence-hash";
    const legacyBaseUrl = `http://localhost:${port}/api/MediaFileChunker`;
    const form = new FormData();
    form.append("file", Buffer.from(testContent), "sequence-test.txt");
    form.append("hash", testHash);

    // Upload file with hash through legacy endpoint
    const uploadResponse = await axios.post(legacyBaseUrl, form, {
      headers: form.getHeaders(),
      validateStatus: (status) => true,
      timeout: 5000,
    });
    t.is(
      uploadResponse.status,
      200,
      "Upload should succeed through legacy endpoint",
    );
    t.truthy(uploadResponse.data.url, "Response should contain URL");

    // Wait for Redis to be updated after upload
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify hash exists after upload using legacy endpoint
    const initialHashCheck = await axios.get(legacyBaseUrl, {
      params: {
        hash: testHash,
        checkHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    });
    t.is(initialHashCheck.status, 200, "Hash should exist after upload");
    t.truthy(initialHashCheck.data.url, "Hash check should return file URL");

    // Wait for Redis to be updated after initial check
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Clean up the file and hash using the legacy endpoint
    await cleanupHashAndFile(testHash, uploadResponse.data.url, legacyBaseUrl);

    // Wait for Redis to be updated after cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify hash is gone by trying to get the file URL through legacy endpoint
    const hashCheckResponse = await axios.get(legacyBaseUrl, {
      params: {
        hash: testHash,
        checkHash: true,
      },
      validateStatus: (status) => true,
      timeout: 5000,
    });
    t.is(hashCheckResponse.status, 404, "Hash should not exist after deletion");
  },
);

// Cleanup
test.after.always("cleanup", async (t) => {
  // Add any necessary cleanup here
});
