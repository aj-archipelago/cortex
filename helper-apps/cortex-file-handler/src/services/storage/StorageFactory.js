import { AzureStorageProvider } from "./AzureStorageProvider.js";
import { GCSStorageProvider } from "./GCSStorageProvider.js";
import { LocalStorageProvider } from "./LocalStorageProvider.js";
import path from "path";
import { fileURLToPath } from "url";

export class StorageFactory {
  constructor() {
    this.providers = new Map();
  }

  getPrimaryProvider() {
    if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
      return this.getAzureProvider();
    }
    return this.getLocalProvider();
  }

  getAzureProvider() {
    const key = "azure";
    if (!this.providers.has(key)) {
      const provider = new AzureStorageProvider(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
        process.env.AZURE_STORAGE_CONTAINER_NAME || "whispertempfiles",
      );
      this.providers.set(key, provider);
    }
    return this.providers.get(key);
  }

  getGCSProvider() {
    const key = "gcs";
    if (!this.providers.has(key)) {
      const credentials = this.parseGCSCredentials();
      if (!credentials) {
        return null;
      }
      const provider = new GCSStorageProvider(
        credentials,
        process.env.GCS_BUCKETNAME || "cortextempfiles",
      );
      this.providers.set(key, provider);
    }
    return this.providers.get(key);
  }

  getLocalProvider() {
    const key = "local";
    if (!this.providers.has(key)) {
      let folder = process.env.PUBLIC_FOLDER;
      if (!folder) {
        // Compute src/files relative to current directory
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        folder = path.join(__dirname, "..", "..", "files");
      }
      const provider = new LocalStorageProvider(folder);
      this.providers.set(key, provider);
    }
    return this.providers.get(key);
  }

  parseGCSCredentials() {
    const key =
      process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
      process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (!key) {
      return null;
    }

    try {
      if (this.isBase64(key)) {
        return JSON.parse(Buffer.from(key, "base64").toString());
      }
      return JSON.parse(key);
    } catch (error) {
      console.error("Error parsing GCS credentials:", error);
      return null;
    }
  }

  isBase64(str) {
    try {
      return btoa(atob(str)) === str;
    } catch (err) {
      return false;
    }
  }
}
