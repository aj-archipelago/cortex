import test from "ava";
import { v4 as uuidv4 } from "uuid";

import {
  setFileStoreMap,
  getFileStoreMap,
  removeFromFileStoreMap,
  getScopedHashKey,
  client,
} from "../src/redis.js";
import { getDefaultContainerName } from "../src/constants.js";

/**
 * Tests for Redis key migration logic.
 * 
 * Key formats:
 * - Legacy: `<hash>:<containerName>` (read-only, migrated on access)
 * - Current: `<hash>` (unscoped) or `<hash>:ctx:<contextId>` (context-scoped)
 * 
 * Migration behavior:
 * - On read: If legacy key found, copy to new key, delete legacy key
 * - On write: Always write to new format only
 * - On delete: Clean up both new and legacy keys
 */

// Helper to create a legacy key directly in Redis (simulating old data)
async function setLegacyKey(hash, containerName, value) {
  const legacyKey = `${hash}:${containerName}`;
  await client.hset("FileStoreMap", legacyKey, JSON.stringify(value));
  return legacyKey;
}

// Helper to check if a key exists in Redis
async function keyExists(key) {
  const value = await client.hget("FileStoreMap", key);
  return value !== null;
}

// Helper to get raw value from Redis (without migration logic)
async function getRawKey(key) {
  const value = await client.hget("FileStoreMap", key);
  return value ? JSON.parse(value) : null;
}

// Helper to delete a key directly
async function deleteRawKey(key) {
  await client.hdel("FileStoreMap", key);
}

test.beforeEach(() => {
  // Tests use the mock Redis client automatically (NODE_ENV=test)
});

// =============================================================================
// getScopedHashKey tests
// =============================================================================

test("getScopedHashKey - returns hash when no contextId", (t) => {
  const hash = "abc123";
  const result = getScopedHashKey(hash);
  t.is(result, "abc123");
});

test("getScopedHashKey - returns hash when contextId is null", (t) => {
  const hash = "abc123";
  const result = getScopedHashKey(hash, null);
  t.is(result, "abc123");
});

test("getScopedHashKey - returns context-scoped key when contextId provided", (t) => {
  const hash = "abc123";
  const contextId = "user-456";
  const result = getScopedHashKey(hash, contextId);
  t.is(result, "abc123:ctx:user-456");
});

test("getScopedHashKey - handles empty hash", (t) => {
  t.is(getScopedHashKey(""), "");
  t.is(getScopedHashKey(null), null);
  t.is(getScopedHashKey(undefined), undefined);
});

// =============================================================================
// Legacy key migration on READ
// =============================================================================

test("getFileStoreMap - migrates legacy container-scoped key to unscoped key", async (t) => {
  const hash = `test-migrate-${uuidv4()}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;
  const testData = {
    url: "http://example.com/file.txt",
    filename: "file.txt",
    timestamp: new Date().toISOString(),
  };

  // Set up legacy key directly in Redis
  await setLegacyKey(hash, containerName, testData);

  // Verify legacy key exists before migration
  t.true(await keyExists(legacyKey), "Legacy key should exist before read");
  t.false(await keyExists(hash), "New key should not exist before read");

  // Read using unscoped hash - should trigger migration
  const result = await getFileStoreMap(hash, true); // skipLazyCleanup=true to avoid storage checks

  // Verify data was returned correctly
  t.truthy(result, "Should return the migrated data");
  t.is(result.url, testData.url);
  t.is(result.filename, testData.filename);

  // Verify migration occurred: new key exists, legacy key deleted
  t.true(await keyExists(hash), "New unscoped key should exist after migration");
  t.false(await keyExists(legacyKey), "Legacy key should be deleted after migration");

  // Cleanup
  await deleteRawKey(hash);
});

test("getFileStoreMap - does not migrate when unscoped key already exists", async (t) => {
  const hash = `test-no-migrate-${uuidv4()}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;

  const currentData = { url: "http://current.com/file.txt", filename: "current.txt" };
  const legacyData = { url: "http://legacy.com/file.txt", filename: "legacy.txt" };

  // Set up both keys
  await client.hset("FileStoreMap", hash, JSON.stringify(currentData));
  await setLegacyKey(hash, containerName, legacyData);

  // Read using unscoped hash
  const result = await getFileStoreMap(hash, true);

  // Should return current data, not legacy
  t.is(result.url, currentData.url, "Should return current data, not legacy");

  // Legacy key should still exist (not touched since current key was found first)
  t.true(await keyExists(legacyKey), "Legacy key should still exist");

  // Cleanup
  await deleteRawKey(hash);
  await deleteRawKey(legacyKey);
});

