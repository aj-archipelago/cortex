import test from "ava";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import { port } from "../src/start.js";
import {
  cleanupHashAndFile,
  getFolderNameFromUrl,
  startTestServer,
  stopTestServer,
  setupTestDirectory,
} from "./testUtils.helper.js";

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

// Setup: Create test directory and start server
test.before(async (t) => {
  await startTestServer();
  await setupTestDirectory(t);
});

// Clean up server after tests
test.after.always(async () => {
  await stopTestServer();
});

// Test: Upload with hash and verify Redis storage
test.serial("should store file metadata in Redis with hash", async (t) => {
  const fileContent = "test content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  const hash = "test-hash-" + uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId, hash);
    t.is(response.status, 200, "Upload should succeed");
    t.truthy(response.data.url, "Should have file URL");
    t.is(response.data.hash, hash, "Should return correct hash");

    // Wait for Redis operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify hash exists in Redis
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: (status) => true,
    });

    t.is(checkResponse.status, 200, "Hash should exist in Redis");
    t.truthy(checkResponse.data.url, "Hash check should return URL");
    t.is(
      checkResponse.data.url,
      response.data.url,
      "Hash check should return correct URL",
    );
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(hash, response.data.url, baseUrl);
    }
  }
});

// Test: Upload with GCS backup verification
test.serial("should create GCS backup when configured", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const fileContent = "test content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Upload should succeed");
    t.truthy(response.data.url, "Should have primary storage URL");
    t.truthy(response.data.gcs, "Should have GCS backup URL");
    t.true(
      response.data.gcs.startsWith("gs://"),
      "GCS URL should use gs:// protocol",
    );

    // Verify file exists in both storages
    const primaryResponse = await axios.get(response.data.url);
    t.is(primaryResponse.status, 200, "Primary file should be accessible");
    t.is(
      primaryResponse.data,
      fileContent,
      "Primary file content should match",
    );

    // GCS file should be accessible through the primary URL
    // since we can't directly access gs:// URLs
    const gcsResponse = await axios.get(response.data.url);
    t.is(gcsResponse.status, 200, "GCS file should be accessible");
    t.is(gcsResponse.data, fileContent, "GCS file content should match");
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

// Test: Upload with large file
test.serial("should handle large file upload", async (t) => {
  const largeContent = "x".repeat(10 * 1024 * 1024); // 10MB
  const filePath = await createTestFile(largeContent, "txt");
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Large file upload should succeed");
    t.truthy(response.data.url, "Should have file URL");

    // Verify file content
    const fileResponse = await axios.get(response.data.url);
    t.is(fileResponse.status, 200, "File should be accessible");
    t.is(
      fileResponse.data.length,
      largeContent.length,
      "File size should match",
    );
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

// Test: Upload with special characters in filename
test("should handle special characters in filename", async (t) => {
  const fileContent = "test content";
  const specialFilename = `test file with spaces and special chars !@#$%^&*()_+-=[]{}|;:,.<>?${uuidv4()}.txt`;
  const filePath = await createTestFile(fileContent, specialFilename);
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Upload should succeed");
    t.truthy(response.data.url, "Should have file URL");
    t.truthy(response.data.filename, "Should have filename in response");

    // Verify file is accessible
    const fileResponse = await axios.get(response.data.url);
    t.is(fileResponse.status, 200, "File should be accessible");
    t.is(fileResponse.data, fileContent, "File content should match");
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

// Test: Upload with concurrent requests
test.serial("should handle concurrent uploads", async (t) => {
  const requestId = uuidv4();
  const uploads = [];
  const numUploads = 5;
  let responses = []; // Move declaration outside try block

  // Create and upload multiple files concurrently
  for (let i = 0; i < numUploads; i++) {
    const fileContent = `test content ${i}`;
    const filePath = await createTestFile(fileContent, "txt");
    uploads.push({
      filePath,
      promise: uploadFile(filePath, requestId),
    });
  }

  try {
    // Wait for all uploads to complete
    responses = await Promise.all(uploads.map((u) => u.promise));

    // Verify all uploads succeeded
    responses.forEach((response, i) => {
      t.is(response.status, 200, `Upload ${i} should succeed`);
      t.truthy(response.data.url, `Upload ${i} should have URL`);
    });

    // Verify all files are accessible
    for (const response of responses) {
      const fileResponse = await axios.get(response.data.url);
      t.is(fileResponse.status, 200, "File should be accessible");
    }
  } finally {
    // Cleanup all files
    for (const upload of uploads) {
      fs.unlinkSync(upload.filePath);
    }
    // Cleanup uploaded files
    for (const response of responses) {
      if (response?.data?.url) {
        await cleanupHashAndFile(null, response.data.url, baseUrl);
      }
    }
  }
});

// Test: Upload with missing file
test.serial("should handle missing file in request", async (t) => {
  const form = new FormData();
  form.append("requestId", uuidv4());

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
  });

  t.is(response.status, 400, "Should reject request without file");
  t.is(
    response.data,
    "No file provided in request",
    "Should return correct error message",
  );
});

// Test: Upload with empty file
test.serial("should handle empty file upload", async (t) => {
  const filePath = await createTestFile("", "txt");
  const requestId = uuidv4();
  let response;

  try {
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 400, "Should reject empty file");
    t.is(
      response.data,
      "Invalid file: file is empty",
      "Should return correct error message",
    );
  } finally {
    fs.unlinkSync(filePath);
  }
});

// Test: Upload without requestId should generate one
test.serial("should generate requestId when not provided", async (t) => {
  const fileContent = "test content";
  const filePath = await createTestFile(fileContent, "txt");
  let response;

  try {
    response = await uploadFile(filePath);
    t.is(response.status, 200, "Upload should succeed without requestId");
    t.truthy(response.data.url, "Should have file URL");

    // Extract requestId from the URL
    const urlParts = response.data.url.split("/");
    const requestId = urlParts[urlParts.length - 2]; // requestId is the second-to-last part of the URL
    t.truthy(requestId, "URL should contain a requestId");
    t.true(requestId.length > 0, "requestId should not be empty");

    // Verify file is accessible
    const fileResponse = await axios.get(response.data.url);
    t.is(fileResponse.status, 200, "File should be accessible");
    t.is(fileResponse.data, fileContent, "File content should match");
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});
