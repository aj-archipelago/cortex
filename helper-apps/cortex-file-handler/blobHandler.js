import fs from "fs";
import path from "path";
import { generateBlobSASQueryParameters, StorageSharedKeyCredential, BlobServiceClient } from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import { PassThrough } from "stream";
import { pipeline as _pipeline } from "stream";
import { promisify } from "util";
const pipeline = promisify(_pipeline);
import { join } from "path";
import { Storage } from "@google-cloud/storage";
import axios from "axios";
import { publicFolder, port, ipAddress } from "./start.js";
import mime from "mime-types";

function isBase64(str) {
  try {
    return btoa(atob(str)) == str;
  } catch (err) {
    return false;
  }
}

const { SAS_TOKEN_LIFE_DAYS = 30 } = process.env;
const GCP_SERVICE_ACCOUNT_KEY =
  process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
  process.env.GCP_SERVICE_ACCOUNT_KEY ||
  "{}";
const GCP_SERVICE_ACCOUNT = isBase64(GCP_SERVICE_ACCOUNT_KEY)
  ? JSON.parse(Buffer.from(GCP_SERVICE_ACCOUNT_KEY, "base64").toString())
  : JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
const { project_id: GCP_PROJECT_ID } = GCP_SERVICE_ACCOUNT;

let gcs;
if (!GCP_PROJECT_ID || !GCP_SERVICE_ACCOUNT) {
  console.warn(
    "No Google Cloud Storage credentials provided - GCS will not be used"
  );
} else {
  try {
    gcs = new Storage({
      projectId: GCP_PROJECT_ID,
      credentials: GCP_SERVICE_ACCOUNT,
    });

    // Rest of your Google Cloud operations using gcs object
  } catch (error) {
    console.error(
      "Google Cloud Storage credentials are invalid - GCS will not be used: ",
      error
    );
  }
}

const GCS_BUCKETNAME = process.env.GCS_BUCKETNAME || "cortextempfiles";

async function gcsUrlExists(url, defaultReturn = false) {
    try {
        if(!url || !gcs) {
            return defaultReturn; // Cannot check return
        }

        const urlParts = url.replace('gs://', '').split('/');
        const bucketName = urlParts[0];
        const fileName = urlParts.slice(1).join('/');

        const bucket = gcs.bucket(bucketName);
        const file = bucket.file(fileName);

        const [exists] = await file.exists();
        
        return exists;
    } catch (error) {
        console.error('Error checking if GCS URL exists:', error);
        return false;
    }
}

