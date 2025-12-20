import Redis from "ioredis";
import { getDefaultContainerName } from "./constants.js";

const connectionString = process.env["REDIS_CONNECTION_STRING"];

/**
 * Get key for Redis storage.
 *
 * IMPORTANT:
 * - We **never** write hash+container scoped keys anymore (legacy only).
 * - We *do* support (optional) hash+contextId scoping for per-user/per-context storage.
 * - For reads, we can fall back to legacy hash+container keys if they still exist in Redis.
 *
 * Key format:
 * - No context:        "<hash>"
 * - With contextId:     "<hash>:ctx:<contextId>"
 *
 * @param {string} hash - The file hash
 * @param {string|null} contextId - Optional context id
 * @returns {string} The redis key for this hash/context
 */
export const getScopedHashKey = (hash, contextId = null) => {
  if (!hash) return hash;
  if (!contextId) return hash;
  return `${hash}:ctx:${contextId}`;
};

const legacyContainerKey = (hash, containerName) => {
  if (!hash || !containerName) return null;
  return `${hash}:${containerName}`;
};

// Create a mock client for test environment when Redis is not configured
const createMockClient = () => {
  const store = new Map();
  const hashMap = new Map();
  const locks = new Map(); // For lock simulation
  
  return {
    connected: false,
    async connect() { return Promise.resolve(); },
    async publish() { return Promise.resolve(); },
    async hgetall(hashName) { 
      const hash = hashMap.get(hashName);
      return hash ? Object.fromEntries(hash) : {};
    },
    async hset(hashName, key, value) { 
      if (!hashMap.has(hashName)) {
        hashMap.set(hashName, new Map());
      }
      hashMap.get(hashName).set(key, value);
      return Promise.resolve();
    },
    async hget(hashName, key) { 
      const hash = hashMap.get(hashName);
      return hash ? hash.get(key) || null : null;
    },
    async hdel(hashName, key) { 
      const hash = hashMap.get(hashName);
      if (hash && hash.has(key)) {
        hash.delete(key);
        return 1;
      }
      return 0;
    },
    async set(key, value, ...options) {
      // Handle SET with NX (only set if not exists) and EX (expiration)
      if (options.includes('NX')) {
        if (locks.has(key)) {
          return null; // Lock already exists
        }
        locks.set(key, Date.now());
        // Handle expiration if EX is provided
        const exIndex = options.indexOf('EX');
        if (exIndex !== -1 && options[exIndex + 1]) {
          const ttl = options[exIndex + 1] * 1000; // Convert to milliseconds
          setTimeout(() => locks.delete(key), ttl);
        }
        return 'OK';
      }
      locks.set(key, Date.now());
      return 'OK';
    },
    async del(key) {
      locks.delete(key);
      return 1;
    },
    async eval(script, numKeys, ...args) {
      // Mock implementation for atomic get-and-delete operation
      if (script.includes('hget') && script.includes('hdel')) {
        const hashName = args[0];
        const key = args[1];
        const hash = hashMap.get(hashName);
        if (hash && hash.has(key)) {
          const value = hash.get(key);
          hash.delete(key);
          return value;
        }
        return null;
      }
      throw new Error('Mock eval only supports atomic get-and-delete');
    },
  };
};

