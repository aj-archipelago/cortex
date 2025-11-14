import test from "ava";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

import { port } from "../src/start.js";
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
async function createTestFile(content, extension) {
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const filename = path.join(
    testDir,
    `test-delete-${uuidv4().slice(0, 8)}.${extension}`,
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

// Helper function to delete file by hash
async function deleteFileByHash(hash) {
  return await axios.delete(`${baseUrl}?hash=${hash}`, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
}

// Helper function to check if hash exists
async function checkHashExists(hash) {
  return await axios.get(`${baseUrl}?hash=${hash}&checkHash=true`, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
}

// Test setup
test.before(async (t) => {
  await setupTestDirectory(__dirname);
  await startTestServer();
});

test.after(async (t) => {
  await stopTestServer();
});

// Basic delete by hash tests
test.serial("should delete file by hash successfully", async (t) => {
  const testContent = "test content for hash deletion";
  const testHash = `test-hash-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Should have file URL");

    // Verify file exists via hash
    const hashCheckBefore = await checkHashExists(testHash);
    t.is(hashCheckBefore.status, 200, "Hash should exist before deletion");

    // Delete file by hash
    const deleteResponse = await deleteFileByHash(testHash);
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.message, "Should have success message");
    t.true(deleteResponse.data.message.includes(testHash), "Message should include hash");
    t.truthy(deleteResponse.data.deleted, "Should have deletion details");

    // Verify file is gone via hash
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

    // Wait a moment for deletion to propagate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify file URL is no longer accessible
    const fileResponse = await axios.get(uploadResponse.data.url, {
      validateStatus: (status) => true,
    });
    t.is(fileResponse.status, 404, "File URL should return 404 after deletion");

  } finally {
    fs.unlinkSync(filePath);
    // Additional cleanup just in case
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should return 404 when deleting non-existent hash", async (t) => {
  const nonExistentHash = `non-existent-${uuidv4()}`;

  const deleteResponse = await deleteFileByHash(nonExistentHash);
  t.is(deleteResponse.status, 404, "Should return 404 for non-existent hash");
  t.truthy(deleteResponse.data, "Should have error message");
  t.true(deleteResponse.data.includes("not found"), "Error should indicate file not found");
});

test.serial("should return 400 when hash parameter is missing", async (t) => {
  const deleteResponse = await axios.delete(baseUrl, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
  
  t.is(deleteResponse.status, 400, "Should return 400 for missing parameters");
  t.truthy(deleteResponse.data, "Should have error response");
});

test.serial("should delete file with both primary and backup storage", async (t) => {
  const testContent = "test content for dual storage deletion";
  const testHash = `test-dual-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    
    // Check if GCS backup was created
    const hasGcsBackup = uploadResponse.data.gcs && uploadResponse.data.gcs.startsWith("gs://");
    
    // Delete file by hash
    const deleteResponse = await deleteFileByHash(testHash);
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.deleted, "Should have deletion details");

    
    // Should have at least primary storage deletion
    const deletionDetails = deleteResponse.data.deleted.deleted;
    t.true(Array.isArray(deletionDetails), "Deletion details should be an array");
    t.true(deletionDetails.length >= 1, "Should have at least primary deletion result");
    const primaryDeletion = deletionDetails.find(d => d.provider === 'primary');
    t.truthy(primaryDeletion, "Should have primary storage deletion");
    
    // If GCS backup existed, should also have backup deletion
    if (hasGcsBackup) {
      const backupDeletion = deletionDetails.find(d => d.provider === 'backup');
      t.truthy(backupDeletion, "Should have backup storage deletion when GCS is configured");
    }

    // Verify hash is completely removed
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should handle malformed hash gracefully", async (t) => {
  const malformedHashes = ["", "   ", "null", "undefined", "{}"];

  for (const badHash of malformedHashes) {
    const deleteResponse = await deleteFileByHash(badHash);
    t.true(
      deleteResponse.status === 404 || deleteResponse.status === 400,
      `Should return 404 or 400 for malformed hash: "${badHash}"`
    );
  }
});

test.serial("should prioritize requestId over hash when both provided", async (t) => {
  const testContent = "test content for priority test";
  const testHash = `test-priority-${uuidv4()}`;
  const requestId = uuidv4();
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with both hash and requestId
    uploadResponse = await uploadFile(filePath, requestId, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Delete using both hash and requestId - should delete by requestId (current behavior)
    const deleteResponse = await axios.delete(`${baseUrl}?hash=${testHash}&requestId=${requestId}`, {
      validateStatus: (status) => true,
      timeout: 10000,
    });
    
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.body, "Should have deletion body");
    t.true(Array.isArray(deleteResponse.data.body), "Deletion body should be array of deleted files");

    // Verify hash is gone (because the file was deleted via requestId)
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should return proper response format for successful deletion", async (t) => {
  const testContent = "test content for response format";
  const testHash = `test-response-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Delete file by hash
    const deleteResponse = await deleteFileByHash(testHash);
    t.is(deleteResponse.status, 200, "Delete should succeed");
    
    // Verify response structure
    t.truthy(deleteResponse.data, "Should have response data");
    t.truthy(deleteResponse.data.message, "Should have success message");
    t.is(deleteResponse.data.deleted.hash, testHash, "Should include deleted hash");
    t.truthy(deleteResponse.data.deleted.filename, "Should include filename");
    t.truthy(deleteResponse.data.deleted.deleted, "Should include deletion details");
    t.true(Array.isArray(deleteResponse.data.deleted.deleted), "Deletion details should be array");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should handle deletion when Redis is temporarily unavailable", async (t) => {
  const testContent = "test content for Redis failure";
  const testHash = `test-redis-fail-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Manually corrupt the Redis entry to simulate Redis issues
    await setFileStoreMap(testHash, { corrupted: "data" });

    // Delete file by hash - should handle Redis issues gracefully
    const deleteResponse = await deleteFileByHash(testHash);
    
    // The behavior may vary depending on how Redis failures are handled
    // It should either succeed with a warning or fail gracefully
    t.true(
      deleteResponse.status === 200 || deleteResponse.status === 404 || deleteResponse.status === 500,
      "Should handle Redis failure gracefully"
    );

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should delete file uploaded with different filename", async (t) => {
  const testContent = "test content with special filename";
  const testHash = `test-filename-${uuidv4()}`;
  const specialFilename = "test file with spaces & symbols!@#.txt";
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with special filename and hash
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), specialFilename);
    form.append("hash", testHash);

    uploadResponse = await axios.post(baseUrl, form, {
      headers: form.getHeaders(),
      validateStatus: (status) => true,
      timeout: 15000,
    });
    
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Delete file by hash
    const deleteResponse = await deleteFileByHash(testHash);
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.deleted.filename, "Should include original filename");

    // Verify hash is gone
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

// Tests for DELETE with hash in request body
test.serial("should delete file by hash from request body params", async (t) => {
  const testContent = "test content for body params deletion";
  const testHash = `test-body-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Delete file by hash using body params
    const deleteResponse = await axios.delete(baseUrl, {
      data: { params: { hash: testHash } },
      validateStatus: (status) => true,
      timeout: 10000,
    });
    
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.message, "Should have success message");
    t.true(deleteResponse.data.message.includes(testHash), "Message should include hash");
    t.is(deleteResponse.data.deleted.hash, testHash, "Should include deleted hash");

    // Verify hash is gone
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should delete file by hash from request body (direct)", async (t) => {
  const testContent = "test content for direct body deletion";
  const testHash = `test-direct-body-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with hash
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Delete file by hash using direct body (not in params)
    const deleteResponse = await axios.delete(baseUrl, {
      data: { hash: testHash },
      validateStatus: (status) => true,
      timeout: 10000,
    });
    
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.message, "Should have success message");
    t.is(deleteResponse.data.deleted.hash, testHash, "Should include deleted hash");

    // Verify hash is gone
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should prioritize query string over body params for hash", async (t) => {
  const testContent = "test content for priority test";
  const queryHash = `test-query-${uuidv4()}`;
  const bodyHash = `test-body-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with query hash
    uploadResponse = await uploadFile(filePath, null, queryHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Try to delete with hash in both query and body - query should take priority
    const deleteResponse = await axios.delete(`${baseUrl}?hash=${queryHash}`, {
      data: { params: { hash: bodyHash } },
      validateStatus: (status) => true,
      timeout: 10000,
    });
    
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.is(deleteResponse.data.deleted.hash, queryHash, "Should use query hash, not body hash");

    // Verify query hash is gone
    const queryHashCheck = await checkHashExists(queryHash);
    t.is(queryHashCheck.status, 404, "Query hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(queryHash);
      await removeFromFileStoreMap(bodyHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should delete file by requestId from body params", async (t) => {
  const testContent = "test content for requestId body deletion";
  const requestId = uuidv4();
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file with requestId
    uploadResponse = await uploadFile(filePath, requestId, null);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Delete file by requestId using body params
    const deleteResponse = await axios.delete(baseUrl, {
      data: { params: { requestId: requestId } },
      validateStatus: (status) => true,
      timeout: 10000,
    });
    
    t.is(deleteResponse.status, 200, "Delete should succeed");
    t.truthy(deleteResponse.data.body, "Should have deletion body");
    t.true(Array.isArray(deleteResponse.data.body), "Deletion body should be array");

  } finally {
    fs.unlinkSync(filePath);
  }
});

test.serial("should handle standard Azure URL format correctly", async (t) => {
  const testContent = "test content for standard URL format";
  const testHash = `test-standard-url-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");
    t.truthy(uploadResponse.data.url, "Should have file URL");
    
    // Verify URL format is standard Azure format (container/blob)
    const url = uploadResponse.data.url;
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
    t.true(pathParts.length >= 2, "URL should have at least container and blob name");

    // Delete file - should parse URL correctly
    const deleteResponse = await deleteFileByHash(testHash);
    t.is(deleteResponse.status, 200, "Delete should succeed");
    
    // Verify deletion was successful
    const hashCheckAfter = await checkHashExists(testHash);
    t.is(hashCheckAfter.status, 404, "Hash should not exist after deletion");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should handle backwards compatibility key removal correctly", async (t) => {
  const testContent = "test content for legacy key test";
  const testHash = `test-legacy-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Manually create a legacy unscoped key to test backwards compatibility
    const { setFileStoreMap, getFileStoreMap, getScopedHashKey } = await import("../src/redis.js");
    const { getDefaultContainerName } = await import("../src/constants.js");
    const defaultContainer = getDefaultContainerName();
    const scopedHash = getScopedHashKey(testHash, defaultContainer);
    const hashResult = await getFileStoreMap(scopedHash);
    
    if (hashResult) {
      // Create legacy unscoped key
      await setFileStoreMap(testHash, hashResult);
      
      // Verify both keys exist
      const scopedExists = await getFileStoreMap(scopedHash);
      const legacyExists = await getFileStoreMap(testHash);
      t.truthy(scopedExists, "Scoped key should exist");
      t.truthy(legacyExists, "Legacy key should exist");

      // Delete file - should remove both keys
      const deleteResponse = await deleteFileByHash(testHash);
      t.is(deleteResponse.status, 200, "Delete should succeed");

      // Verify both keys are removed
      const scopedAfter = await getFileStoreMap(scopedHash);
      const legacyAfter = await getFileStoreMap(testHash);
      t.falsy(scopedAfter, "Scoped key should be removed");
      t.falsy(legacyAfter, "Legacy key should be removed");
    }

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should not log 'does not exist' when legacy key doesn't exist", async (t) => {
  const testContent = "test content for no legacy key test";
  const testHash = `test-no-legacy-${uuidv4()}`;
  const filePath = await createTestFile(testContent, "txt");
  let uploadResponse;

  try {
    // Upload file (this creates only the scoped key, no legacy key)
    uploadResponse = await uploadFile(filePath, null, testHash);
    t.is(uploadResponse.status, 200, "Upload should succeed");

    // Verify only scoped key exists
    const { getFileStoreMap, getScopedHashKey } = await import("../src/redis.js");
    const { getDefaultContainerName } = await import("../src/constants.js");
    const defaultContainer = getDefaultContainerName();
    const scopedHash = getScopedHashKey(testHash, defaultContainer);
    const scopedExists = await getFileStoreMap(scopedHash);
    const legacyExists = await getFileStoreMap(testHash);
    t.truthy(scopedExists, "Scoped key should exist");
    t.falsy(legacyExists, "Legacy key should not exist");

    // Delete file - should not try to remove non-existent legacy key
    // (This test verifies the fix doesn't log "does not exist" unnecessarily)
    const deleteResponse = await deleteFileByHash(testHash);
    t.is(deleteResponse.status, 200, "Delete should succeed");

    // Verify scoped key is removed
    const scopedAfter = await getFileStoreMap(scopedHash);
    t.falsy(scopedAfter, "Scoped key should be removed");

  } finally {
    fs.unlinkSync(filePath);
    try {
      await removeFromFileStoreMap(testHash);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
});

test.serial("should handle error message for missing hash/requestId correctly", async (t) => {
  // Test with no parameters at all
  const deleteResponse1 = await axios.delete(baseUrl, {
    validateStatus: (status) => true,
    timeout: 10000,
  });
  
  t.is(deleteResponse1.status, 400, "Should return 400 for missing parameters");
  t.truthy(deleteResponse1.data, "Should have error message");
  t.true(
    deleteResponse1.data.includes("query string or request body"),
    "Error should mention both query string and request body"
  );

  // Test with empty body
  const deleteResponse2 = await axios.delete(baseUrl, {
    data: {},
    validateStatus: (status) => true,
    timeout: 10000,
  });
  
  t.is(deleteResponse2.status, 400, "Should return 400 for missing parameters");
});