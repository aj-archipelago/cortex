import { BlobServiceClient } from '@azure/storage-blob';
import { S3 } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';
import { Prompt } from '../server/prompt.js';

class StorageStrategy {
  async load() { throw new Error('Not implemented'); }
  async save(_data) { throw new Error('Not implemented'); }
  async getLastModified() { throw new Error('Not implemented'); }
}

class LocalStorage extends StorageStrategy {
  constructor(filePath) {
    super();
    this.filePath = filePath;
  }

  async load() {
    if (!fs.existsSync(this.filePath)) {
      // create it. log
      logger.info(`Creating dynamic pathways local file: ${this.filePath}`);
      // create directory if it doesn't exist
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(this.filePath, JSON.stringify({}));
    }

    try {
      logger.info(`Loading dynamic pathways from local file: ${this.filePath}`);
      const data = await fs.promises.readFile(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      logger.error(`Error loading pathways from ${this.filePath}:`, error);
      throw error;
    }
  }

  async save(data) {
    await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }

  async getLastModified() {
    const stats = await fs.promises.stat(this.filePath);
    return stats.mtime.getTime();
  }
}

class AzureBlobStorage extends StorageStrategy {
  constructor(connectionString, containerName) {
    super();
    if (!connectionString || typeof connectionString !== 'string') {
      throw new Error('Invalid connection string');
    }
    if (!containerName || typeof containerName !== 'string') {
      throw new Error('Invalid container name');
    }

    this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.containerClient = this.blobServiceClient.getContainerClient(containerName);
  }

  async load() {
    try {
      const accountName = this.blobServiceClient.accountName;
      const containerName = this.containerClient.containerName;
      logger.info(`Loading pathways from Azure Blob Storage. Account: ${accountName}. Container: ${containerName}`);

      // if container doesn't exist, create it 
      const containerExists = await this.containerClient.exists();
      if (!containerExists) {
        logger.info('Container does not exist, creating it');
        await this.containerClient.create();
      }

      // if blob doesn't exist, create it
      const blockBlobClient = this.containerClient.getBlockBlobClient('pathways.json');
      const blobExists = await blockBlobClient.exists();
      if (!blobExists) {
        logger.info('Blob does not exist, creating it');
        const emptyContent = JSON.stringify({});
        await blockBlobClient.upload(emptyContent, emptyContent.length);
      }

      const downloadBlockBlobResponse = await blockBlobClient.download();
      const data = await streamToString(downloadBlockBlobResponse.readableStreamBody);
      const parsedData = JSON.parse(data);
      logger.info(`Loaded pathways from Azure Blob Storage. ${Object.keys(parsedData).map(user => `${user}(${Object.keys(parsedData[user])})`).join(', ')}`);
      return parsedData;
    } catch (error) {
      logger.error('Error loading pathways from Azure Blob Storage:', error);
      throw error;
    }
  }

  async save(data) {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient('pathways.json');
      const content = JSON.stringify(data, null, 2);
      await blockBlobClient.upload(content, content.length);
    } catch (error) {
      logger.error('Error saving pathways to Azure Blob Storage:', error);
    }
  }

  async getLastModified() {
    const blockBlobClient = this.containerClient.getBlockBlobClient('pathways.json');
    const properties = await blockBlobClient.getProperties();
    return new Date(properties.lastModified).getTime();
  }

  // Helper function to convert a readable stream to a string
  async streamToString(readableStream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      readableStream.on('data', (data) => {
        chunks.push(data.toString());
      });
      readableStream.on('end', () => {
        resolve(chunks.join(''));
      });
      readableStream.on('error', reject);
    });
  }
}

class S3Storage extends StorageStrategy {
  constructor(config) {
    super();
    this.s3 = new S3({
      credentials: {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey
      },
      region: config.awsRegion
    });
    this.bucketName = config.awsBucketName;
  }

  async load() {
    try {
      // Check if bucket exists, create if it doesn't
      await this.ensureBucketExists();

      // Check if file exists, create if it doesn't
      await this.ensureFileExists();

      const params = {
        Bucket: this.bucketName,
        Key: 'pathways.json'
      };
      const data = await this.s3.getObject(params);

      const readableStream = data.Body;
      const dataString = await streamToString(readableStream);
      return JSON.parse(dataString);
    } catch (error) {
      logger.error('Error loading pathways from S3:', error);
      throw error;
    }
  }

  async save(data) {
    try {
      const params = {
        Bucket: this.bucketName,
        Key: 'pathways.json',
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json'
      };
      await this.s3.putObject(params);
    } catch (error) {
      logger.error('Error saving pathways to S3:', error);
    }
  }

  async getLastModified() {
    const params = {
      Bucket: this.bucketName,
      Key: 'pathways.json'
    };
    const data = await this.s3.headObject(params);
    return new Date(data.LastModified).getTime();
  }