// Only create real Redis client if connection string is provided
let client;
if (connectionString && process.env.NODE_ENV !== 'test') {
  // ioredis client with explicit error handling to avoid:
  //   [ioredis] Unhandled error event: Error: read ETIMEDOUT
  //
  // This Redis usage is a cache / coordination layer for the file-handler.
  // It should degrade gracefully when Redis is unavailable.
  const retryStrategy = (times) => {
    // Exponential backoff: 100ms, 200ms, 400ms... up to 30s
    const delay = Math.min(100 * Math.pow(2, times), 30000);
    // After ~10 attempts, stop retrying (prevents tight reconnect loops forever).
    if (times > 10) {
      console.error(
        `[redis] Connection failed after ${times} attempts. Stopping retries.`,
      );
      return null;
    }
    console.warn(
      `[redis] Connection retry attempt ${times}, waiting ${delay}ms`,
    );
    return delay;
  };

  client = new Redis(connectionString, {
    retryStrategy,
    enableReadyCheck: true,
    connectTimeout: 10000,
    // If Redis is down, don't indefinitely queue cache operations in memory.
    // We'll catch and log failures at call sites instead.
    enableOfflineQueue: false,
    // Fail fast on commands during connection issues.
    maxRetriesPerRequest: 1,
  });

  // IMPORTANT: prevent process crashes on connection errors
  client.on("error", (error) => {
    const code = error?.code ? ` (${error.code})` : "";
    console.error(`[redis] Client error${code}: ${error?.message || error}`);
  });
  client.on("connect", () => {
    console.log("[redis] Connected");
  });
  client.on("ready", () => {
    console.log("[redis] Ready");
  });
  client.on("close", () => {
    console.warn("[redis] Connection closed");
  });
  client.on("reconnecting", (delay) => {
    console.warn(`[redis] Reconnecting in ${delay}ms`);
  });
} else {
  console.log('Using mock Redis client for tests or missing connection string');
  client = createMockClient();
}

const channel = "requestProgress";

const connectClient = async () => {
  // ioredis connects automatically; this function is kept for backwards
  // compatibility and for the mock client.
  try {
    // Mock client uses `connected`; ioredis uses `status`.
    if (typeof client?.connected === "boolean") {
      if (!client.connected && typeof client.connect === "function") {
        await client.connect();
      }
      return;
    }

    // ioredis states: "wait" | "connecting" | "connect" | "ready" | "close" | "end"
    if (client?.status && client.status !== "ready") {
      // If the caller explicitly wants to ensure connectivity, we can ping.
      // If Redis is down, ping will throw and we handle it.
      await client.ping();
    }
  } catch (error) {
    console.error(
      `[redis] Not ready (status=${client?.status || "unknown"}): ${error?.message || error}`,
    );
  }
};

const publishRequestProgress = async (data) => {
  // await connectClient();
  try {
    const message = JSON.stringify(data);
    console.log(`Publishing message ${message} to channel ${channel}`);
    await client.publish(channel, message);
  } catch (error) {
    console.error(`Error publishing message: ${error}`);
  }
};

// Function to get all key value pairs in "FileStoreMap" hash map
const getAllFileStoreMap = async () => {
  try {
    const allKeyValuePairs = await client.hgetall("FileStoreMap");
    // Parse each JSON value in the returned object
    for (const key in allKeyValuePairs) {
      try {
        // Modify the value directly in the returned object
        allKeyValuePairs[key] = JSON.parse(allKeyValuePairs[key]);
      } catch (error) {
        console.error(`Error parsing JSON for key ${key}: ${error}`);
        // keep original value if parsing failed
      }
    }
    return allKeyValuePairs;
  } catch (error) {
    console.error(
      `Error getting all key-value pairs from FileStoreMap: ${error}`,
    );
    return {}; // Return null or any default value indicating an error occurred
  }
};

// Function to set key value in "FileStoreMap" hash map
// If contextId is provided, writes to context-scoped map: FileStoreMap:ctx:<contextId>
// Otherwise writes to unscoped map: FileStoreMap
// Key is always the raw hash (no scoping in the key itself)
const setFileStoreMap = async (hash, value, contextId = null) => {
  try {
    if (!hash) {
      console.error("setFileStoreMap: hash is required");
      return;
    }
    
    // Create a copy of value to avoid mutating the original
    const valueToStore = { ...value };
    
    // Remove 'message' field - it's only for the upload response, not for persistence
    delete valueToStore.message;
    
    // Only set timestamp if one doesn't already exist
    if (!valueToStore.timestamp) {
      valueToStore.timestamp = new Date().toISOString();
    }
    
    // Determine which map to write to
    if (contextId) {
      // Write to context-scoped map with raw hash as key
      const contextMapKey = `FileStoreMap:ctx:${contextId}`;
      await client.hset(contextMapKey, hash, JSON.stringify(valueToStore));
    } else {
      // Write to unscoped map (backward compatibility)
      await client.hset("FileStoreMap", hash, JSON.stringify(valueToStore));
    }
  } catch (error) {
    console.error(`Error setting key in FileStoreMap: ${error}`);
  }
};

