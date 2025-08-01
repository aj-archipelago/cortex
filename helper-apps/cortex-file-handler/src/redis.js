import redis from "ioredis";
const connectionString = process.env["REDIS_CONNECTION_STRING"];
const client = redis.createClient(connectionString);

const channel = "requestProgress";

const connectClient = async () => {
  if (!client.connected) {
    try {
      await client.connect();
    } catch (error) {
      console.error(`Error reconnecting to Redis: ${error}`);
      return;
    }
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
    const value = await client.hget("FileStoreMap", key);
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

export {
  publishRequestProgress,
  connectClient,
  setFileStoreMap,
  getFileStoreMap,
  removeFromFileStoreMap,
  cleanupRedisFileStoreMap,
  cleanupRedisFileStoreMapAge,
};