const getBlobClient = async () => {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
  if (!connectionString || !containerName) {
    throw new Error(
      "Missing Azure Storage connection string or container name environment variable"
    );
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

  const serviceProperties = await blobServiceClient.getProperties();
  if(!serviceProperties.defaultServiceVersion) {
    serviceProperties.defaultServiceVersion = '2020-02-10';
    await blobServiceClient.setProperties(serviceProperties);
  }

  const containerClient = blobServiceClient.getContainerClient(containerName);

  return { blobServiceClient, containerClient };
};

async function saveFileToBlob(chunkPath, requestId) {
  const { containerClient } = await getBlobClient();
  // Use the filename with a UUID as the blob name
  const blobName = `${requestId}/${uuidv4()}_${encodeURIComponent(path.basename(chunkPath))}`;
  const sasToken = generateSASToken(containerClient, blobName);

  // Create a read stream for the chunk file
  const fileStream = fs.createReadStream(chunkPath);

  // Upload the chunk to Azure Blob Storage using the stream
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadStream(fileStream);

  // Return the full URI of the uploaded blob
  const blobUrl = `${blockBlobClient.url}?${sasToken}`;
  return blobUrl;
}

const generateSASToken = (containerClient, blobName, expiryTimeSeconds = 
    parseInt(SAS_TOKEN_LIFE_DAYS) * 24 * 60 * 60
) => {
  const { accountName, accountKey } = containerClient.credential;
  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

  const sasOptions = {
    containerName: containerClient.containerName,
    blobName: blobName,
    permissions: "r", // Read permission
    startsOn: new Date(),
    expiresOn: new Date(new Date().valueOf() + expiryTimeSeconds * 1000)
  };

  const sasToken = generateBlobSASQueryParameters(sasOptions, sharedKeyCredential).toString();
  return sasToken;
};

//deletes blob that has the requestId
async function deleteBlob(requestId) {
  if (!requestId) throw new Error("Missing requestId parameter");
  const { containerClient } = await getBlobClient();
  // List the blobs in the container with the specified prefix
  const blobs = containerClient.listBlobsFlat({ prefix: `${requestId}/` });

  const result = [];
  // Iterate through the blobs
  for await (const blob of blobs) {
    // Delete the matching blob
    const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
    await blockBlobClient.delete();
    console.log(`Cleaned blob: ${blob.name}`);
    result.push(blob.name);
  }

  return result;
}

async function uploadBlob(context, req, saveToLocal = false, filePath=null, hash=null) {
  return new Promise(async (resolve, reject) => {
    try {
      let requestId = uuidv4();
      let body = {};

      // If filePath is given, we are dealing with local file and not form-data
      if (filePath) {
        const file = fs.createReadStream(filePath);
        const filename = path.basename(filePath);
        try {
          const result = await uploadFile(context, requestId, body, saveToLocal, file, filename, resolve, hash);
          resolve(result);
        } catch (error) {
          context.res = {
            status: 500,
            body: "Error processing file upload."
          };
          reject(error);
        }
      } else {
        // Otherwise, continue working with form-data
        const busboy = Busboy({ headers: req.headers });
      
        busboy.on("field", (fieldname, value) => {
          if (fieldname === "requestId") {
            requestId = value;
          }
        });

        busboy.on("file", async (fieldname, file, filename) => {
          uploadFile(context, requestId, body, saveToLocal, file, filename?.filename || filename, resolve, hash).catch(error => {
            context.res = {
              status: 500,
              body: "Error processing file upload."
            };
            reject(error);
          });
        });

        busboy.on("error", (error) => {
          context.log("Error processing file upload:", error);
          context.res = {
            status: 500,
            body: "Error processing file upload."
          };
          reject(error);
        });

        req.pipe(busboy);
      }
    } catch (error) {
      context.log("Error processing file upload:", error);
      context.res = {
        status: 500,
        body: "Error processing file upload."
      };
      reject(error);
    }
  });
}

// Helper function to handle local file storage
async function saveToLocalStorage(context, requestId, encodedFilename, file) {
  const localPath = join(publicFolder, requestId);
  fs.mkdirSync(localPath, { recursive: true });
  const destinationPath = `${localPath}/${encodedFilename}`;
  context.log(`Saving to local storage... ${destinationPath}`);
  await pipeline(file, fs.createWriteStream(destinationPath));
  return `http://${ipAddress}:${port}/files/${requestId}/${encodedFilename}`;
}

// Helper function to handle Azure blob storage
async function saveToAzureStorage(context, encodedFilename, file) {
  const { containerClient } = await getBlobClient();
  const contentType = mime.lookup(encodedFilename);
  const options = contentType ? { blobHTTPHeaders: { blobContentType: contentType } } : {};
  
  const blockBlobClient = containerClient.getBlockBlobClient(encodedFilename);
  const passThroughStream = new PassThrough();
  file.pipe(passThroughStream);
  
  context.log(`Uploading to Azure... ${encodedFilename}`);
  await blockBlobClient.uploadStream(passThroughStream, undefined, undefined, options);
  const sasToken = generateSASToken(containerClient, encodedFilename);
  return `${blockBlobClient.url}?${sasToken}`;
}

// Helper function to upload a file to Google Cloud Storage
async function uploadToGCS(context, sourceUrl, encodedFilename) {
  const gcsFile = gcs.bucket(GCS_BUCKETNAME).file(encodedFilename);
  const writeStream = gcsFile.createWriteStream();
  
  const response = await axios({
    method: "get",
    url: sourceUrl,
    responseType: "stream",
  });
  
  context.log(`Uploading to GCS... ${encodedFilename}`);
  response.data.pipe(writeStream);
  
  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  return `gs://${GCS_BUCKETNAME}/${encodedFilename}`;
}

// Helper function to handle Google Cloud Storage
async function saveToGoogleStorage(context, encodedFilename, azureUrl) {
  if (!gcs) {
    throw new Error('Google Cloud Storage is not initialized');
  }

  return uploadToGCS(context, azureUrl, encodedFilename);
}

async function uploadFile(context, requestId, body, saveToLocal, file, filename, resolve, hash = null) {
  try {
    const encodedFilename = encodeURIComponent(`${requestId || uuidv4()}_${filename}`);
    
    // Set up storage promises
    const storagePromises = [];
    const primaryPromise = saveToLocal 
      ? saveToLocalStorage(context, requestId, encodedFilename, file)
      : saveToAzureStorage(context, encodedFilename, file);
    
    storagePromises.push(primaryPromise.then(url => ({ url, type: 'primary' })));

    // Add GCS promise if configured
    if (gcs) {
      // We need to wait for the primary URL to upload to GCS
      storagePromises.push(
        primaryPromise.then(url => 
          saveToGoogleStorage(context, encodedFilename, url)
            .then(gcsUrl => ({ gcs: gcsUrl, type: 'gcs' }))
        )
      );
    }

    // Wait for all storage operations to complete
    const results = await Promise.all(storagePromises);
    
    // Combine results
    body = {
      message: `File '${encodedFilename}' ${saveToLocal ? 'saved to folder' : 'uploaded'} successfully.`,
      filename,
      ...results.reduce((acc, result) => {
        if (result.type === 'primary') acc.url = result.url;
        if (result.type === 'gcs') acc.gcs = result.gcs;
        return acc;
      }, {})
    };

    if (hash) {
      body.hash = hash;
    }

    // Set response
    context.res = {
      status: 200,
      body,
    };

    resolve(body);
  } catch (error) {
    context.log("Error in uploadFile:", error);
    // If we have a URL but GCS failed, clean it up
    if (body.url) {
      try {
        await cleanup(context, [body.url]);
      } catch (cleanupError) {
        context.log("Error during cleanup after failure:", cleanupError);
      }
    }
    throw error;
  }
}

// Function to delete files that haven't been used in more than a month
async function cleanup(context, urls=null) {
  const { containerClient } = await getBlobClient();
  const cleanedURLs = [];

  if(!urls) {
    const xMonthAgo = new Date();
    xMonthAgo.setMonth(xMonthAgo.getMonth() - 1);

    const blobs = containerClient.listBlobsFlat();
    
    for await (const blob of blobs) {
      const lastModified = blob.properties.lastModified;
      if (lastModified < xMonthAgo) {
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          await blockBlobClient.delete();
          context.log(`Cleaned blob: ${blob.name}`);
          cleanedURLs.push(blob.name);
        } catch (error) {
          if (error.statusCode !== 404) { // Ignore "not found" errors
            context.log(`Error cleaning blob ${blob.name}:`, error);
          }
        }
      }
    }
  } else {
    for(const url of urls) {
      try {
        const blobName = url.replace(containerClient.url, '');
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.delete();
        context.log(`Cleaned blob: ${blobName}`);
        cleanedURLs.push(blobName);
      } catch (error) {
        if (error.statusCode !== 404) { // Ignore "not found" errors
          context.log(`Error cleaning blob ${url}:`, error);
        }
      }
    }
  }
  return cleanedURLs;
}

