import test from "ava";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { port } from "../src/start.js";
import { startTestServer } from "./testUtils.helper.js";

// Test server setup
let baseUrl;
let server;

// Start test server before running tests
test.before(async (t) => {
  baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

  // Start the test server
  server = await startTestServer();
});

// Clean up server after tests
test.after.always(async (t) => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

// Helper to create a test file
async function createTestFile(content, extension = "txt", filename = null) {
  const tempDir = os.tmpdir();
  const actualFilename = filename || `test-${uuidv4()}.${extension}`;
  const filePath = path.join(tempDir, actualFilename);
  
  if (extension === "txt") {
    fs.writeFileSync(filePath, content);
  } else {
    throw new Error(`Unsupported file extension: ${extension}`);
  }
  
  return filePath;
}

// Helper to upload a file with hash and container
async function uploadFileWithHashAndContainer(filePath, hash, containerName) {
  const form = new FormData();
  // Append hash and container BEFORE file so they're processed first
  form.append("hash", hash);
  if (containerName) {
    form.append("container", containerName);
  }
  form.append("file", fs.createReadStream(filePath));

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
    timeout: 10000,
  });

  return response;
}

// Helper to check if hash exists with optional container
async function checkHashExists(hash, containerName = null) {
  const params = {
    hash,
    checkHash: true,
  };
  
  if (containerName) {
    params.container = containerName;
  }

  const response = await axios.get(baseUrl, {
    params,
    validateStatus: (status) => true,
    timeout: 10000,
  });

  return response;
}

// Helper to cleanup hash
async function cleanupHash(hash, containerName = null) {
  const params = {
    hash,
    clearHash: true,
  };
  
  if (containerName) {
    params.container = containerName;
  }

  try {
    await axios.get(baseUrl, {
      params,
      validateStatus: (status) => true,
      timeout: 5000,
    });
  } catch (error) {
    // Ignore cleanup errors
  }
}

