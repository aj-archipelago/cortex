import test from "ava";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import XLSX from "xlsx";
import { port } from "../src/start.js";
import {
  uploadBlob,
  isValidContainerName,
  AZURE_STORAGE_CONTAINER_NAMES,
  saveFileToBlob,
} from "../src/blobHandler.js";
import { FileConversionService } from "../src/services/FileConversionService.js";
import CortexFileHandler from "../src/index.js";
import {
  startTestServer,
  stopTestServer,
  setupTestDirectory,
  cleanupHashAndFile,
  getFolderNameFromUrl,
} from "./testUtils.helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Mock context for testing
const mockContext = {
  log: (message) => console.log(`[CONTAINER_CONVERSION_TEST] ${message}`),
  res: null,
};

// Helper function to create test files
async function createTestFile(content, extension, filename = null) {
  const testDir = path.join(__dirname, "test-conversion-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const testFilename = filename || `${uuidv4()}.${extension}`;
  const filePath = path.join(testDir, testFilename);
  
  if (extension === 'xlsx') {
    // Create Excel file
    const workbook = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(content);
    XLSX.utils.book_append_sheet(workbook, ws1, "Sheet1");
    XLSX.writeFile(workbook, filePath);
  } else {
    fs.writeFileSync(filePath, content);
  }
  
  return filePath;
}

// Helper function to check if URL belongs to specific container
function getContainerFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split('/').filter(Boolean);
    
    // For Azure URLs, container is typically the first segment after the account
    // Format: https://account.blob.core.windows.net/container/blob...
    // For Azurite (local emulator), format is: http://127.0.0.1:10000/devstoreaccount1/container/blob...
    if (pathSegments.length > 0) {
      // Check if this is an Azurite URL (localhost with devstoreaccount1)
      if (urlObj.hostname === '127.0.0.1' && pathSegments[0] === 'devstoreaccount1') {
        // For Azurite, container is the second segment
        return pathSegments.length > 1 ? pathSegments[1] : null;
      } else {
        // For production Azure, container is the first segment
        return pathSegments[0];
      }
    }
  } catch (error) {
    console.log("Error parsing container from URL:", error);
  }
  return null;
}

// Setup: Create test directory and start server
test.before(async (t) => {
  await startTestServer();
  await setupTestDirectory(t);
});

// Cleanup
test.after.always(async (t) => {
  await stopTestServer();

  // Clean up test directory
  if (t.context?.testDir) {
    await fs.promises.rm(t.context.testDir, { recursive: true, force: true });
  }

  // Clean up any remaining files in the test-conversion-files directory
  const testFilesDir = path.join(__dirname, "test-conversion-files");
  if (fs.existsSync(testFilesDir)) {
    try {
      await fs.promises.rm(testFilesDir, { recursive: true, force: true });
    } catch (error) {
      console.log("Error cleaning test files:", error);
    }
  }
});

