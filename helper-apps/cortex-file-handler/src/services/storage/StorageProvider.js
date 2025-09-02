/**
 * Base interface for storage providers
 */
export class StorageProvider {
  /**
   * Upload a file to storage
   * @param {Object} context - The context object
   * @param {string} filePath - Path to the file to upload
   * @param {string} requestId - Unique identifier for the request
   * @param {string} [hash] - Optional hash of the file
   * @param {string} [filename] - Optional filename to use (if not provided, provider will generate one)
   * @returns {Promise<{url: string, blobName: string}>} The URL and blob name of the uploaded file
   */
  async uploadFile(context, filePath, requestId, hash = null, filename = null) {
    throw new Error("Method not implemented");
  }

  /**
   * Delete files associated with a request ID
   * @param {string} requestId - The request ID to delete files for
   * @returns {Promise<string[]>} Array of deleted file URLs
   */
  async deleteFiles(requestId) {
    throw new Error("Method not implemented");
  }

  /**
   * Delete a single file by its URL
   * @param {string} url - The URL of the file to delete
   * @returns {Promise<string|null>} The deleted file path/name or null if not found
   */
  async deleteFile(url) {
    throw new Error("Method not implemented");
  }

  /**
   * Check if a file exists at the given URL
   * @param {string} url - The URL to check
   * @returns {Promise<boolean>} Whether the file exists
   */
  async fileExists(url) {
    throw new Error("Method not implemented");
  }

  /**
   * Download a file from storage
   * @param {string} url - The URL of the file to download
   * @param {string} destinationPath - Where to save the downloaded file
   * @returns {Promise<void>}
   */
  async downloadFile(url, destinationPath) {
    throw new Error("Method not implemented");
  }

  /**
   * Clean up files by their URLs
   * @param {string[]} urls - Array of URLs to clean up
   * @returns {Promise<void>}
   */
  async cleanup(urls) {
    throw new Error("Method not implemented");
  }
}
