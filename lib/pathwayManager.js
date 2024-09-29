import fs from 'fs';
import { BlobServiceClient } from '@azure/storage-blob';
import AWS from 'aws-sdk';

class StorageStrategy {
  async load() { throw new Error('Not implemented'); }
  async save(data) { throw new Error('Not implemented'); }
}

class LocalStorage extends StorageStrategy {
  constructor(filePath) {
    super();
    this.filePath = filePath;
  }

  async load() {
    try {
      const data = await fs.promises.readFile(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`Error loading pathways from ${this.filePath}:`, error);
      return {};
    }
  }

  async save(data) {
    await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}

class AzureBlobStorage extends StorageStrategy {
  constructor(connectionString, containerName) {
    super();
    this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.containerClient = this.blobServiceClient.getContainerClient(containerName);
  }

  async load() {
    try {
      const blobClient = this.containerClient.getBlobClient('pathways.json');
      const downloadBlockBlobResponse = await blobClient.download();
      const data = await streamToString(downloadBlockBlobResponse.readableStreamBody);
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading pathways from Azure Blob Storage:', error);
      return {};
    }
  }

  async save(data) {
    try {
      const blobClient = this.containerClient.getBlobClient('pathways.json');
      const content = JSON.stringify(data, null, 2);
      await blobClient.upload(content, content.length);
    } catch (error) {
      console.error('Error saving pathways to Azure Blob Storage:', error);
    }
  }
}

class S3Storage extends StorageStrategy {
  constructor(config) {
    super();
    this.s3 = new AWS.S3(config);
    this.bucketName = config.bucketName;
  }

  async load() {
    try {
      const params = {
        Bucket: this.bucketName,
        Key: 'pathways.json'
      };
      const data = await this.s3.getObject(params).promise();
      return JSON.parse(data.Body.toString());
    } catch (error) {
      console.error('Error loading pathways from S3:', error);
      return {};
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
      await this.s3.putObject(params).promise();
    } catch (error) {
      console.error('Error saving pathways to S3:', error);
    }
  }
}

class PathwayManager {
  constructor(config) {
    this.storage = this.getStorageStrategy(config);
  }

  getStorageStrategy(config) {
    switch (config.storageType) {
      case 'local':
        return new LocalStorage(config.filePath);
      case 'azure':
        return new AzureBlobStorage(config.connectionString, config.containerName);
      case 's3':
        return new S3Storage(config);
      default:
        throw new Error(`Unsupported storage type: ${config.storageType}`);
    }
  }

  async loadPathways() {
    return this.storage.load();
  }

  async savePathways(pathways) {
    await this.storage.save(pathways);
  }

  async putPathway(name, pathway, userId, secret, displayName) {
    const pathways = await this.loadPathways();
    
    if (!userId || !secret) {
      throw new Error('Both userId and secret are mandatory for adding or updating a pathway');
    }
    
    // Add or update the pathway
    pathways[name] = { ...pathway, userId, secret, displayName: displayName || pathway.displayName || name };
    await this.savePathways(pathways);
  }

  async removePathway(name, userId, secret) {
    const pathways = await this.loadPathways();

    console.log("pathways", pathways);
    if (!pathways[name]) {
      throw new Error(`Pathway "${name}" does not exist`);
    }
    if (pathways[name].userId !== userId || pathways[name].secret !== secret) {
      throw new Error('Invalid userId or secret');
    }
    delete pathways[name];
    this.savePathways(pathways);
  }

  listPathways(userId, secret) {
    const pathways = this.loadPathways();
    return Object.entries(pathways)
      .filter(([_, pathway]) => pathway.userId === userId && pathway.secret === secret)
      .map(([name, _]) => name);
  }

  getTypeDefs() {
    return `#graphql
    scalar JSONObject

    input PathwayInput {
      prompt: String
      inputParameters: JSONObject
      model: String
      enableCache: Boolean
      displayName: String
    }

    type Pathway {
      name: String!
      displayName: String!
    }

    extend type Query {
      listPathways(userId: String!, secret: String!): [Pathway!]!
    }

    extend type Mutation {
      putPathway(name: String!, pathway: PathwayInput!, userId: String!, secret: String!, displayName: String): Boolean
      deletePathway(name: String!, userId: String!, secret: String!): Boolean
    }
    `;
  }

  getResolvers() {
    return {
      Query: {
        listPathways: (_, { userId, secret }) => {
          try {
            const pathways = this.loadPathways();
            return Object.entries(pathways)
              .filter(([_, pathway]) => pathway.userId === userId && pathway.secret === secret)
              .map(([name, pathway]) => ({ name, displayName: pathway.displayName || name }));
          } catch (error) {
            throw new Error(error.message);
          }
        },
      },
      Mutation: {
        putPathway: async (_, { name, pathway, userId, secret, displayName }) => {
          try {
            await this.putPathway(name, pathway, userId, secret, displayName);
            return true;
          } catch (error) {
            throw new Error(error.message);
          }
        },
        deletePathway: async (_, { name, userId, secret }) => {
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

export default PathwayManager;