// Test that FileConversionService._saveConvertedFile respects container parameter
test("FileConversionService._saveConvertedFile should use specified container", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    const service = new FileConversionService(mockContext, true); // useAzure = true
    
    // Create a test file to save
    const testContent = "This is converted file content";
    const testFile = await createTestFile(testContent, "txt", "converted-test.txt");
    const requestId = uuidv4();
    const targetContainer = "test2";

    // Call _saveConvertedFile with container parameter
    const result = await service._saveConvertedFile(
      testFile,
      requestId,
      null, // filename
      targetContainer
    );

    t.truthy(result);
    t.truthy(result.url);

    // Verify the URL indicates it was uploaded to the correct container
    const containerFromUrl = getContainerFromUrl(result.url);
    t.is(containerFromUrl, targetContainer, 
      `File should be uploaded to container ${targetContainer}, but was uploaded to ${containerFromUrl}`);

    // Cleanup
    await cleanupHashAndFile(null, result.url, baseUrl);
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test that file upload with conversion respects container parameter
test("File upload with conversion should upload both original and converted files to specified container", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Create an Excel file that will need conversion
    const excelData = [
      ["Name", "Age", "City"],
      ["John", 30, "New York"],
      ["Jane", 25, "Boston"],
    ];
    const testFile = await createTestFile(excelData, "xlsx", "test-conversion.xlsx");
    const targetContainer = "test3";

    // Create form data with container parameter
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "test-conversion.xlsx");
    form.append("container", targetContainer);

    const response = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 60000, // Longer timeout for conversion
    });

    t.is(response.status, 200);
    t.truthy(response.data.url);

    // Check that the main uploaded file is in the correct container
    const mainContainerFromUrl = getContainerFromUrl(response.data.url);
    t.is(mainContainerFromUrl, targetContainer,
      `Original file should be in container ${targetContainer}, but was in ${mainContainerFromUrl}`);

    // If there's a converted file mentioned in the response, check its container too
    if (response.data.converted && response.data.converted.url) {
      const convertedContainerFromUrl = getContainerFromUrl(response.data.converted.url);
      t.is(convertedContainerFromUrl, targetContainer,
        `Converted file should be in container ${targetContainer}, but was in ${convertedContainerFromUrl}`);
    }

    // Cleanup
    await cleanupHashAndFile(null, response.data.url, baseUrl);
    if (response.data.converted && response.data.converted.url) {
      await cleanupHashAndFile(null, response.data.converted.url, baseUrl);
    }
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test document processing with save=true and container parameter
test("Document processing with save=true should save converted file to specified container", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // First upload a document file to get a URI
    const docContent = "This is a test document content for processing.";
    const testFile = await createTestFile(docContent, "txt", "test-doc.txt");
    const targetContainer = "test1";

    // Upload the file first
    const uploadForm = new FormData();
    uploadForm.append("file", fs.createReadStream(testFile), "test-doc.txt");
    uploadForm.append("container", targetContainer);

    const uploadResponse = await axios.post(baseUrl, uploadForm, {
      headers: {
        ...uploadForm.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    });

    t.is(uploadResponse.status, 200);
    const documentUri = uploadResponse.data.url;

    // Now process the document with save=true and container parameter
    const processResponse = await axios.get(baseUrl, {
      params: {
        uri: documentUri,
        requestId: uuidv4(),
        save: true,
        container: targetContainer,
      },
      validateStatus: (status) => true,
      timeout: 60000,
    });

    t.is(processResponse.status, 200);
    t.truthy(processResponse.data.url);

    // Check that the saved file is in the correct container
    const savedContainerFromUrl = getContainerFromUrl(processResponse.data.url);
    t.is(savedContainerFromUrl, targetContainer,
      `Saved processed file should be in container ${targetContainer}, but was in ${savedContainerFromUrl}`);

    // Cleanup
    await cleanupHashAndFile(null, documentUri, baseUrl);
    await cleanupHashAndFile(null, processResponse.data.url, baseUrl);
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test checkHash operation preserves container for converted files
test("checkHash operation should respect container parameter for converted files", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Create an Excel file that will need conversion
    const excelData = [
      ["Product", "Price"],
      ["Widget", 10.99],
      ["Gadget", 15.50],
    ];
    const testFile = await createTestFile(excelData, "xlsx", "hash-test.xlsx");
    const targetContainer = "test2";
    const testHash = uuidv4();

    // Upload the file with a hash and container parameter
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "hash-test.xlsx");
    form.append("hash", testHash);
    form.append("container", targetContainer);

    const uploadResponse = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 60000,
    });

    t.is(uploadResponse.status, 200);

    // Now check the hash with container parameter
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash: testHash,
        checkHash: true,
        container: targetContainer,
      },
      validateStatus: (status) => true,
      timeout: 60000,
    });

    t.is(checkResponse.status, 200);
    t.truthy(checkResponse.data.url);

    // Check that the original file is in the correct container
    const originalContainerFromUrl = getContainerFromUrl(checkResponse.data.url);
    t.is(originalContainerFromUrl, targetContainer,
      `Original file should be in container ${targetContainer}, but was in ${originalContainerFromUrl}`);

    // If there's a converted file, check its container too
    if (checkResponse.data.converted && checkResponse.data.converted.url) {
      const convertedContainerFromUrl = getContainerFromUrl(checkResponse.data.converted.url);
      t.is(convertedContainerFromUrl, targetContainer,
        `Converted file should be in container ${targetContainer}, but was in ${convertedContainerFromUrl}`);
    }

    // Cleanup
    await cleanupHashAndFile(testHash, checkResponse.data.url, baseUrl);
    if (checkResponse.data.converted && checkResponse.data.converted.url) {
      await cleanupHashAndFile(null, checkResponse.data.converted.url, baseUrl);
    }
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test that default container is used when no container specified for conversions
test("Conversion should use default container when no container specified", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    const service = new FileConversionService(mockContext, true);
    
    // Create a test file to save
    const testContent = "This is converted file content for default container test";
    const testFile = await createTestFile(testContent, "txt", "default-container-test.txt");
    const requestId = uuidv4();

    // Call _saveConvertedFile without container parameter (should use default)
    const result = await service._saveConvertedFile(
      testFile,
      requestId,
      null, // filename
      null  // container - should use default
    );

    t.truthy(result);
    t.truthy(result.url);

    // Verify the URL indicates it was uploaded to the default container
    const containerFromUrl = getContainerFromUrl(result.url);
    t.is(containerFromUrl, AZURE_STORAGE_CONTAINER_NAMES[0],
      `File should be uploaded to default container ${AZURE_STORAGE_CONTAINER_NAMES[0]}, but was uploaded to ${containerFromUrl}`);

    // Cleanup
    await cleanupHashAndFile(null, result.url, baseUrl);
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test saveFileToBlob function directly with container parameter
test("saveFileToBlob should respect container parameter", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Create a test file
    const testContent = "This is a test for saveFileToBlob with container parameter";
    const testFile = await createTestFile(testContent, "txt", "save-blob-test.txt");
    const requestId = uuidv4();
    const targetContainer = "test3";

    // Call saveFileToBlob directly with container parameter
    const result = await saveFileToBlob(testFile, requestId, null, targetContainer);

    t.truthy(result);
    t.truthy(result.url);
    t.truthy(result.blobName);

    // Verify the URL indicates it was uploaded to the correct container
    const containerFromUrl = getContainerFromUrl(result.url);
    t.is(containerFromUrl, targetContainer,
      `File should be uploaded to container ${targetContainer}, but was uploaded to ${containerFromUrl}`);

    // Cleanup
    await cleanupHashAndFile(null, result.url, baseUrl);
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});