async function cleanupGCS(urls=null) {
  const bucket = gcs.bucket(GCS_BUCKETNAME);
  const directories = new Set();
  const cleanedURLs = [];

  if(!urls){
    const daysN = 30;
    const thirtyDaysAgo = new Date(Date.now() - daysN * 24 * 60 * 60 * 1000);
    const [files] = await bucket.getFiles();

    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const directoryPath = path.dirname(file.name);
      directories.add(directoryPath);
      if (metadata.updated) {
        const updatedTime = new Date(metadata.updated);
        if (updatedTime.getTime() < thirtyDaysAgo.getTime()) {
          console.log(`Cleaning file: ${file.name}`);
          await file.delete();
          cleanedURLs.push(file.name);
        }
      }
    }
  }else{
    try {
      for(const url of urls) {
        const filename = path.join(url.split('/').slice(3).join('/'));
        const file = bucket.file(filename);
        const directoryPath = path.dirname(file.name);
        directories.add(directoryPath);
        await file.delete();
        cleanedURLs.push(url);
      }
    }catch(error){
      console.error(`Error cleaning up files: ${error}`);
    }
  }

  for (const directory of directories) {
    const [files] = await bucket.getFiles({ prefix: directory });
    if (files.length === 0) {
      console.log(`Deleting empty directory: ${directory}`);
      await bucket.deleteFiles({ prefix: directory });
    }
  }

  return cleanedURLs;
}

// Helper function to ensure GCS upload for existing files
async function ensureGCSUpload(context, existingFile) {
  if (!existingFile.gcs && gcs) {
    context.log(`GCS file was missing - uploading.`);
    const encodedFilename = path.basename(existingFile.url.split('?')[0]);
    existingFile.gcs = await uploadToGCS(context, existingFile.url, encodedFilename);
  }
  return existingFile;
}

export { saveFileToBlob, deleteBlob, uploadBlob, cleanup, cleanupGCS, gcsUrlExists, ensureGCSUpload, gcs };