// Main test: Hash scoping across containers
test.serial("should scope hash by container - same hash different containers should be independent", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    const testHash = `hash-scope-test-${uuidv4()}`;
    const contentA = "Content for container A";
    const contentB = "Content for container B";
    const fileA = await createTestFile(contentA, "txt", "fileA.txt");
    const fileB = await createTestFile(contentB, "txt", "fileB.txt");

    // Upload file to container test1 with hash
    const uploadA = await uploadFileWithHashAndContainer(fileA, testHash, "test1");
    t.is(uploadA.status, 200, "Upload to test1 should succeed");
    t.truthy(uploadA.data.url, "Upload A should have URL");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Upload file to container test2 with SAME hash
    const uploadB = await uploadFileWithHashAndContainer(fileB, testHash, "test2");
    t.is(uploadB.status, 200, "Upload to test2 should succeed");
    t.truthy(uploadB.data.url, "Upload B should have URL");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check hash in container test1 - should return file A
    const checkA = await checkHashExists(testHash, "test1");
    t.is(checkA.status, 200, "Hash should exist in test1");
    t.is(checkA.data.url, uploadA.data.url, "Should return URL from container test1");

    // Check hash in container test2 - should return file B
    const checkB = await checkHashExists(testHash, "test2");
    t.is(checkB.status, 200, "Hash should exist in test2");
    t.is(checkB.data.url, uploadB.data.url, "Should return URL from container test2");

    // Verify the URLs are different
    t.not(checkA.data.url, checkB.data.url, "URLs should be different for same hash in different containers");

    // Verify the file contents are different
    const fileResponseA = await axios.get(uploadA.data.url, {
      validateStatus: (status) => true,
      timeout: 5000,
    });
    const fileResponseB = await axios.get(uploadB.data.url, {
      validateStatus: (status) => true,
      timeout: 5000,
    });
    
    t.is(fileResponseA.data, contentA, "File A should have correct content");
    t.is(fileResponseB.data, contentB, "File B should have correct content");

    // Cleanup
    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
    await cleanupHash(testHash, "test1");
    await cleanupHash(testHash, "test2");

    // Delete the actual files
    await axios.delete(baseUrl, {
      params: {
        hash: testHash,
        container: "test1",
      },
      validateStatus: (status) => true,
    });
    await axios.delete(baseUrl, {
      params: {
        hash: testHash,
        container: "test2",
      },
      validateStatus: (status) => true,
    });
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test: Hash in default container should be scoped with container name
test.serial("should scope hash for default container with container name", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  const originalDefaultEnv = process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";
  // Ensure test1 is the default container
  delete process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME;

  try {
    const testHash = `hash-default-test-${uuidv4()}`;
    const content = "Content for default container";
    const file = await createTestFile(content, "txt", "fileDefault.txt");

    // Upload file to default container (test1) with hash
    // We upload WITHOUT specifying container, so it should use default
    // Now it will be stored as hash:test1 (always scoped)
    const uploadDefault = await uploadFileWithHashAndContainer(file, testHash, null);
    t.is(uploadDefault.status, 200, "Upload to default should succeed");
    t.truthy(uploadDefault.data.url, "Upload should have URL");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check hash without container parameter - should work for default container
    const checkWithoutContainer = await checkHashExists(testHash, null);
    t.is(checkWithoutContainer.status, 200, "Hash should exist without container param");
    t.is(checkWithoutContainer.data.url, uploadDefault.data.url, "Should return URL from default container");

    // Check hash with explicit default container parameter - should also work
    const checkWithDefaultContainer = await checkHashExists(testHash, "test1");
    t.is(checkWithDefaultContainer.status, 200, "Hash should exist with default container param");
    t.is(checkWithDefaultContainer.data.url, uploadDefault.data.url, "Should return same URL with default container param");

    // Cleanup
    fs.unlinkSync(file);
    await cleanupHash(testHash, null);

    // Delete the actual file
    await axios.delete(baseUrl, {
      params: {
        hash: testHash,
      },
      validateStatus: (status) => true,
    });
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
    if (originalDefaultEnv) {
      process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME = originalDefaultEnv;
    } else {
      delete process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test: Backwards compatibility - legacy hash without container should be found for default container
test.serial("should support backwards compatibility for legacy hashes in default container", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  const originalDefaultEnv = process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";
  // Ensure test1 is the default container for backwards compatibility logic
  delete process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME;

  try {
    const testHash = `hash-legacy-test-${uuidv4()}`;
    const content = "Content for legacy test";
    const file = await createTestFile(content, "txt", "fileLegacy.txt");

    // Upload file to default container (test1) with hash - this creates the scoped entry
    const upload = await uploadFileWithHashAndContainer(file, testHash, "test1");
    t.is(upload.status, 200, "Upload to test1 should succeed");
    t.truthy(upload.data.url, "Upload should have URL");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Now simulate a legacy entry by also storing the hash WITHOUT container scope
    // This mimics the old behavior before container scoping was added
    const { client } = await import("../src/redis.js");
    const legacyData = {
      url: upload.data.url, // Use the real uploaded URL
      timestamp: new Date().toISOString(),
    };
    await client.hset("FileStoreMap", testHash, JSON.stringify(legacyData));

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Delete the scoped key to simulate only having the legacy entry
    const { getScopedHashKey } = await import("../src/redis.js");
    const scopedKey = getScopedHashKey(testHash, "test1");
    await client.hdel("FileStoreMap", scopedKey);

    // Wait a bit for Redis
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check hash with default container parameter - should find the legacy entry
    const checkWithDefaultContainer = await checkHashExists(testHash, "test1");
    t.is(checkWithDefaultContainer.status, 200, "Legacy hash should be found with default container param");
    t.is(checkWithDefaultContainer.data.url, legacyData.url, "Should return URL from legacy entry");

    // Check hash without container parameter - should also find the legacy entry
    const checkWithoutContainer = await checkHashExists(testHash, null);
    t.is(checkWithoutContainer.status, 200, "Legacy hash should be found without container param");
    t.is(checkWithoutContainer.data.url, legacyData.url, "Should return URL from legacy entry");

    // After migration, the new scoped key should exist
    const { getFileStoreMap } = await import("../src/redis.js");
    const migratedValue = await getFileStoreMap(scopedKey, true); // Skip lazy cleanup
    t.truthy(migratedValue, "Migrated value should exist with new scoped key");
    t.is(migratedValue.url, legacyData.url, "Migrated value should have same URL");

    // Cleanup
    fs.unlinkSync(file);
    await cleanupHash(testHash, "test1");
    await cleanupHash(testHash, null);

    // Delete the actual file
    await axios.delete(baseUrl, {
      params: {
        hash: testHash,
        container: "test1",
      },
      validateStatus: (status) => true,
    });
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
    if (originalDefaultEnv) {
      process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME = originalDefaultEnv;
    } else {
      delete process.env.DEFAULT_AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test: Hash check with wrong container should return 404
test.serial("should return 404 when checking hash with wrong container", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    const testHash = `hash-wrong-container-test-${uuidv4()}`;
    const content = "Content for specific container";
    const file = await createTestFile(content, "txt", "fileWrong.txt");

    // Upload file to container test1 with hash
    const upload = await uploadFileWithHashAndContainer(file, testHash, "test1");
    t.is(upload.status, 200, "Upload to test1 should succeed");

    // Wait for Redis to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check hash in container test2 (wrong container) - should return 404
    const checkWrong = await checkHashExists(testHash, "test2");
    t.is(checkWrong.status, 404, "Hash should not exist in test2");

    // Check hash in container test3 (also wrong) - should return 404
    const checkWrong2 = await checkHashExists(testHash, "test3");
    t.is(checkWrong2.status, 404, "Hash should not exist in test3");

    // Check hash in container test1 (correct container) - should return 200
    const checkCorrect = await checkHashExists(testHash, "test1");
    t.is(checkCorrect.status, 200, "Hash should exist in test1");

    // Cleanup
    fs.unlinkSync(file);
    await cleanupHash(testHash, "test1");

    // Delete the actual file
    await axios.delete(baseUrl, {
      params: {
        hash: testHash,
        container: "test1",
      },
      validateStatus: (status) => true,
    });
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

