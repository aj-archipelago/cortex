import Redis from "ioredis";

const connectionString = process.env["REDIS_CONNECTION_STRING"];

/**
 * Get hash key for Redis storage
 * No scoping needed - single container only
 * @param {string} hash - The file hash
 * @returns {string} The hash key (just the hash itself)
 */
export const getScopedHashKey = (hash) => {
  // No scoping - just return the hash directly
  return hash;
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
const setFileStoreMap = async (key, value) => {
  try {
    // Only set timestamp if one doesn't already exist
    if (!value.timestamp) {
      value.timestamp = new Date().toISOString();
    }
    await client.hset("FileStoreMap", key, JSON.stringify(value));
  } catch (error) {
    console.error(`Error setting key in FileStoreMap: ${error}`);
  }
};

const getFileStoreMap = async (key, skipLazyCleanup = false) => {
  try {
    let value = await client.hget("FileStoreMap", key);
    
    // Backwards compatibility: if not found and key is for default container, try legacy key
    if (!value && key && key.includes(':')) {
      const [hash, containerName] = key.split(':', 2);
      const defaultContainerName = getDefaultContainerName();
      
      // If this is the default container, try the legacy key (hash without container)
      if (containerName === defaultContainerName) {
        console.log(`Key ${key} not found, trying legacy key ${hash} for backwards compatibility`);
        value = await client.hget("FileStoreMap", hash);
        
        // If found with legacy key, migrate it to the new scoped key
        if (value) {
          console.log(`Found value with legacy key ${hash}, migrating to new key ${key}`);
          await client.hset("FileStoreMap", key, value);
          // Optionally remove the old key after migration
          // await client.hdel("FileStoreMap", hash);
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

            // Check primary storage
            if (parsedValue?.url) {
              const exists = await storageService.fileExists(parsedValue.url);
              if (!exists) {
                console.log(
                  `Lazy cleanup: Primary storage file missing for key ${key}: ${parsedValue.url}`,
                );
                shouldRemove = true;
              }
            }

            // Check GCS backup if primary is missing
            if (
              shouldRemove &&
              parsedValue?.gcs &&
              storageService.backupProvider
            ) {
              const gcsExists = await storageService.fileExists(
                parsedValue.gcs,
              );
              if (gcsExists) {
                // GCS backup exists, so don't remove the entry
                shouldRemove = false;
                console.log(
                  `Lazy cleanup: GCS backup found for key ${key}, keeping entry`,
                );
              }
            }

            // Remove stale entry if both primary and backup are missing
            if (shouldRemove) {
              await removeFromFileStoreMap(key);
              console.log(
                `Lazy cleanup: Removed stale cache entry for key ${key}`,
              );
              return null; // Return null since file no longer exists
            }
          } catch (error) {
            console.log(`Lazy cleanup error for key ${key}: ${error.message}`);
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
const removeFromFileStoreMap = async (key) => {
  try {
    // hdel returns the number of keys that were removed.
    // If the key does not exist, 0 is returned.
    const result = await client.hdel("FileStoreMap", key);
    if (result === 0) {
      console.log(`The key ${key} does not exist`);
    } else {
      console.log(`The key ${key} was removed successfully`);
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
    const entries = Object.entries(map)
      .filter(([_, value]) => value?.timestamp) // Only entries with timestamps
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
  cleanupRedisFileStoreMap,
  cleanupRedisFileStoreMapAge,
  acquireLock,
  releaseLock,
  client,
};