// Function to get all files for a context from context-scoped hash map
const getAllFilesForContext = async (contextId) => {
  try {
    if (!contextId) {
      return {};
    }
    const contextMapKey = `FileStoreMap:ctx:${contextId}`;
    const allKeyValuePairs = await client.hgetall(contextMapKey);
    // Parse each JSON value in the returned object
    for (const key in allKeyValuePairs) {
      try {
        allKeyValuePairs[key] = JSON.parse(allKeyValuePairs[key]);
      } catch (error) {
        console.error(`Error parsing JSON for key ${key}: ${error}`);
        // keep original value if parsing failed
      }
    }
    return allKeyValuePairs;
  } catch (error) {
    // Redact contextId in error logs for security
    const { redactContextId } = await import("./utils/logSecurity.js");
    const redactedContextId = redactContextId(contextId);
    console.error(`Error getting all files for context ${redactedContextId}: ${error}`);
    return {};
  }
};

const getFileStoreMap = async (hash, skipLazyCleanup = false, contextId = null) => {
  try {
    if (!hash) {
      return null;
    }
    
    // Try context-scoped map first if contextId is provided
    let value = null;
    if (contextId) {
      const contextMapKey = `FileStoreMap:ctx:${contextId}`;
      value = await client.hget(contextMapKey, hash);
    }
    
    // Fall back to unscoped map if not found
    if (!value) {
      value = await client.hget("FileStoreMap", hash);
    }
    
    // Backwards compatibility for unscoped keys only:
    // If unscoped hash doesn't exist, fall back to legacy hash+container key (if still present).
    // SECURITY: Context-scoped lookups NEVER fall back - they must match exactly.
    if (!value && !contextId) {
      const baseHash = hash;

      // Only allow fallback for unscoped keys (not context-scoped)
      // Context-scoped keys are security-isolated and must match exactly
      if (baseHash && !String(baseHash).includes(":")) {
        const defaultContainerName = getDefaultContainerName();
        const legacyKey = legacyContainerKey(baseHash, defaultContainerName);
        if (legacyKey) {
          value = await client.hget("FileStoreMap", legacyKey);
          if (value) {
            console.log(
              `Found legacy container-scoped key ${legacyKey} for hash ${baseHash}; migrating to unscoped key`,
            );
            // Migrate to unscoped key (we do NOT write legacy container-scoped keys)
            await client.hset("FileStoreMap", baseHash, value);
            // Delete the legacy key after migration
            await client.hdel("FileStoreMap", legacyKey);
            console.log(`Deleted legacy key ${legacyKey} after migration`);
          }
        }
      }
    }
    
    if (value) {
      try {
        // parse the value back to an object before returning
        const parsedValue = JSON.parse(value);

        // Lazy cleanup: check if file still exists when accessed (unless disabled)
        if (!skipLazyCleanup && (parsedValue?.url || parsedValue?.gcs)) {
          try {
            // Import StorageService here to avoid circular dependencies
            const { StorageService } = await import(
              "./services/storage/StorageService.js"
            );
            const storageService = new StorageService();

            let shouldRemove = false;
            let primaryExists = false;
            let gcsExists = false;

            // Check primary storage
            if (parsedValue?.url) {
              primaryExists = await storageService.fileExists(parsedValue.url);
              if (!primaryExists) {
                console.log(
                  `Lazy cleanup: Primary storage file missing for hash ${hash}: ${parsedValue.url}`,
                );
              }
            }

            // Check GCS backup if available
            if (parsedValue?.gcs && storageService.backupProvider) {
              gcsExists = await storageService.fileExists(parsedValue.gcs);
              if (gcsExists) {
                console.log(
                  `Lazy cleanup: GCS backup found for hash ${hash}, keeping entry`,
                );
              }
            }

            // Only remove if both primary and backup are missing
            if (!primaryExists && !gcsExists) {
              shouldRemove = true;
            }

            // Remove stale entry if both primary and backup are missing
            // Need to extract contextId from the key if it was scoped
            if (shouldRemove) {
              // For lazy cleanup, we don't have contextId, so try unscoped first
              // If the key was scoped, we'd need contextId, but lazy cleanup doesn't have it
              // So we'll just try to remove from unscoped map
              await removeFromFileStoreMap(hash, null);
              console.log(
                `Lazy cleanup: Removed stale cache entry for hash ${hash}`,
              );
              return null; // Return null since file no longer exists
            }
          } catch (error) {
            console.log(`Lazy cleanup error for hash ${hash}: ${error.message}`);
            // If cleanup fails, return the original value to avoid breaking functionality
          }
        }

        return parsedValue;
      } catch (error) {
        console.error(`Error parsing JSON: ${error}`);
        return value; // return original value if parsing failed
      }
    }
    return value;
  } catch (error) {
    console.error(`Error getting key from FileStoreMap: ${error}`);
    return null; // Return null or any default value indicating an error occurred
  }
};