  async ensureBucketExists() {
    try {
      await this.s3.headBucket({ Bucket: this.bucketName });
    } catch (error) {
      if (error.name === 'NotFound') {
        logger.info(`Bucket ${this.bucketName} does not exist, creating it`);
        await this.s3.createBucket({ Bucket: this.bucketName });
      } else {
        throw error;
      }
    }
  }

  async ensureFileExists() {
    try {
      await this.s3.headObject({
        Bucket: this.bucketName,
        Key: 'pathways.json'
      });
    } catch (error) {
      if (error.name === 'NotFound') {
        logger.info('pathways.json does not exist, creating it with empty object');
        const emptyContent = JSON.stringify({});
        await this.s3.putObject({
          Bucket: this.bucketName,
          Key: 'pathways.json',
          Body: emptyContent,
          ContentType: 'application/json'
        });
      } else {
        throw error;
      }
    }
  }
}

class PathwayManager {
  constructor(config, basePathway) {
    this.storage = this.getStorageStrategy(config);
    this.publishKey = config.publishKey;
    this.pathways = {};
    this.lastUpdated = 0;
    this.basePathway = basePathway;

    if (config.storageType === 'local') {
      logger.warn('WARNING: Local file storage is being used for dynamic pathways. If there are multiple instances of Cortex, they will not be synced. Consider using cloud storage such as S3 or Azure for production environments.');
    }

    if (!this.publishKey) {
      logger.warn('WARNING: dynamicPathwaysConfig.publishKey is not set. Dynamic pathways will not be editable in this instance of Cortex.');
    }
  }

  getStorageStrategy(config) {
    switch (config.storageType) {
      case 'local':
        if (!config.filePath) {
          throw new Error('When storageType is local, filePath is required.');
        }
        return new LocalStorage(config.filePath);
      case 'azure':
        if (!config.azureStorageConnectionString || !config.azureContainerName) {
          throw new Error('When storageType is azure, azureStorageConnectionString and azureContainerName are required.');
        }
        return new AzureBlobStorage(config.azureStorageConnectionString, config.azureContainerName);
      case 's3':
        if (!config.awsAccessKeyId || !config.awsSecretAccessKey || !config.awsRegion || !config.awsBucketName) {
          throw new Error('When storageType is s3, awsAccessKeyId, awsSecretAccessKey, awsRegion, and awsBucketName are required.');
        }
        return new S3Storage(config);
      default:
        throw new Error(`Unsupported storageType: ${config.storageType}`);
    }
  }

  async initialize() {
    this.pathways = await this.loadPathways();

    return this.pathways;
  }

  async loadPathways() {
    try {
      const loadedPathwayDefinitions = await this.storage.load();
      const pathways = {};
      for (const [userId, def] of Object.entries(loadedPathwayDefinitions)) {
        pathways[userId] = {};
        for (const [key, pathway] of Object.entries(def)) {
          pathways[userId][key] = { ...this.basePathway, name: key, objName: key.charAt(0).toUpperCase() + key.slice(1), ...pathway };
        }
      }
      return pathways;
    } catch (error) {
      logger.error(`Error loading pathways: ${error.message}. Returning cached pathways last updated at ${this.lastUpdated}.`);
      this.pathways = this.pathways || {};
      return this.pathways;
    }
  }

  async savePathways(pathways) {
    await this.storage.save(pathways);
  }

