import test from "ava";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

import { port } from "../src/start.js";
import { 
  startTestServer, 
  stopTestServer, 
  setupTestDirectory 
} from "./testUtils.helper.js";
import { 
  getFileStoreMap, 
  removeFromFileStoreMap,
  getScopedHashKey
} from "../src/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to create test files
async function createTestFile(content, extension) {
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const filename = path.join(
    testDir,
    `test-retention-${uuidv4().slice(0, 8)}.${extension}`,
  );
  fs.writeFileSync(filename, content);
  return filename;
}

// Helper function to upload file with hash and container
async function uploadFile(filePath, hash = null, containerName = null, contextId = null) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  if (hash) form.append("hash", hash);
  if (containerName) form.append("container", containerName);
  if (contextId) form.append("contextId", contextId);

  return await axios.post(baseUrl, form, {
    headers: form.getHeaders(),
    validateStatus: (status) => true,
    timeout: 15000,
  });
}

// Helper function to check if hash exists
async function checkHashExists(hash, containerName = null, contextId = null) {
  const params = { hash, checkHash: true };
  if (containerName) {
    params.container = containerName;
  }
  if (contextId) {
    params.contextId = contextId;
  }
  return await axios.get(baseUrl, {
    params,
    validateStatus: (status) => true,
    timeout: 10000,
  });
}

// Helper function to set retention
async function setRetention(hash, retention, useBody = false, contextId = null) {
  const bodyOrParams = { hash, retention, setRetention: true };
  if (contextId) {
    bodyOrParams.contextId = contextId;
  }
  
  if (useBody) {
    return await axios.post(baseUrl, bodyOrParams, {
      validateStatus: (status) => true,
      timeout: 30000,
    });
  } else {
    return await axios.post(baseUrl, null, {
      params: bodyOrParams,
      validateStatus: (status) => true,
      timeout: 30000,
    });
  }
}

// Test setup
test.before(async (t) => {
  await setupTestDirectory(t, "test-files");
  await startTestServer();
});

test.after(async (t) => {
  await stopTestServer();
});

