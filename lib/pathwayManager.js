import fs from 'fs';
import { BlobServiceClient } from '@azure/storage-blob';
import AWS from 'aws-sdk';
import pkg from '@azure/eventgrid';
const { EventGridClient } = pkg;

class StorageStrategy {
  async load() { throw new Error('Not implemented'); }
  async save(data) { throw new Error('Not implemented'); }
  watch(callback) { throw new Error('Not implemented'); }
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

  watch(callback) {
    fs.watch(this.filePath, (eventType) => {
      if (eventType === 'change') {
        this.load().then(callback);
      }
    });
  }
}

class AzureBlobStorage extends StorageStrategy {
  constructor(connectionString, containerName) {
    super();
    this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.containerClient = this.blobServiceClient.getContainerClient(containerName);
    this.eventGridClient = new EventGridClient(/* Event Grid credentials */);
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

  watch(callback) {
    // Subscribe to Azure Event Grid for blob changes
    this.eventGridClient.subscribe(
      /* Event Grid topic endpoint */
      {
        filter: {
          includedEventTypes: ['Microsoft.Storage.BlobCreated', 'Microsoft.Storage.BlobDeleted']
        }
      },
      async (event) => {
        if (event.data.url.endsWith('pathways.json')) {
          const newData = await this.load();
          callback(newData);
        }
      }
    );
  }
}

class S3Storage extends StorageStrategy {
  constructor(config) {
    super();
    this.s3 = new AWS.S3(config);
    this.sns = new AWS.SNS(config);
    this.bucketName = config.bucketName;
    this.topicArn = config.topicArn;
    this.endpointUrl = config.endpointUrl; // Add this line
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

  watch(callback) {
    // Set up S3 event notification to SNS
    const params = {
      Bucket: this.bucketName,
      NotificationConfiguration: {
        TopicConfigurations: [
          {
            Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
            TopicArn: this.topicArn // Use the ARN here
          }
        ]
      }
    };
    this.s3.putBucketNotification(params).promise();

    // Subscribe to SNS topic
    this.sns.subscribe({
      Protocol: 'https',
      TopicArn: this.topicArn,
      Endpoint: this.endpointUrl // Use the endpoint URL here
    }).promise();

    // In your HTTPS endpoint handler:
    // async function handleSNSNotification(message) {
    //   if (message.Records[0].s3.object.key === 'pathways.json') {
    //     const newData = await this.load();
    //     callback(newData);
    //   }
    // }
  }
}

class PathwayManager {
  constructor(config) {
    this.storage = this.getStorageStrategy(config);
    this.pathways = {};
    this.initializeWatcher();
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

  async initializeWatcher() {
    this.pathways = await this.loadPathways();
    this.storage.watch((newData) => {
      this.pathways = newData;
    });
  }

  async loadPathways() {
    return this.storage.load();
  }

  async savePathways(pathways) {
    await this.storage.save(pathways);
  }

  async putPathway(name, pathway, userId, secret, displayName) {
    if (!userId || !secret) {
      throw new Error('Both userId and secret are mandatory for adding or updating a pathway');
    }

    this.pathways[userId] = this.pathways[userId] || {};

    if (this.pathways[userId][name] && this.pathways[userId][name].secret !== secret) {
      throw new Error('Pathway already exists and the key didn\'t match the existing secret. Please use a different name.');
    }

    this.pathways[userId][name] = { ...pathway, secret, displayName: displayName || pathway.displayName || name };
    await this.savePathways(this.pathways);
    return name;  // Return the final name used
  }

  async removePathway(name, userId, secret) {
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
  }

  listPathways(userId, secret) {
    if (!this.pathways[userId]) {
      return [];
    }
    return Object.entries(this.pathways[userId])
      .filter(([_, pathway]) => pathway.secret === secret)
      .map(([name, _]) => name);
  }

  getTypeDefs() {
    return `#graphql
    scalar JSONObject

    
    input PathwayInput {
      prompt: [String!]!
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

    extend type Query {
      listPathways(userId: String!, secret: String!): [Pathway!]!
    }

    extend type Mutation {
      putPathway(name: String!, pathway: PathwayInput!, userId: String!, secret: String!, displayName: String): PutPathwayResult!
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
            if (!pathways[userId]) {
              return [];
            }
            return Object.entries(pathways[userId])
              .filter(([_, pathway]) => pathway.secret === secret)
              .map(([name, pathway]) => ({ name, displayName: pathway.displayName || name }));
          } catch (error) {
            throw new Error(error.message);
          }
        },
      },
      Mutation: {
        putPathway: async (_, { name, pathway, userId, secret, displayName }) => {
          try {
            const finalName = await this.putPathway(name, pathway, userId, secret, displayName);
            return { name: finalName };  // Return an object with the final name
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