test("getFileStoreMap - context-scoped key does NOT fall back to unscoped hash (security)", async (t) => {
  const hash = `test-ctx-no-fallback-${uuidv4()}`;
  const contextId = "user-123";
  const contextKey = `${hash}:ctx:${contextId}`;

  const unscopedData = { url: "http://unscoped.com/file.txt", filename: "unscoped.txt" };

  // Only set unscoped key (no context-scoped key)
  await client.hset("FileStoreMap", hash, JSON.stringify(unscopedData));

  // Read using context-scoped key - should NOT fall back for security
  const result = await getFileStoreMap(contextKey, true);

  // Should NOT return unscoped data (security isolation)
  t.is(result, null, "Should NOT fall back to unscoped data for security");
  
  // Unscoped key should still exist
  t.true(await keyExists(hash), "Unscoped key should still exist");

  // Cleanup
  await deleteRawKey(hash);
});

test("getFileStoreMap - context-scoped key does NOT fall back through unscoped to legacy (security)", async (t) => {
  const hash = `test-ctx-legacy-no-fallback-${uuidv4()}`;
  const contextId = "user-456";
  const contextKey = `${hash}:ctx:${contextId}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;

  const legacyData = { url: "http://legacy.com/file.txt", filename: "legacy.txt" };

  // Only set legacy key (no context-scoped or unscoped keys)
  await setLegacyKey(hash, containerName, legacyData);

  // Read using context-scoped key - should NOT fall back for security
  const result = await getFileStoreMap(contextKey, true);

  // Should NOT return legacy data (security isolation)
  t.is(result, null, "Should NOT fall back to legacy data for security");
  
  // Legacy key should still exist (not migrated)
  t.true(await keyExists(legacyKey), "Legacy key should still exist");
  t.false(await keyExists(hash), "Unscoped key should NOT be created");

  // Cleanup
  await deleteRawKey(legacyKey);
});

// =============================================================================
// Write behavior - always uses new format
// =============================================================================

test("setFileStoreMap - writes to the key provided (unscoped)", async (t) => {
  const hash = `test-write-unscoped-${uuidv4()}`;
  const testData = { url: "http://example.com/file.txt", filename: "file.txt" };

  await setFileStoreMap(hash, testData);

  // Verify it was written to the unscoped key
  const result = await getRawKey(hash);
  t.truthy(result);
  t.is(result.url, testData.url);
  t.truthy(result.timestamp, "Should add timestamp");

  // Cleanup
  await deleteRawKey(hash);
});

test("setFileStoreMap - writes to context-scoped key when provided", async (t) => {
  const hash = `test-write-ctx-${uuidv4()}`;
  const contextId = "user-789";
  const contextKey = getScopedHashKey(hash, contextId);
  const testData = { url: "http://example.com/file.txt", filename: "file.txt" };

  await setFileStoreMap(contextKey, testData);

  // Verify it was written to the context-scoped key
  const result = await getRawKey(contextKey);
  t.truthy(result);
  t.is(result.url, testData.url);

  // Unscoped key should NOT exist
  t.false(await keyExists(hash), "Unscoped key should not be created");

  // Cleanup
  await deleteRawKey(contextKey);
});

// =============================================================================
// Delete behavior - cleans up both new and legacy keys
// =============================================================================

test("removeFromFileStoreMap - deletes unscoped key and legacy key", async (t) => {
  const hash = `test-delete-both-${uuidv4()}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;

  const testData = { url: "http://example.com/file.txt", filename: "file.txt" };

  // Set up both keys
  await client.hset("FileStoreMap", hash, JSON.stringify(testData));
  await setLegacyKey(hash, containerName, testData);

  // Verify both exist
  t.true(await keyExists(hash));
  t.true(await keyExists(legacyKey));

  // Delete using unscoped hash
  await removeFromFileStoreMap(hash);

  // Both should be gone
  t.false(await keyExists(hash), "Unscoped key should be deleted");
  t.false(await keyExists(legacyKey), "Legacy key should also be deleted");
});