// Basic retention tests
test.serial("should set file retention to permanent", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for retention operation";
  const testHash = `test-retention-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file (defaults to temporary)
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Should have file URL");
    const originalUrl = uploadResponse.data.url;

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention to permanent
    const retentionResponse = await setRetention(testHash, "permanent");
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.is(retentionResponse.data.retention, "permanent", "Should have retention set to permanent");
    t.is(retentionResponse.data.url, originalUrl, "URL should remain the same");
    t.truthy(retentionResponse.data.shortLivedUrl, "Should have shortLivedUrl");
    t.truthy(retentionResponse.data.message, "Should have success message");

    // Wait for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify file still exists and is accessible
    const checkAfter = await checkHashExists(testHash);
    t.is(checkAfter.status, 200, "File should still exist after setting retention");
    t.is(checkAfter.data.url, originalUrl, "URL should still match");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should set file retention to temporary", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for temporary retention";
  const testHash = `test-retention-temp-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file (defaults to temporary)
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    const originalUrl = uploadResponse.data.url;

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // First set to permanent
    await setRetention(testHash, "permanent");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Then set back to temporary
    const retentionResponse = await setRetention(testHash, "temporary");
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.is(retentionResponse.data.retention, "temporary", "Should have retention set to temporary");
    t.is(retentionResponse.data.url, originalUrl, "URL should remain the same");
    t.truthy(retentionResponse.data.shortLivedUrl, "Should have shortLivedUrl");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should set retention using request body parameters", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for body retention";
  const testHash = `test-retention-body-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention using body parameters
    const retentionResponse = await setRetention(testHash, "permanent", true);
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.is(retentionResponse.data.retention, "permanent", "Should have retention set to permanent");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should return 400 when hash is missing", async (t) => {
  const retentionResponse = await axios.post(baseUrl, {
    retention: "permanent",
    setRetention: true,
  }, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
  t.is(retentionResponse.status, 400, "Should return 400 for missing hash");
  t.truthy(retentionResponse.data.includes("hash"), "Error message should mention hash");
});

test.serial("should return 400 when retention is missing", async (t) => {
  const testHash = `test-retention-${uuidv4()}`;
  const retentionResponse = await axios.post(baseUrl, {
    hash: testHash,
    setRetention: true,
  }, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
  t.is(retentionResponse.status, 400, "Should return 400 for missing retention");
  t.truthy(retentionResponse.data.includes("retention"), "Error message should mention retention");
});

test.serial("should return 400 when retention value is invalid", async (t) => {
  const testHash = `test-retention-${uuidv4()}`;
  const retentionResponse = await axios.post(baseUrl, {
    hash: testHash,
    retention: "invalid",
    setRetention: true,
  }, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
  t.is(retentionResponse.status, 400, "Should return 400 for invalid retention");
  t.truthy(
    retentionResponse.data.includes("temporary") || retentionResponse.data.includes("permanent"),
    "Error message should mention valid retention values"
  );
});

test.serial("should return 404 when file hash not found", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const nonExistentHash = `non-existent-${uuidv4()}`;
  const retentionResponse = await setRetention(nonExistentHash, "permanent");
  t.is(retentionResponse.status, 404, "Should return 404 for non-existent hash");
  t.truthy(retentionResponse.data.includes("not found"), "Error message should indicate file not found");
});

test.serial("should update Redis map with retention information", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for Redis map update";
  const testHash = `test-retention-redis-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify Redis entry exists
    const scopedHash = getScopedHashKey(testHash);
    const oldEntry = await getFileStoreMap(scopedHash);
    t.truthy(oldEntry, "Redis entry should exist before setting retention");
    t.is(oldEntry.permanent, false, "New uploads should have permanent=false by default");

    // Set retention
    const retentionResponse = await setRetention(testHash, "permanent");
    t.is(retentionResponse.status, 200, "Set retention should succeed");

    // Wait for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify Redis entry is updated
    const newEntry = await getFileStoreMap(scopedHash);
    t.truthy(newEntry, "Redis entry should still exist after setting retention");
    t.is(newEntry.url, retentionResponse.data.url, "Entry should have correct URL");
    t.truthy(newEntry.shortLivedUrl, "Entry should have shortLivedUrl");
    t.is(newEntry.permanent, true, "Entry should have permanent=true in Redis (matches file collection logic)");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should preserve file metadata after setting retention", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for metadata preservation";
  const testHash = `test-retention-metadata-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    const originalFilename = uploadResponse.data.filename;
    const originalUrl = uploadResponse.data.url;

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention
    const retentionResponse = await setRetention(testHash, "permanent");
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.is(retentionResponse.data.hash, testHash, "Hash should be preserved");
    t.is(retentionResponse.data.filename, originalFilename, "Filename should be preserved");
    t.is(retentionResponse.data.url, originalUrl, "URL should remain the same");

    // Wait for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify metadata is preserved
    const checkAfter = await checkHashExists(testHash);
    t.is(checkAfter.status, 200, "File should still exist");
    t.is(checkAfter.data.hash, testHash, "Hash should match");
    t.is(checkAfter.data.filename, originalFilename, "Filename should match");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should support operation=setRetention query parameter", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for operation parameter";
  const testHash = `test-retention-operation-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention using operation=setRetention query parameter
    const retentionResponse = await axios.post(baseUrl, null, {
      params: {
        operation: "setRetention",
        hash: testHash,
        retention: "permanent",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    });
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.is(retentionResponse.data.retention, "permanent", "Should have retention set to permanent");

    // Wait for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify file still exists
    const checkAfter = await checkHashExists(testHash);
    t.is(checkAfter.status, 200, "File should still exist after setting retention");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should preserve GCS URL when setting retention", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  // Skip if GCS is not configured
  if (!process.env.GCP_SERVICE_ACCOUNT_KEY && !process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const testContent = "test content for GCS preservation";
  const testHash = `test-retention-gcs-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Should have Azure URL");
    t.truthy(uploadResponse.data.gcs, "Should have GCS URL");
    
    const originalGcsUrl = uploadResponse.data.gcs;
    const originalAzureUrl = uploadResponse.data.url;

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention
    const retentionResponse = await setRetention(testHash, "permanent");
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    
    // Verify GCS URL is preserved
    t.is(retentionResponse.data.gcs, originalGcsUrl, "GCS URL should be preserved");
    
    // Verify Azure URL remains the same (no container change)
    t.is(retentionResponse.data.url, originalAzureUrl, "Azure URL should remain the same");

    // Wait for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify GCS URL is still preserved in checkHash response
    const checkAfter = await checkHashExists(testHash);
    t.is(checkAfter.status, 200, "File should still exist");
    t.is(checkAfter.data.gcs, originalGcsUrl, "GCS URL should still be preserved");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should always include shortLivedUrl in response", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for shortLivedUrl";
  const testHash = `test-retention-shortlived-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.shortLivedUrl, "Upload response should include shortLivedUrl");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention
    const retentionResponse = await setRetention(testHash, "permanent");
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.truthy(retentionResponse.data.shortLivedUrl, "Retention response should include shortLivedUrl");
    t.truthy(retentionResponse.data.url, "Should have regular URL");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      await removeFromFileStoreMap(getScopedHashKey(testHash));
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should set retention for context-scoped file", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for context-scoped retention";
  const testHash = `test-retention-context-${uuidv4()}`;
  const contextId = `test-context-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with contextId
    uploadResponse = await uploadFile(filePath, testHash, null, contextId);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.is(uploadResponse.data.contextId, contextId, "Should have contextId in response");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Set retention with the same contextId
    const retentionResponse = await setRetention(testHash, "permanent", false, contextId);
    t.is(retentionResponse.status, 200, "Set retention should succeed");
    t.is(retentionResponse.data.retention, "permanent", "Should have retention set to permanent");
    t.truthy(retentionResponse.data.shortLivedUrl, "Should have shortLivedUrl");

    // Verify Redis entry was updated with context-scoped key
    const { getScopedHashKey } = await import("../src/redis.js");
    const scopedKey = getScopedHashKey(testHash, contextId);
    const updatedEntry = await getFileStoreMap(scopedKey);
    t.truthy(updatedEntry, "Should have updated entry in Redis");
    t.truthy(updatedEntry.shortLivedUrl, "Should have shortLivedUrl in Redis entry");
    t.is(updatedEntry.permanent, true, "Entry should have permanent=true in Redis (matches file collection logic)");

    // Wait for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify file still exists with contextId
    const checkResponse = await checkHashExists(testHash, null, contextId);
    t.is(checkResponse.status, 200, "File should still exist after setting retention");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      const scopedKey = getScopedHashKey(testHash, contextId);
      await removeFromFileStoreMap(scopedKey);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should return 404 when contextId doesn't match for setRetention", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const testContent = "test content for context mismatch";
  const testHash = `test-retention-mismatch-${uuidv4()}`;
  const contextId1 = `test-context-1-${uuidv4()}`;
  const contextId2 = `test-context-2-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with contextId1
    uploadResponse = await uploadFile(filePath, testHash, null, contextId1);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Try to set retention with different contextId - should fail
    const retentionResponse = await setRetention(testHash, "permanent", false, contextId2);
    t.is(retentionResponse.status, 404, "Should return 404 when contextId doesn't match");
    t.truthy(retentionResponse.data.includes("not found"), "Error message should indicate file not found");

  } finally {
    fs.unlinkSync(filePath);
    // Cleanup
    try {
      const { getScopedHashKey } = await import("../src/redis.js");
      const scopedKey = getScopedHashKey(testHash, contextId1);
      await removeFromFileStoreMap(scopedKey);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});
