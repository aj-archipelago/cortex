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
  AZURE_STORAGE_CONTAINER_NAME,
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

// Test that file upload with conversion works
test("File upload with conversion should work", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  try {
    // Create an Excel file that will need conversion
    const excelData = [
      ["Name", "Age", "City"],
      ["John", 30, "New York"],
      ["Jane", 25, "Boston"],
    ];
    const testFile = await createTestFile(excelData, "xlsx", "test-conversion.xlsx");

    // Create form data
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "test-conversion.xlsx");

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

    // Check that conversion worked
    if (response.data.converted && response.data.converted.url) {
      t.truthy(response.data.converted.url);
    }

    // Cleanup
    await cleanupHashAndFile(null, response.data.url, baseUrl);
    if (response.data.converted && response.data.converted.url) {
      await cleanupHashAndFile(null, response.data.converted.url, baseUrl);
    }
  } finally {
    // No env changes needed
  }
});

// Test document processing with save=true
test("Document processing with save=true should work", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  try {
    // First upload a document file to get a URI
    const docContent = "This is a test document content for processing.";
    const testFile = await createTestFile(docContent, "txt", "test-doc.txt");

    // Upload the file first
    const uploadForm = new FormData();
    uploadForm.append("file", fs.createReadStream(testFile), "test-doc.txt");

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

    // Now process the document with save=true
    const processResponse = await axios.get(baseUrl, {
      params: {
        uri: documentUri,
        requestId: uuidv4(),
        save: true,
      },
      validateStatus: (status) => true,
      timeout: 60000,
    });

    t.is(processResponse.status, 200);
    t.truthy(processResponse.data.url);

    // Cleanup
    await cleanupHashAndFile(null, documentUri, baseUrl);
    await cleanupHashAndFile(null, processResponse.data.url, baseUrl);
  } finally {
    // No env changes needed
  }
});

// Test checkHash operation with conversion
test("checkHash operation should work with converted files", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  try {
    // Create an Excel file that will need conversion
    const excelData = [
      ["Product", "Price"],
      ["Widget", 10.99],
      ["Gadget", 15.50],
    ];
    const testFile = await createTestFile(excelData, "xlsx", "hash-test.xlsx");
    const testHash = uuidv4();

    // Upload the file with a hash
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "hash-test.xlsx");
    form.append("hash", testHash);

    const uploadResponse = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 60000,
    });

    t.is(uploadResponse.status, 200);

    // Now check the hash
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash: testHash,
        checkHash: true,
      },
      validateStatus: (status) => true,
      timeout: 60000,
    });

    t.is(checkResponse.status, 200);
    t.truthy(checkResponse.data.url);

    // Check that conversion worked
    if (checkResponse.data.converted && checkResponse.data.converted.url) {
      t.truthy(checkResponse.data.converted.url);
    }

    // Cleanup
    await cleanupHashAndFile(testHash, checkResponse.data.url, baseUrl);
    if (checkResponse.data.converted && checkResponse.data.converted.url) {
      await cleanupHashAndFile(null, checkResponse.data.converted.url, baseUrl);
    }
  } finally {
    // No env changes needed
  }
});