// Function to remove key from "FileStoreMap" hash map
// If contextId is provided, removes from context-scoped map
// Otherwise removes from unscoped map
// Hash can be either raw hash or scoped key format (hash:ctx:contextId)
// If scoped format is provided, extracts base hash and removes both scoped and legacy keys
const removeFromFileStoreMap = async (hash, contextId = null) => {
  try {
    if (!hash) {
      return;
    }
    
    // Extract base hash if hash is in scoped format (hash:ctx:contextId)
    let baseHash = hash;
    let extractedContextId = contextId;
    if (String(hash).includes(":ctx:")) {
      const parts = String(hash).split(":ctx:");
      baseHash = parts[0];
      if (parts.length > 1 && !extractedContextId) {
        extractedContextId = parts[1];
      }
    }
    
    let result = 0;
    
    // First, try to delete from unscoped map (in case scoped key was stored there)
    if (!contextId) {
      // Remove from unscoped map (including scoped key format if present)
      result = await client.hdel("FileStoreMap", hash);
      // Also try removing with base hash if hash was scoped
      if (hash !== baseHash) {
        const baseResult = await client.hdel("FileStoreMap", baseHash);
        if (baseResult > 0) {
          result = baseResult;
        }
      }
    }
    
    // Also try to delete from context-scoped map if we extracted a contextId
    if (extractedContextId) {
      const contextMapKey = `FileStoreMap:ctx:${extractedContextId}`;
      const contextResult = await client.hdel(contextMapKey, baseHash);
      if (contextResult > 0) {
        result = contextResult;
      }
    } else if (contextId) {
      // If contextId was provided explicitly, delete from context-scoped map
      const contextMapKey = `FileStoreMap:ctx:${contextId}`;
      result = await client.hdel(contextMapKey, hash);
    }
    if (result > 0) {
      console.log(`The hash ${hash} was removed successfully`);
    }

    // Always try to clean up legacy container-scoped entry as well.
    // This ensures we don't leave orphaned legacy keys behind.
    // Only attempt legacy cleanup if baseHash doesn't contain a colon (not already scoped)
    if (!String(baseHash).includes(":")) {
      const defaultContainerName = getDefaultContainerName();
      const legacyKey = legacyContainerKey(baseHash, defaultContainerName);
      if (legacyKey) {
        const legacyResult = await client.hdel("FileStoreMap", legacyKey);
        if (legacyResult > 0) {
          console.log(`Removed legacy key ${legacyKey} successfully`);
        }
      }
    }

    if (result === 0) {
      console.log(`The hash ${hash} does not exist (may have been migrated or already deleted)`);
    }
  } catch (error) {
    console.error(`Error removing key from FileStoreMap: ${error}`);
  }
};

