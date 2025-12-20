import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import test from "ava";
import axios from "axios";

import {
  uploadBlob,
  ensureGCSUpload,
  gcsUrlExists,
  deleteGCS,
  getBlobClient,
  AZURE_STORAGE_CONTAINER_NAME,
  getDefaultContainerName,
} from "../src/blobHandler.js";
import { urlExists } from "../src/helper.js";
import CortexFileHandler from "../src/index.js";
import { setFileStoreMap } from "../src/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to determine if GCS is configured
function isGCSConfigured() {
  return (
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
    process.env.GCP_SERVICE_ACCOUNT_KEY
  );
}

// Helper function to check file size in GCS
async function getGCSFileSize(gcsUrl) {
  if (!isGCSConfigured()) return null;
  try {
    const bucket = gcsUrl.split("/")[2];
    const filename = gcsUrl.split("/").slice(3).join("/");

    if (process.env.STORAGE_EMULATOR_HOST) {
      const response = await axios.get(
        `${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${bucket}/o/${encodeURIComponent(filename)}`,
        { validateStatus: (status) => status === 200 || status === 404 },
      );
      if (response.status === 200) {
        return parseInt(response.data.size);
      }
      return null;
    }
  } catch (error) {
    return null;
  }
}

// Helper function to check file size in Azure/HTTP
async function getHttpFileSize(url) {
  try {
    const response = await axios.head(url);
    const contentLength = response.headers["content-length"];
    return contentLength ? parseInt(contentLength) : null;
  } catch (error) {
    console.error("Error getting HTTP file size:", error);
    return null;
  }
}

