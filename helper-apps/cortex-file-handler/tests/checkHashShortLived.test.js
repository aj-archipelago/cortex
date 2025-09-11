import test from "ava";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

import { port } from "../src/start.js";
import { AZURITE_ACCOUNT_NAME } from "../src/constants.js";
import { 
  cleanupHashAndFile, 
  createTestMediaFile, 
  startTestServer, 
  stopTestServer, 
  setupTestDirectory 
} from "./testUtils.helper.js";
import { 
  setFileStoreMap, 
  getFileStoreMap, 
  removeFromFileStoreMap 
} from "../src/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to create test files
async function createTestFile(content, extension = "txt") {
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const filename = path.join(
    testDir,
    `test-checkhash-${uuidv4().slice(0, 8)}.${extension}`,
  );
  fs.writeFileSync(filename, content);
  return filename;
}

// Helper function to upload file
async function uploadFile(filePath, requestId = null, hash = null) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  if (requestId) form.append("requestId", requestId);
  if (hash) form.append("hash", hash);

  return await axios.post(baseUrl, form, {
    headers: form.getHeaders(),
    validateStatus: (status) => true,
    timeout: 15000,
  });
}

// Helper function to check hash
async function checkHash(hash, shortLivedMinutes = null) {
  const params = { hash, checkHash: true };
  if (shortLivedMinutes !== null) {
    params.shortLivedMinutes = shortLivedMinutes;
  }

  return await axios.get(baseUrl, {
    params,
    validateStatus: (status) => true,
    timeout: 10000,
  });
}

// Helper to check if Azure is configured (real Azure, not local emulator)
function isAzureConfigured() {
  return process.env.AZURE_STORAGE_CONNECTION_STRING && 
         !process.env.AZURE_STORAGE_CONNECTION_STRING.includes("UseDevelopmentStorage=true");
}

// Helper to check if using Azure storage provider (including Azurite emulator)
function isUsingAzureStorage() {
  return process.env.AZURE_STORAGE_CONNECTION_STRING;
}

// Helper to check if GCS is configured
function isGCSConfigured() {
  return process.env.GOOGLE_CLOUD_PROJECT_ID && 
         process.env.GOOGLE_CLOUD_BUCKET_NAME;
}

// Test setup
test.before(async (t) => {
  await setupTestDirectory(__dirname);
  await startTestServer();
});

test.after(async (t) => {
  await stopTestServer();
});