const cleanupRedisFileStoreMap = async (nDays = 1) => {
  const cleaned = [];
  try {
    const map = await getAllFileStoreMap();
    const nDaysAgo = new Date(Date.now() - nDays * 24 * 60 * 60 * 1000);

    for (const key in map) {
      const value = map[key];
      const timestamp = value?.timestamp ? new Date(value.timestamp) : null;
      if (!timestamp || timestamp.getTime() < nDaysAgo.getTime()) {
        // Remove the key from the "FileStoreMap" hash map
        await removeFromFileStoreMap(key);
        console.log(`Removed key ${key} from FileStoreMap`);
        cleaned.push(Object.assign({ hash: key }, value));
      }
    }
  } catch (error) {
    console.error(`Error cleaning FileStoreMap: ${error}`);
  } finally {
    // Cleanup code if needed
  }
  return cleaned;
};

// Age-based cleanup: removes old entries to prevent cache bloat
const cleanupRedisFileStoreMapAge = async (
  maxAgeDays = 7,
  maxEntriesToCheck = 10,
) => {
  const cleaned = [];
  try {
    const map = await getAllFileStoreMap();
    const maxAgeAgo = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

    // Convert to array and sort by timestamp (oldest first)
    // Skip permanent files - they should never be cleaned up by age
    const entries = Object.entries(map)
      .filter(([_, value]) => {
        // Only entries with timestamps and not permanent (matches file collection logic)
        return value?.timestamp && value?.permanent !== true;
      })
      .sort(([_, a], [__, b]) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeA - timeB; // Oldest first
      })
      .slice(0, maxEntriesToCheck); // Only check the oldest N entries

    for (const [key, value] of entries) {
      const timestamp = new Date(value.timestamp);
      if (timestamp.getTime() < maxAgeAgo.getTime()) {
        await removeFromFileStoreMap(key);
        console.log(
          `Age cleanup: Removed old entry ${key} (age: ${Math.round((Date.now() - timestamp.getTime()) / (24 * 60 * 60 * 1000))} days)`,
        );
        cleaned.push(Object.assign({ hash: key }, value));
      }
    }
  } catch (error) {
    console.error(`Error during age-based cleanup: ${error}`);
  }

  return cleaned;
};

/**
 * Acquire a distributed lock for a given key
 * Uses Redis SETNX with expiration to ensure atomic lock acquisition
 * @param {string} lockKey - The key to lock
 * @param {number} ttlSeconds - Time to live in seconds (default: 300 = 5 minutes)
 * @returns {Promise<boolean>} True if lock was acquired, false if already locked
 */
const acquireLock = async (lockKey, ttlSeconds = 300) => {
  try {
    const lockName = `lock:${lockKey}`;
    // Use SET with NX (only set if not exists) and EX (expiration)
    // Returns 'OK' if lock was acquired, null if already locked
    const result = await client.set(lockName, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch (error) {
    console.error(`Error acquiring lock for ${lockKey}:`, error);
    // In case of error, allow operation to proceed (fail open)
    // This prevents Redis issues from blocking operations
    return true;
  }
};

/**
 * Release a distributed lock for a given key
 * @param {string} lockKey - The key to unlock
 * @returns {Promise<void>}
 */
const releaseLock = async (lockKey) => {
  try {
    const lockName = `lock:${lockKey}`;
    await client.del(lockName);
  } catch (error) {
    console.error(`Error releasing lock for ${lockKey}:`, error);
    // Ignore errors - lock will expire naturally
  }
};

export {
  publishRequestProgress,
  connectClient,
  setFileStoreMap,
  getFileStoreMap,
  removeFromFileStoreMap,
  getAllFilesForContext,
  cleanupRedisFileStoreMap,
  cleanupRedisFileStoreMapAge,
  acquireLock,
  releaseLock,
  client,
};