test("test GCS backup during initial upload", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  // Create a test file with known content
  const testContent = "Hello World!".repeat(1000); // Create a decent sized file
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // Upload the file - should go to both Azure/local and GCS
    const context = { log: console.log };
    const result = await uploadBlob(context, null, false, testFile);

    // Verify we got both URLs
    t.truthy(result.url, "Should have primary storage URL");
    t.truthy(result.gcs, "Should have GCS backup URL");

    // Verify GCS file exists
    const gcsExists = await gcsUrlExists(result.gcs);
    t.true(gcsExists, "File should exist in GCS");

    // Verify file content size in GCS
    const gcsSize = await getGCSFileSize(result.gcs);
    t.is(gcsSize, testContent.length, "GCS file size should match original");
  } finally {
    // Cleanup
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test("test GCS backup restoration when missing", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  // Create a test file with known content
  const testContent = "Hello World!".repeat(1000); // Create a decent sized file
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // First upload normally
    const context = { log: console.log };
    const result = await uploadBlob(context, null, false, testFile);

    // Verify initial upload worked
    t.truthy(result.gcs, "Should have GCS backup URL after initial upload");

    // Delete the GCS file
    const gcsFileName = result.gcs.replace("gs://cortextempfiles/", "");
    await deleteGCS(gcsFileName);

    // Verify file is gone
    const existsAfterDelete = await gcsUrlExists(result.gcs);
    t.false(existsAfterDelete, "File should not exist in GCS after deletion");

    // Remove GCS URL to simulate missing backup
    const { gcs: _, ...fileInfo } = result;

    // Try to ensure GCS backup
    const updatedResult = await ensureGCSUpload(context, fileInfo);

    // Verify GCS URL was added
    t.truthy(updatedResult.gcs, "Should have GCS backup URL after ensure");

    // Verify GCS file exists
    const gcsExists = await gcsUrlExists(updatedResult.gcs);
    t.true(gcsExists, "File should exist in GCS after ensure");

    // Verify file content size in GCS
    const gcsSize = await getGCSFileSize(updatedResult.gcs);
    t.is(
      gcsSize,
      testContent.length,
      "GCS file size should match original after ensure",
    );
  } finally {
    // Cleanup
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test("test primary storage restoration from GCS backup", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  // Create a test file with known content
  const testContent = "Hello World!".repeat(1000);
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // First upload normally
    const context = { log: console.log };
    const initialResult = await uploadBlob(context, null, false, testFile);

    // Verify initial upload worked
    t.truthy(initialResult.url, "Should have primary storage URL");
    t.truthy(initialResult.gcs, "Should have GCS backup URL");

    // Store the hash and simulate a missing primary file by requesting with a bad URL
    const hash = "test_primary_restore";
    const modifiedResult = {
      ...initialResult,
      url: initialResult.url.replace("test.txt", "invalid.txt"),
    };

    // Set up Redis state with the bad URL
    await setFileStoreMap(hash, modifiedResult);

    // Set up request for the handler
    const mockReq = {
      method: "GET",
      body: { params: { hash, checkHash: true } },
    };

    // Set up context for the handler
    const handlerContext = {
      log: console.log,
      res: null,
    };

    // Call the handler which should restore from GCS
    await CortexFileHandler(handlerContext, mockReq);

    // Verify we got a valid response
    t.is(handlerContext.res.status, 200, "Should get successful response");
    t.truthy(handlerContext.res.body.url, "Should have restored primary URL");
    t.truthy(handlerContext.res.body.gcs, "Should still have GCS URL");

    // Verify the restored URL is accessible
    const { valid } = await urlExists(handlerContext.res.body.url);
    t.true(valid, "Restored URL should be accessible");

    // Verify file sizes match in both storages
    const gcsSize = await getGCSFileSize(handlerContext.res.body.gcs);
    const azureSize = await getHttpFileSize(handlerContext.res.body.url);
    t.is(
      azureSize,
      testContent.length,
      "Azure file size should match original",
    );
    t.is(gcsSize, azureSize, "Azure and GCS file sizes should match");
  } finally {
    // Cleanup
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test("test hash check returns 404 when both storages are empty", async (t) => {
  if (!isGCSConfigured()) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  // Create a test file with known content
  const testContent = "Hello World!".repeat(1000);
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // First upload normally
    const context = { log: console.log };
    const initialResult = await uploadBlob(context, null, false, testFile);

    // Verify initial upload worked
    t.truthy(initialResult.url, "Should have primary storage URL");
    t.truthy(initialResult.gcs, "Should have GCS backup URL");

    // Store the hash
    const hash = "test_both_missing";
    await setFileStoreMap(hash, initialResult);

    // Verify both files exist initially
    const initialPrimaryCheck = await urlExists(initialResult.url);
    const initialGcsCheck = await gcsUrlExists(initialResult.gcs);
    t.true(initialPrimaryCheck.valid, "Primary file should exist initially");
    t.true(initialGcsCheck, "GCS file should exist initially");

    // Delete from Azure/primary storage
    const azureUrl = new URL(initialResult.url);
    console.log("Azure URL:", initialResult.url);
    // Get the path without query parameters and decode it
    const fullPath = decodeURIComponent(azureUrl.pathname);
    console.log("Full path:", fullPath);
    // Get the request ID and filename from the path
    const pathParts = fullPath.split("/");
    const blobName = pathParts[pathParts.length - 1];
    console.log("Attempting to delete Azure blob:", blobName);

    // Delete the blob using the correct container name
    const { containerClient } = await getBlobClient();
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.delete();
    console.log("Azure deletion completed");

    // Add a small delay to ensure deletion is complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Delete from GCS
    const gcsFileName = initialResult.gcs.replace("gs://cortextempfiles/", "");
    console.log("Attempting to delete GCS file:", gcsFileName);
    await deleteGCS(gcsFileName);
    console.log("GCS deletion completed");

    // Verify both files are gone
    const primaryExists = await urlExists(initialResult.url);
    console.log("Primary exists after deletion:", primaryExists.valid);
    const gcsExists = await gcsUrlExists(initialResult.gcs);
    console.log("GCS exists after deletion:", gcsExists);
    t.false(primaryExists.valid, "Primary file should be deleted");
    t.false(gcsExists, "GCS file should be deleted");

    // Try to get the file via hash - should fail
    const handlerContext = {
      log: console.log,
      res: null,
    };

    await CortexFileHandler(handlerContext, {
      method: "GET",
      body: { params: { hash, checkHash: true } },
    });

    // Verify we got a 404 response
    t.is(
      handlerContext.res.status,
      404,
      "Should get 404 when both files are missing",
    );
    t.true(
      handlerContext.res.body.includes("not found in storage"),
      "Should indicate files are missing in storage",
    );
  } finally {
    // Cleanup
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

// Container name parsing and validation tests
test("AZURE_STORAGE_CONTAINER_NAME should be a string", (t) => {
  t.is(typeof AZURE_STORAGE_CONTAINER_NAME, 'string', "Should be a string");
  t.true(AZURE_STORAGE_CONTAINER_NAME.length > 0, "Should not be empty");
});

test("getDefaultContainerName should return the container name", (t) => {
  const defaultContainer = getDefaultContainerName();
  t.is(defaultContainer, AZURE_STORAGE_CONTAINER_NAME);
  t.truthy(defaultContainer);
  t.is(typeof defaultContainer, 'string');
});