  /**
   * Checks if the prompts are in legacy format (array of strings) vs new format (array of objects).
   * @param {string} userId - The user ID to look up pathways for.
   * @param {string} pathwayName - The pathway name to examine prompts from.
   * @returns {boolean} True if prompts are in legacy format (array of strings), false if new format (array of objects).
   */
  isLegacyPromptFormat(userId, pathwayName) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId must be a non-empty string');
    }
    
    if (!pathwayName || typeof pathwayName !== 'string') {
      throw new Error('pathwayName must be a non-empty string');
    }
    
    // Check if the pathway exists
    if (!this.pathways[userId] || !this.pathways[userId][pathwayName]) {
      throw new Error(`Pathway '${pathwayName}' not found for user '${userId}'`);
    }
    
    const prompts = this.pathways[userId][pathwayName].prompt;
    
    if (!Array.isArray(prompts)) {
      throw new Error('prompts must be an array');
    }
    
    if (prompts.length === 0) {
      return false; // Empty array defaults to new format
    }
    
    // Check if all items are strings (legacy format)
    const allStrings = prompts.every(prompt => typeof prompt === 'string');
    
    // Check if all items are objects with required properties (new format)
    const allObjects = prompts.every(prompt => 
      typeof prompt === 'object' && 
      prompt !== null && 
      typeof prompt.prompt === 'string'
    );
    
    if (allStrings) {
      return true; // Legacy format
    } else if (allObjects) {
      return false; // New format
    } else {
      // Mixed format - treat as legacy for backward compatibility
      return true;
    }
  }

  /**
   * Creates a Prompt object from a prompt item and system prompt.
   * @param {(string|Object)} promptItem - The prompt item (string or {name, prompt, files} object).
   * @param {string} systemPrompt - The system prompt to prepend.
   * @param {string} [defaultName] - Default name to use if promptItem is a string or if the object doesn't have a name.
   * @returns {Prompt} A new Prompt object.
   */
  _createPromptObject(promptItem, systemPrompt, defaultName = null) {
    // Handle both old format (strings) and new format (objects with name, prompt, and files)
    const promptText = typeof promptItem === 'string' ? promptItem : promptItem.prompt;
    const promptName = typeof promptItem === 'string' ? defaultName : (promptItem.name || defaultName);
    const promptFiles = typeof promptItem === 'string' ? [] : (promptItem.files || []);
    const cortexPathwayName = typeof promptItem === 'string' ? null : (promptItem.cortexPathwayName || null);
    
    const messages = [];

    // Only include system message if systemPrompt has content
    if (systemPrompt && systemPrompt.trim() !== "") {
      messages.unshift({ "role": "system", "content": systemPrompt });
    }

    // If there are files, include chatHistory to get the file content, then add user message
    if (promptFiles.length > 0) {
      // Add chatHistory which will contain the resolved file content
      messages.push("{{chatHistory}}");
      // Add the user text and prompt as a separate user message
      messages.push({ "role": "user", "content": `{{text}}\n\n${promptText}` });
    } else {
      // No files, just add the user message with text and prompt
      messages.push({ "role": "user", "content": `{{text}}\n\n${promptText}` });
    }

    const prompt = new Prompt({
      name: promptName,
      messages: messages
    });

    // Store file hashes for later resolution
    if (promptFiles.length > 0) {
      prompt.fileHashes = promptFiles;
    }

    // Preserve cortexPathwayName if present
    if (cortexPathwayName) {
      prompt.cortexPathwayName = cortexPathwayName;
    }

    return prompt;
  }

  /**
   * Transforms the prompts in a pathway to include the system prompt.
   * @param {Object} pathway - The pathway object to transform.
   * @param {(string[]|Object[])} pathway.prompt - Array of user prompts (strings) or prompt objects with {name, prompt, files} properties.
   * @param {string} pathway.systemPrompt - The system prompt to prepend to each user prompt.
   * @returns {Object} A new pathway object with transformed prompts.
   */
  async transformPrompts(pathway) {
    const { prompt, systemPrompt } = pathway;

    const newPathway = { ...pathway };

    // Transform each prompt in the array
    newPathway.prompt = prompt.map(p => this._createPromptObject(p, systemPrompt));

    // Collect all file hashes from all prompts
    const allFileHashes = newPathway.prompt
      .filter(p => p.fileHashes && p.fileHashes.length > 0)
      .flatMap(p => p.fileHashes);

    // Store file hashes at pathway level for later resolution
    if (allFileHashes.length > 0) {
      newPathway.fileHashes = [...new Set(allFileHashes)]; // Remove duplicates
    }

    return newPathway;
  }

  async putPathway(name, pathway, userId, secret, displayName) {
    if (!userId || !secret) {
      throw new Error('Both userId and secret are mandatory for adding or updating a pathway');
    }

    await this.getLatestPathways();
    this.pathways[userId] = this.pathways[userId] || {};

    if (this.pathways[userId][name] && this.pathways[userId][name].secret !== secret) {
      throw new Error('Pathway already exists and the key didn\'t match the existing secret. Please use a different name for the pathway.');
    }

    this.pathways[userId][name] = { ...pathway, secret, displayName: displayName || pathway.displayName || name };
    await this.savePathways(this.pathways);
    await this.loadPathways();
    return name;
  }

  async removePathway(name, userId, secret) {
    await this.getLatestPathways();

    if (!this.pathways[userId] || !this.pathways[userId][name]) {
      return;
    }

    if (this.pathways[userId][name].secret !== secret) {
      throw new Error('Invalid secret');
    }
    delete this.pathways[userId][name];
    if (Object.keys(this.pathways[userId]).length === 0) {
      delete this.pathways[userId];
    }

    await this.savePathways(this.pathways);
    await this.loadPathways();
  }

  getTypeDefs() {
    return `#graphql
    scalar JSONObject

    input PromptInput {
      name: String!
      prompt: String!
      files: [String!]
      cortexPathwayName: String
    }
    
    input PathwayInput {
      prompt: [PromptInput!]!
      systemPrompt: String
      inputParameters: JSONObject
      model: String
      enableCache: Boolean
      displayName: String
    }

    type Pathway {
      name: String!
      displayName: String!
    }

    type PutPathwayResult {
      name: String!
    }

    extend type Mutation {
      putPathway(name: String!, pathway: PathwayInput!, userId: String!, secret: String!, displayName: String, key: String!): PutPathwayResult!
      deletePathway(name: String!, userId: String!, secret: String!, key: String!): Boolean
    }
    `;
  }

  getResolvers() {
    return {
      Mutation: {
        putPathway: async (_, { name, pathway, userId, secret, displayName, key }) => {
          if (!this.publishKey) {
            throw new Error("Invalid configuration. Pathway publishing key is not configured in Cortex.")
          }

          if (key !== this.publishKey) {
            throw new Error('Invalid pathway publishing key. The key provided did not match the key configured in Cortex.');
          }

          try {
            const finalName = await this.putPathway(name, pathway, userId, secret, displayName);
            return { name: finalName };  // Return an object with the final name
          } catch (error) {
            throw new Error(error.message);
          }
        },
        deletePathway: async (_, { name, userId, secret, key }) => {
          if (!this.publishKey) {
            throw new Error("Invalid configuration. Pathway publishing key is not configured in Cortex.")
          }
          if (key !== this.publishKey) {
            throw new Error('Invalid pathway publishing key. The key provided did not match the key configured in Cortex.');
          }

          try {
            await this.removePathway(name, userId, secret);
            return true;
          } catch (error) {
            throw new Error(error.message);
          }
        },
      },
    };
  }

  async getLatestPathways() {
    try {
      const currentTimestamp = await this.storage.getLastModified();

      if (currentTimestamp > this.lastUpdated) {
        logger.info('Pathways have been modified, updating local cache');
        this.pathways = await this.loadPathways();
        this.lastUpdated = currentTimestamp;
      }

      return this.pathways;
    } catch (error) {
      logger.error('Error in getLatestPathways:', error);
      throw error;
    }
  }

  async getPathway(userId, pathwayName) {
    const pathways = await this.getLatestPathways();

    if (!pathways[userId] || !pathways[userId][pathwayName]) {
      throw new Error(`Pathway '${pathwayName}' not found for user '${userId}'`);
    }

    return this.transformPrompts(pathways[userId][pathwayName]);
  }

  /**
   * Returns n pathways, one for each prompt in the provided prompt array.
   * Each pathway will contain a single prompt from the array.
   * @param {Object} pathwayTemplate - The base pathway template to use for each generated pathway.
   * @param {(string[]|Object[])} pathwayTemplate.prompt - Array of user prompts (strings) or prompt objects with {name, prompt} properties.
   * @param {string} pathwayTemplate.systemPrompt - The system prompt to use for each pathway.
   * @param {string[]} [promptNames] - Optional array of prompt names to filter by. If provided, only prompts with names in this list will be included.
   * @returns {Object[]} Array of pathway objects, each containing a single prompt.
   */
  async getPathways(pathwayTemplate, promptNames = null) {
    const { prompt, systemPrompt, ...otherProps } = pathwayTemplate;

    if (!Array.isArray(prompt)) {
      throw new Error('pathwayTemplate.prompt must be an array');
    }

    if (promptNames && !Array.isArray(promptNames)) {
      throw new Error('promptNames must be an array if provided');
    }

    // Use a Map to track prompt names without modifying pathway objects
    const pathwayNameMap = new Map();
    
    // Create a pathway for each prompt in the array
    const pathways = prompt.map((p, index) => {
      // Handle both old format (strings) and new format (objects with name and prompt)
      const promptName = typeof p === 'string' ? `prompt_${index}` : (p.name || `prompt_${index}`);
      
      // Create a new pathway with a single prompt using the shared helper method
      const singlePromptPathway = {
        ...otherProps,
        name: promptName,
        systemPrompt: systemPrompt || "",
        prompt: [this._createPromptObject(p, systemPrompt, promptName)]
      };

      // Map the pathway object to its prompt name for filtering
      pathwayNameMap.set(singlePromptPathway, promptName);

      return singlePromptPathway;
    });

    // Filter by promptNames if provided
    if (promptNames && promptNames.length > 0) {
      const promptNamesSet = new Set(promptNames);
      return pathways.filter(pathway => {
        const promptName = pathwayNameMap.get(pathway);
        return promptNamesSet.has(promptName);
      });
    }

    return pathways;
  }

}

// Helper function to convert a readable stream to a string
async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data.toString());
    });
    readableStream.on('end', () => {
      resolve(chunks.join(''));
    });
    readableStream.on('error', reject);
  });
}
export default PathwayManager;