test("removeFromFileStoreMap - deletes legacy key even when unscoped doesn't exist", async (t) => {
  const hash = `test-delete-legacy-only-${uuidv4()}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;

  const testData = { url: "http://example.com/file.txt", filename: "file.txt" };

  // Only set legacy key
  await setLegacyKey(hash, containerName, testData);

  // Verify only legacy exists
  t.false(await keyExists(hash));
  t.true(await keyExists(legacyKey));

  // Delete using unscoped hash
  await removeFromFileStoreMap(hash);

  // Legacy should be gone
  t.false(await keyExists(legacyKey), "Legacy key should be deleted");
});

test("removeFromFileStoreMap - handles context-scoped key deletion", async (t) => {
  const hash = `test-delete-ctx-${uuidv4()}`;
  const contextId = "user-delete";
  const contextKey = `${hash}:ctx:${contextId}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;

  const testData = { url: "http://example.com/file.txt", filename: "file.txt" };

  // Set up context-scoped key and legacy key
  await client.hset("FileStoreMap", contextKey, JSON.stringify(testData));
  await setLegacyKey(hash, containerName, testData);

  // Delete using context-scoped key
  await removeFromFileStoreMap(contextKey);

  // Context key should be deleted
  t.false(await keyExists(contextKey), "Context-scoped key should be deleted");
  
  // Legacy key should also be deleted (cleanup based on base hash)
  t.false(await keyExists(legacyKey), "Legacy key should also be deleted");
});

// =============================================================================
// Edge cases
// =============================================================================

test("getFileStoreMap - returns null when no keys exist", async (t) => {
  const hash = `test-nonexistent-${uuidv4()}`;
  const result = await getFileStoreMap(hash, true);
  t.is(result, null);
});

test("migration - preserves all original data fields", async (t) => {
  const hash = `test-preserve-fields-${uuidv4()}`;
  const containerName = getDefaultContainerName();
  
  const originalData = {
    url: "http://example.com/file.txt",
    gcs: "gs://bucket/file.txt",
    filename: "file.txt",
    hash: hash,
    timestamp: "2024-01-01T00:00:00.000Z",
    customField: "custom-value",
    nested: { key: "value" },
  };

  // Set up legacy key
  await setLegacyKey(hash, containerName, originalData);

  // Read to trigger migration
  const result = await getFileStoreMap(hash, true);

  // Verify all fields are preserved
  t.is(result.url, originalData.url);
  t.is(result.gcs, originalData.gcs);
  t.is(result.filename, originalData.filename);
  t.is(result.hash, originalData.hash);
  t.is(result.timestamp, originalData.timestamp);
  t.is(result.customField, originalData.customField);
  t.deepEqual(result.nested, originalData.nested);

  // Cleanup
  await deleteRawKey(hash);
});

test("migration - does not affect keys with colons in hash", async (t) => {
  // Keys that already contain colons (like context-scoped keys) should not
  // trigger legacy migration logic
  const contextKey = `somehash:ctx:user123`;
  const testData = { url: "http://example.com/file.txt", filename: "file.txt" };

  await client.hset("FileStoreMap", contextKey, JSON.stringify(testData));

  // Reading should just return the data without trying legacy migration
  const result = await getFileStoreMap(contextKey, true);
  t.truthy(result);
  t.is(result.url, testData.url);

  // Cleanup
  await deleteRawKey(contextKey);
});

// =============================================================================
// Security: Context-scoped isolation
// =============================================================================

test("getFileStoreMap - context-scoped file cannot be accessed without contextId", async (t) => {
  const hash = `test-security-${uuidv4()}`;
  const contextId = "user-secure";
  const contextKey = `${hash}:ctx:${contextId}`;
  const testData = {
    url: "http://example.com/secure-file.txt",
    filename: "secure-file.txt",
    timestamp: new Date().toISOString(),
  };

  // Write file with contextId
  await setFileStoreMap(contextKey, testData);

  // Verify context-scoped key exists
  t.true(await keyExists(contextKey), "Context-scoped key should exist");

  // Try to read WITHOUT contextId - should NOT find it
  const unscopedResult = await getFileStoreMap(hash, true);
  t.is(unscopedResult, null, "Should NOT be able to read context-scoped file without contextId");

  // Try to read WITH correct contextId - should find it
  const scopedResult = await getFileStoreMap(contextKey, true);
  t.truthy(scopedResult, "Should be able to read with correct contextId");
  t.is(scopedResult.url, testData.url);

  // Cleanup
  await deleteRawKey(contextKey);
});

