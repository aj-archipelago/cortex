import fs from "fs";
import path from "path";
import { BlobServiceClient } from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import { PassThrough } from "stream";
import { pipeline as _pipeline } from "stream";
import { promisify } from "util";
const pipeline = promisify(_pipeline);
import { join } from "path";
import { Storage } from "@google-cloud/storage";
import axios from "axios";

const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.svg'
];

const VIDEO_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.ogg',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
  '.mkv',
];

function isBase64(str) {
  try {
      return btoa(atob(str)) == str;
  } catch (err) {
      return false;
  }
}

const GCP_SERVICE_ACCOUNT_KEY = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 || process.env.GCP_SERVICE_ACCOUNT_KEY || "{}";
const GCP_SERVICE_ACCOUNT = isBase64(GCP_SERVICE_ACCOUNT_KEY) ? JSON.parse(Buffer.from(GCP_SERVICE_ACCOUNT_KEY, 'base64').toString()) : JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
const { project_id: GCP_PROJECT_ID } = GCP_SERVICE_ACCOUNT;

let gcs;
if (!GCP_PROJECT_ID || !GCP_SERVICE_ACCOUNT) {
  console.warn(
    "Google Cloud Project ID or Service Account details are missing"
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
      "Provided Google Cloud Service Account details are invalid: ",
      error
    );
  }
}

import { publicFolder, port, ipAddress } from "./start.js";

const getBlobClient = () => {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
  if (!connectionString || !containerName) {
    throw new Error(
      "Missing Azure Storage connection string or container name environment variable"
    );
  }

  const blobServiceClient =
    BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  return { blobServiceClient, containerClient };
};

async function saveFileToBlob(chunkPath, requestId) {
  const { containerClient } = getBlobClient();
  // Use the filename with a UUID as the blob name
  const blobName = `${requestId}/${uuidv4()}_${path.basename(chunkPath)}`;

  // Create a read stream for the chunk file
  const fileStream = fs.createReadStream(chunkPath);

  // Upload the chunk to Azure Blob Storage using the stream
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadStream(fileStream);

  // Return the full URI of the uploaded blob
  const blobUrl = blockBlobClient.url;
  return blobUrl;
}

//deletes blob that has the requestId
async function deleteBlob(requestId) {
  if (!requestId) throw new Error("Missing requestId parameter");
  const { containerClient } = getBlobClient();
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

async function uploadBlob(
  context,
  req,
  saveToLocal = false,
  useGoogle = false
) {
  return new Promise((resolve, reject) => {
    try {
      const busboy = Busboy({ headers: req.headers });
      let requestId = uuidv4();
      let body = {};

      busboy.on("field", (fieldname, value) => {
        if (fieldname === "requestId") {
          requestId = value;
        } else if (fieldname === "useGoogle") {
          useGoogle = value;
        }
      });

      busboy.on("file", async (fieldname, file, info) => {
        //set useGoogle if file is image or video
        const ext = path.extname(info.filename).toLowerCase();
        if (IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)) {
          useGoogle = true;
        }

        if(useGoogle && useGoogle !== "false" && !gcs) {
          context.log.warn("Google Cloud Storage is not initialized reverting google upload ");
          useGoogle = false;
        }

        if (saveToLocal) {
          // Create the target folder if it doesn't exist
          const localPath = join(publicFolder, requestId);
          fs.mkdirSync(localPath, { recursive: true });

          const filename = `${uuidv4()}_${info.filename}`;
          const destinationPath = `${localPath}/${filename}`;

          await pipeline(file, fs.createWriteStream(destinationPath));

          const message = `File '${filename}' saved to folder successfully.`;
          context.log(message);

          const url = `http://${ipAddress}:${port}/files/${requestId}/${filename}`;

          body = { message, url };

          resolve(body); // Resolve the promise
        } else {
          const filename = `${requestId}/${uuidv4()}_${info.filename}`;
          const { containerClient } = getBlobClient();

          const blockBlobClient = containerClient.getBlockBlobClient(filename);

          const passThroughStream = new PassThrough();
          file.pipe(passThroughStream);

          await blockBlobClient.uploadStream(passThroughStream);

          const message = `File '${filename}' uploaded successfully.`;
          const url = blockBlobClient.url;
          context.log(message);
          body = { message, url };
        }

        context.res = {
          status: 200,
          body,
        };

        if (useGoogle && useGoogle !== "false") {
          const { url } = body;
          const bucketName = "cortextempfiles";
          const filename = `${requestId}/${uuidv4()}_${info.filename}`;
          const gcsFile = gcs.bucket(bucketName).file(filename);
          const writeStream = gcsFile.createWriteStream();

          const response = await axios({
            method: "get",
            url: url,
            responseType: "stream",
          });

          // Pipe the Axios response stream directly into the GCS Write Stream
          response.data.pipe(writeStream);

          await new Promise((resolve, reject) => {
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
          });

          body.gcs = `gs://${bucketName}/${filename}`;
        }

        resolve(body); // Resolve the promise
      });

      busboy.on("error", (error) => {
        context.log.error("Error processing file upload:", error);
        context.res = {
          status: 500,
          body: "Error processing file upload.",
        };
        reject(error); // Reject the promise
      });

      req.pipe(busboy);
    } catch (error) {
      context.log.error("Error processing file upload:", error);
      context.res = {
        status: 500,
        body: "Error processing file upload.",
      };
      reject(error); // Reject the promise
    }
  });
}

// Function to delete files that haven't been used in more than a month
async function cleanup() {
  const { containerClient } = getBlobClient();

  // List all the blobs in the container
  const blobs = containerClient.listBlobsFlat();

  // Calculate the date that is x month ago
  const xMonthAgo = new Date();
  xMonthAgo.setMonth(xMonthAgo.getMonth() - 1);

  // Iterate through the blobs
  for await (const blob of blobs) {
    // Get the last modified date of the blob
    const lastModified = blob.properties.lastModified;

    // Compare the last modified date with one month ago
    if (lastModified < xMonthAgo) {
      // Delete the blob
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.delete();
      console.log(`Cleaned blob: ${blob.name}`);
    }
  }
}

export { saveFileToBlob, deleteBlob, uploadBlob, cleanup };