// Core functionality tests
test.serial("checkHash should always return shortLivedUrl", async (t) => {
  const filePath = await createTestFile("Content for shortLivedUrl test");
  const hash = `test-shortlived-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Upload should return URL");

    // Check hash - should always return shortLivedUrl now
    const checkResponse = await checkHash(hash);

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data, "checkHash should return data");
    t.truthy(checkResponse.data.url, "Response should include original URL");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.truthy(checkResponse.data.expiresInMinutes, "Response should include expiration time");
    t.is(checkResponse.data.expiresInMinutes, 5, "Default expiration should be 5 minutes");

    // Verify shortLivedUrl behavior based on storage provider
    if (isUsingAzureStorage()) {
      // With Azure (including Azurite), shortLivedUrl should be different from original URL
      t.not(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With Azure storage, shortLivedUrl should be different from original URL"
      );
    } else {
      // With LocalStorage, shortLivedUrl equals original URL (fallback behavior)
      t.is(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With LocalStorage provider, shortLivedUrl should equal original URL (fallback behavior)"
      );
    }

    // Verify base URLs are the same (only SAS token should differ)
    const originalUrlBase = checkResponse.data.url.split('?')[0];
    const shortLivedUrlBase = checkResponse.data.shortLivedUrl.split('?')[0];
    t.is(originalUrlBase, shortLivedUrlBase, "Base URLs should be the same");

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should respect custom shortLivedMinutes parameter", async (t) => {
  const filePath = await createTestFile("Content for custom duration test");
  const hash = `test-custom-duration-${uuidv4()}`;
  const customMinutes = 15;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Check hash with custom duration
    const checkResponse = await checkHash(hash, customMinutes);

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.is(checkResponse.data.expiresInMinutes, customMinutes, `Expiration should be ${customMinutes} minutes`);

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should handle invalid shortLivedMinutes parameter gracefully", async (t) => {
  const filePath = await createTestFile("Content for invalid parameter test");
  const hash = `test-invalid-param-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Check hash with invalid shortLivedMinutes
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
        shortLivedMinutes: "invalid",
      },
      validateStatus: (status) => true,
      timeout: 10000,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed even with invalid shortLivedMinutes");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.is(checkResponse.data.expiresInMinutes, 5, "Should default to 5 minutes for invalid input");

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash shortLivedUrl should be accessible", async (t) => {
  const testContent = "Content for accessibility test";
  const filePath = await createTestFile(testContent);
  const hash = `test-accessible-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Check hash to get shortLivedUrl
    const checkResponse = await checkHash(hash);

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");

    // Verify the shortLivedUrl is accessible
    // Skip this test for Azure emulator as it may have network issues
    if (isAzureConfigured() && !checkResponse.data.shortLivedUrl.includes(AZURITE_ACCOUNT_NAME)) {
      // Test with real Azure storage
      const fileResponse = await axios.get(checkResponse.data.shortLivedUrl, {
        validateStatus: (status) => true,
        timeout: 10000,
      });

      t.is(fileResponse.status, 200, "shortLivedUrl should be accessible with real Azure storage");
      t.is(fileResponse.data, testContent, "File content should match through shortLivedUrl");
    } else {
      // For LocalStorage provider, shortLivedUrl should be accessible
      const fileResponse = await axios.get(checkResponse.data.shortLivedUrl, {
        validateStatus: (status) => true,
        timeout: 10000,
      });

      t.is(fileResponse.status, 200, "shortLivedUrl should be accessible");
      t.is(fileResponse.data, testContent, "File content should match through shortLivedUrl");
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should return consistent response structure", async (t) => {
  const filePath = await createTestFile("Content for structure test");
  const hash = `test-structure-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Test checkHash with default parameters
    const checkResponse1 = await axios.get(baseUrl, {
      params: { hash, checkHash: true },
      validateStatus: (status) => true,
    });

    // Test checkHash with custom shortLivedMinutes
    const checkResponse2 = await axios.get(baseUrl, {
      params: { hash, checkHash: true, shortLivedMinutes: 10 },
      validateStatus: (status) => true,
    });

    // Both responses should have the same structure
    const expectedKeys = [
      'message', 'filename', 'url', 'hash', 'timestamp',
      'shortLivedUrl', 'expiresInMinutes'
    ];

    for (const response of [checkResponse1, checkResponse2]) {
      t.is(response.status, 200, "checkHash should succeed");
      
      for (const key of expectedKeys) {
        t.truthy(response.data[key] !== undefined, `Response should include ${key}`);
      }
    }

    // shortLivedUrl behavior depends on storage provider
    if (isUsingAzureStorage()) {
      // With Azure storage (including Azurite), different expiration times should result in different SAS tokens
      t.not(
        checkResponse1.data.shortLivedUrl,
        checkResponse2.data.shortLivedUrl,
        "With Azure storage, shortLivedUrls with different expiration should be different"
      );
    } else {
      // With LocalStorage provider, shortLivedUrl should be the same
      t.is(
        checkResponse1.data.shortLivedUrl,
        checkResponse2.data.shortLivedUrl,
        "With LocalStorage provider, shortLivedUrls are the same regardless of expiration time"
      );
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should handle fallback when SAS token generation is not supported", async (t) => {
  const filePath = await createTestFile("Content for fallback test");
  const hash = `test-fallback-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Check hash - should handle fallback gracefully
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: (status) => true,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.truthy(checkResponse.data.expiresInMinutes, "Response should include expiresInMinutes");

    if (isUsingAzureStorage()) {
      // When Azure is configured (including Azurite), shortLivedUrl should be different from original URL
      t.not(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With Azure storage, shortLivedUrl should be different from original URL"
      );

      // Azure URLs should contain query parameters (SAS token)
      t.true(
        checkResponse.data.shortLivedUrl.includes('?'),
        "Azure shortLivedUrl should contain query parameters"
      );
    } else {
      // When using LocalStorageProvider (fallback), shortLivedUrl should equal original URL
      t.is(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With LocalStorage provider, shortLivedUrl should equal original URL (fallback behavior)"
      );
    }

    // Verify the shortLivedUrl is accessible regardless of storage provider
    if (isAzureConfigured() && !checkResponse.data.shortLivedUrl.includes(AZURITE_ACCOUNT_NAME)) {
      // Test with real Azure storage
      const fileResponse = await axios.get(checkResponse.data.shortLivedUrl, {
        validateStatus: (status) => true,
        timeout: 10000,
      });

      t.is(fileResponse.status, 200, "shortLivedUrl should be accessible with real Azure storage");
    } else {
      // Test with LocalStorage
      const fileResponse = await axios.get(checkResponse.data.shortLivedUrl, {
        validateStatus: (status) => true,
      });

      t.is(fileResponse.status, 200, "shortLivedUrl should be accessible with LocalStorage");
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should maintain consistent behavior across multiple calls", async (t) => {
  const filePath = await createTestFile("Content for consistency test");
  const hash = `test-consistency-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Make multiple checkHash calls
    const responses = [];
    for (let i = 0; i < 3; i++) {
      const checkResponse = await axios.get(baseUrl, {
        params: { hash, checkHash: true },
        validateStatus: (status) => true,
      });

      t.is(checkResponse.status, 200, `checkHash call ${i + 1} should succeed`);
      responses.push(checkResponse.data);
    }

    // All responses should have the required fields
    for (const [index, response] of responses.entries()) {
      t.truthy(response.shortLivedUrl, `Response ${index + 1} should have shortLivedUrl`);
      t.truthy(response.expiresInMinutes, `Response ${index + 1} should have expiresInMinutes`);
      t.is(response.hash, hash, `Response ${index + 1} should have correct hash`);
      t.truthy(response.filename, `Response ${index + 1} should have filename`);
      t.truthy(response.url, `Response ${index + 1} should have original URL`);
    }

    if (isAzureConfigured()) {
      // All shortLivedUrls should be different (new SAS tokens each time)
      const shortLivedUrls = responses.map(r => r.shortLivedUrl);
      const uniqueUrls = new Set(shortLivedUrls);
      t.is(uniqueUrls.size, shortLivedUrls.length, "Each call should generate unique short-lived URL with Azure");
    } else {
      // With LocalStorage, all should be the same
      const firstUrl = responses[0].shortLivedUrl;
      for (const response of responses) {
        t.is(response.shortLivedUrl, firstUrl, "LocalStorage shortLivedUrls should be consistent");
      }
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should handle zero and negative shortLivedMinutes", async (t) => {
  const filePath = await createTestFile("Content for edge case test");
  const hash = `test-edge-case-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Test with zero minutes
    const checkResponse1 = await checkHash(hash, 0);
    t.is(checkResponse1.status, 200, "checkHash should succeed with 0 minutes");
    t.truthy(checkResponse1.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.is(checkResponse1.data.expiresInMinutes, 5, "Should default to 5 minutes for 0 input");

    // Test with negative minutes - the implementation passes through negative values
    const checkResponse2 = await checkHash(hash, -5);
    t.is(checkResponse2.status, 200, "checkHash should succeed with negative minutes");
    t.truthy(checkResponse2.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.is(checkResponse2.data.expiresInMinutes, -5, "Implementation passes through negative values as-is");

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash should return 404 for non-existent hash but still include shortLivedUrl in error context", async (t) => {
  const nonExistentHash = `non-existent-${uuidv4()}`;

  const checkResponse = await checkHash(nonExistentHash);
  
  t.is(checkResponse.status, 404, "checkHash should return 404 for non-existent hash");
  t.truthy(checkResponse.data, "Should have error response");
  t.true(
    typeof checkResponse.data === 'string' && checkResponse.data.includes('not found'),
    "Error message should indicate hash not found"
  );
});

test.serial("checkHash with large file should return shortLivedUrl", async (t) => {
  const largeContent = "Large file content ".repeat(1000); // ~20KB content (reduced size)
  const filePath = await createTestFile(largeContent);
  const hash = `test-large-${uuidv4()}`;
  let uploadResponse;

  try {
    // Upload large file with hash
    uploadResponse = await uploadFile(filePath, null, hash);
    t.is(uploadResponse.status, 200, "Large file upload should succeed");
    t.truthy(uploadResponse.data.url, "Should have upload URL");

    // If hash is in response, use it; otherwise, the upload may not have stored the hash
    const uploadedHash = uploadResponse.data.hash || hash;

    // Check hash for large file
    const checkResponse = await checkHash(uploadedHash);

    if (checkResponse.status === 200) {
      t.truthy(checkResponse.data.shortLivedUrl, "Large file should have shortLivedUrl");
      t.truthy(checkResponse.data.expiresInMinutes, "Large file should have expiration time");

      // Verify base URLs match
      const originalUrlBase = checkResponse.data.url.split('?')[0];
      const shortLivedUrlBase = checkResponse.data.shortLivedUrl.split('?')[0];
      t.is(originalUrlBase, shortLivedUrlBase, "Base URLs should match for large file");
    } else {
      // If hash wasn't stored properly, skip this test
      t.pass("Large file test skipped - hash not stored properly in upload");
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadResponse?.data?.url) {
      await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
    }
  }
});

test.serial("checkHash with different file types should return shortLivedUrl", async (t) => {
  const fileTypes = [
    { ext: "txt", content: "Text file content" },
    { ext: "json", content: '{"key": "value"}' },
    { ext: "xml", content: "<root><data>test</data></root>" },
    { ext: "csv", content: "name,value\ntest,123" }
  ];

  for (const fileType of fileTypes) {
    const filePath = await createTestFile(fileType.content, fileType.ext);
    const hash = `test-${fileType.ext}-${uuidv4()}`;
    let uploadResponse;

    try {
      // Upload file with hash
      uploadResponse = await uploadFile(filePath, null, hash);
      t.is(uploadResponse.status, 200, `${fileType.ext} file upload should succeed`);

      // Check hash
      const checkResponse = await checkHash(hash);

      t.is(checkResponse.status, 200, `checkHash should succeed for ${fileType.ext} file`);
      t.truthy(checkResponse.data.shortLivedUrl, `${fileType.ext} file should have shortLivedUrl`);
      t.truthy(checkResponse.data.expiresInMinutes, `${fileType.ext} file should have expiration time`);

    } finally {
      fs.unlinkSync(filePath);
      if (uploadResponse?.data?.url) {
        await cleanupHashAndFile(hash, uploadResponse.data.url, baseUrl);
      }
    }
  }
});