test("getFileStoreMap - context-scoped file cannot be accessed with wrong contextId", async (t) => {
  const hash = `test-security-wrong-${uuidv4()}`;
  const correctContextId = "user-correct";
  const wrongContextId = "user-wrong";
  const correctKey = `${hash}:ctx:${correctContextId}`;
  const wrongKey = `${hash}:ctx:${wrongContextId}`;
  const testData = {
    url: "http://example.com/secure-file.txt",
    filename: "secure-file.txt",
    timestamp: new Date().toISOString(),
  };

  // Write file with correct contextId
  await setFileStoreMap(correctKey, testData);

  // Try to read with wrong contextId - should NOT find it
  const wrongResult = await getFileStoreMap(wrongKey, true);
  t.is(wrongResult, null, "Should NOT be able to read with wrong contextId");

  // Verify correct contextId still works
  const correctResult = await getFileStoreMap(correctKey, true);
  t.truthy(correctResult, "Should still be able to read with correct contextId");

  // Cleanup
  await deleteRawKey(correctKey);
});

test("removeFromFileStoreMap - context-scoped file cannot be deleted without contextId", async (t) => {
  const hash = `test-security-delete-${uuidv4()}`;
  const contextId = "user-delete-secure";
  const contextKey = `${hash}:ctx:${contextId}`;
  const testData = {
    url: "http://example.com/secure-file.txt",
    filename: "secure-file.txt",
    timestamp: new Date().toISOString(),
  };

  // Write file with contextId
  await setFileStoreMap(contextKey, testData);
  t.true(await keyExists(contextKey), "Context-scoped key should exist");

  // Try to delete WITHOUT contextId - should NOT delete context-scoped file
  await removeFromFileStoreMap(hash);
  t.true(await keyExists(contextKey), "Context-scoped key should still exist after unscoped delete attempt");

  // Delete WITH correct contextId - should work
  await removeFromFileStoreMap(contextKey);
  t.false(await keyExists(contextKey), "Context-scoped key should be deleted with correct contextId");
});

test("getFileStoreMap - unscoped file can be read without contextId", async (t) => {
  const hash = `test-unscoped-${uuidv4()}`;
  const testData = {
    url: "http://example.com/unscoped-file.txt",
    filename: "unscoped-file.txt",
    timestamp: new Date().toISOString(),
  };

  // Write file without contextId (unscoped)
  await setFileStoreMap(hash, testData);

  // Should be able to read without contextId
  const result = await getFileStoreMap(hash, true);
  t.truthy(result, "Should be able to read unscoped file without contextId");
  t.is(result.url, testData.url);

  // Cleanup
  await deleteRawKey(hash);
});

test("getFileStoreMap - unscoped file can fall back to legacy container-scoped key", async (t) => {
  const hash = `test-legacy-fallback-${uuidv4()}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;
  const testData = {
    url: "http://example.com/legacy-file.txt",
    filename: "legacy-file.txt",
    timestamp: new Date().toISOString(),
  };

  // Set up legacy key (no unscoped or context-scoped key exists)
  await setLegacyKey(hash, containerName, testData);

  // Reading unscoped hash should find and migrate legacy key
  const result = await getFileStoreMap(hash, true);
  t.truthy(result, "Should find legacy key when reading unscoped hash");
  t.is(result.url, testData.url);

  // Legacy key should be migrated (deleted)
  t.false(await keyExists(legacyKey), "Legacy key should be deleted after migration");
  t.true(await keyExists(hash), "Unscoped key should exist after migration");

  // Cleanup
  await deleteRawKey(hash);
});

test("getFileStoreMap - context-scoped read does NOT fall back to unscoped or legacy", async (t) => {
  const hash = `test-no-fallback-${uuidv4()}`;
  const contextId = "user-no-fallback";
  const contextKey = `${hash}:ctx:${contextId}`;
  const containerName = getDefaultContainerName();
  const legacyKey = `${hash}:${containerName}`;
  const unscopedData = { url: "http://example.com/unscoped.txt", filename: "unscoped.txt" };
  const legacyData = { url: "http://example.com/legacy.txt", filename: "legacy.txt" };

  // Set up unscoped and legacy keys (but NOT context-scoped)
  await setFileStoreMap(hash, unscopedData);
  await setLegacyKey(hash, containerName, legacyData);

  // Try to read with contextId - should NOT find unscoped or legacy
  const result = await getFileStoreMap(contextKey, true);
  t.is(result, null, "Context-scoped read should NOT fall back to unscoped or legacy keys");

  // Verify unscoped and legacy keys still exist
  t.true(await keyExists(hash), "Unscoped key should still exist");
  t.true(await keyExists(legacyKey), "Legacy key should still exist");

  // Cleanup
  await deleteRawKey(hash);
  await deleteRawKey(legacyKey);
});
