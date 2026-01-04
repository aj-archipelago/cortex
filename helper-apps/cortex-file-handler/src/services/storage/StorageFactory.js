import { AzureStorageProvider } from "./AzureStorageProvider.js";
import { GCSStorageProvider } from "./GCSStorageProvider.js";
import { LocalStorageProvider } from "./LocalStorageProvider.js";
import { getContainerName, GCS_BUCKETNAME } from "../../constants.js";
import path from "path";
import { fileURLToPath } from "url";

// Singleton instance for provider caching across the application
let storageFactoryInstance = null;

export class StorageFactory {
  constructor() {
    this.providers = new Map();
  }

  /**
   * Get the singleton instance of StorageFactory
   * This ensures provider caching works across the entire application
   */
  static getInstance() {
    if (!storageFactoryInstance) {
      storageFactoryInstance = new StorageFactory();
    }
    return storageFactoryInstance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   * @internal
   */
  static resetInstance() {
    storageFactoryInstance = null;
  }

  async getPrimaryProvider() {
    if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
      return await this.getAzureProvider();
    }
    return this.getLocalProvider();
  }

  async getAzureProvider() {
    // Always use single container from env var
    const containerName = getContainerName();
    
    // Create unique key for caching
    const key = `azure-${containerName}`;
    if (!this.providers.has(key)) {
      const provider = new AzureStorageProvider(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
        containerName,
      );
      this.providers.set(key, provider);
    }
    return this.providers.get(key);
  }

  getGCSProvider() {
    const key = "gcs";
    if (!this.providers.has(key)) {
      const config = this.parseGCSConfig();
      if (!config) {
        return null;
      }
      const provider = new GCSStorageProvider(
        config.credentials,
        config.projectId,
        GCS_BUCKETNAME,
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

  parseGCSConfig() {
    // Support service account impersonation (recommended)
    const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    const projectId = process.env.GCP_PROJECT_ID;
    
    if (serviceAccountEmail) {
      // Using impersonation - extract project ID from email if not provided
      const extractedProjectId = projectId || this.extractProjectIdFromEmail(serviceAccountEmail);
      if (!extractedProjectId) {
        console.error("GCP_PROJECT_ID is required when using GCP_SERVICE_ACCOUNT_EMAIL");
        return null;
      }
      // Return null credentials to use ADC (Application Default Credentials)
      return { credentials: null, projectId: extractedProjectId };
    }
    
    // Fall back to service account key (legacy)
    const key =
      process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
      process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (!key) {
      return null;
    }

    try {
      let credentials;
      if (this.isBase64(key)) {
        credentials = JSON.parse(Buffer.from(key, "base64").toString());
      } else {
        credentials = JSON.parse(key);
      }
      return {
        credentials: credentials,
        projectId: credentials.project_id || projectId,
      };
    } catch (error) {
      console.error("Error parsing GCS credentials:", error);
      return null;
    }
  }

  extractProjectIdFromEmail(email) {
    // Service account email format: name@project-id.iam.gserviceaccount.com
    const match = email.match(/@([^.]+)\.iam\.gserviceaccount\.com$/);
    return match ? match[1] : null;
  }

  isBase64(str) {
    try {
      return btoa(atob(str)) === str;
    } catch (err) {
      return false;
    }
  }
}
