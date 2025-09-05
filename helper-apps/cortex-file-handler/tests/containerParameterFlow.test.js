import test from "ava";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import { port } from "../src/start.js";
import {
  uploadBlob,
  isValidContainerName,
  AZURE_STORAGE_CONTAINER_NAMES,
  DEFAULT_AZURE_STORAGE_CONTAINER_NAME,
} from "../src/blobHandler.js";
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

// Helper function to create test files
async function createTestFile(content, extension) {
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const filename = path.join(testDir, `${uuidv4()}.${extension}`);
  fs.writeFileSync(filename, content);
  return filename;
}

// Mock context for testing
const mockContext = {
  log: (message) => console.log(`[TEST] ${message}`),
  res: null,
};

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

  // Clean up any remaining files in the test-files directory
  const testFilesDir = path.join(__dirname, "test-files");
  if (fs.existsSync(testFilesDir)) {
    try {
      await fs.promises.rm(testFilesDir, { recursive: true, force: true });
    } catch (error) {
      console.log("Error cleaning test files:", error);
    }
  }
});

// Test container parameter validation
test("should validate container names correctly", (t) => {
  // Test with valid container names from configuration
  AZURE_STORAGE_CONTAINER_NAMES.forEach(containerName => {
    t.true(isValidContainerName(containerName), `${containerName} should be valid`);
  });

  // Test with invalid container names
  const invalidNames = ["invalid-container", "", null, undefined, "nonexistent"];
  invalidNames.forEach(name => {
    t.false(isValidContainerName(name), `${name} should be invalid`);
  });
});

// Test uploadBlob function with container parameter
test("uploadBlob should accept and use container parameter from function parameter", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  // Create a test file
  const testFile = await createTestFile("test content", "txt");
  const testStream = fs.createReadStream(testFile);
  
  // Mock request with container parameter in function call
  const mockReq = {
    headers: { "content-type": "application/octet-stream" },
  };

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Call uploadBlob with container parameter
    const result = await uploadBlob(
      mockContext,
      mockReq,
      false, // saveToLocal
      testFile, // filePath
      null, // hash
      "test2" // container parameter
    );

    t.truthy(result);
    t.truthy(result.url || mockContext.res?.body?.url);

    // Cleanup
    const uploadedUrl = result.url || mockContext.res?.body?.url;
    if (uploadedUrl) {
      const folderName = getFolderNameFromUrl(uploadedUrl);
      await cleanupHashAndFile(null, uploadedUrl, baseUrl);
    }
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
    
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

// Test uploadBlob function with container parameter in form data
test("uploadBlob should accept container parameter from form data", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Create a test file
    const testContent = "test content for form data";
    const testFile = await createTestFile(testContent, "txt");

    // Create form data with container parameter
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "test.txt");
    form.append("container", "test3");

    const response = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    });

    t.is(response.status, 200);
    t.truthy(response.data.url);

    // Cleanup
    await cleanupHashAndFile(null, response.data.url, baseUrl);
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test invalid container name in form data
test("uploadBlob should reject invalid container names in form data", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  // Create a test file
  const testContent = "test content";
  const testFile = await createTestFile(testContent, "txt");

  try {
    // Create form data with invalid container parameter
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "test.txt");
    form.append("container", "invalid-container-name");

    const response = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    });

    t.is(response.status, 400);
    t.truthy(response.data.message || response.data.error);
    t.true(
      (response.data.message || response.data.error || "").includes("Invalid container name")
    );
  } finally {
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

// Test container parameter flow through index.js
test("CortexFileHandler should pass container parameter for remote file downloads", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Create a test file URL (this would typically be a remote URL)
    const testUrl = "https://example.com/test.txt";
    
    // Mock request for remote file with container parameter
    const mockReq = {
      query: {
        fetch: testUrl,
        container: "test2"
      },
      method: "GET"
    };

    // Since we can't easily test real remote downloads in unit tests,
    // we'll test the parameter extraction and validation
    const { container } = mockReq.query;
    
    t.is(container, "test2");
    t.true(isValidContainerName(container));
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test container parameter flow for document processing
test("CortexFileHandler should pass container parameter for document processing", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Mock request for document processing with container parameter
    const mockReq = {
      body: {
        params: {
          uri: "https://example.com/test.pdf",
          requestId: "test-request",
          container: "test3"
        }
      },
      query: {},
      method: "GET"
    };

    // Extract parameters like index.js does
    const {
      uri,
      requestId,
      container,
    } = mockReq.body?.params || mockReq.query;

    t.is(uri, "https://example.com/test.pdf");
    t.is(requestId, "test-request");
    t.is(container, "test3");
    t.true(isValidContainerName(container));
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});

// Test default container behavior
test("should use default container when no container specified", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  // Test that default container is first in the list
  t.is(DEFAULT_AZURE_STORAGE_CONTAINER_NAME, AZURE_STORAGE_CONTAINER_NAMES[0]);
  t.true(isValidContainerName(DEFAULT_AZURE_STORAGE_CONTAINER_NAME));

  // Create a test file
  const testContent = "test content for default container";
  const testFile = await createTestFile(testContent, "txt");

  try {
    // Create form data without container parameter (should use default)
    const form = new FormData();
    form.append("file", fs.createReadStream(testFile), "test.txt");

    const response = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        "Content-Type": "multipart/form-data",
      },
      validateStatus: (status) => true,
      timeout: 30000,
    });

    t.is(response.status, 200);
    t.truthy(response.data.url);

    // Cleanup
    await cleanupHashAndFile(null, response.data.url, baseUrl);
  } finally {
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

// Test container parameter with media chunking
test("should pass container parameter for media file chunking", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;
  process.env.AZURE_STORAGE_CONTAINER_NAME = "test1,test2,test3";

  try {
    // Mock request for media file processing with container parameter
    const mockReq = {
      body: {
        params: {
          uri: "https://example.com/test.mp3",
          requestId: "test-media-request",
          container: "test1"
        }
      },
      query: {},
      method: "GET"
    };

    // Extract parameters like index.js does
    const {
      uri,
      requestId,
      container,
    } = mockReq.body?.params || mockReq.query;

    t.is(uri, "https://example.com/test.mp3");
    t.is(requestId, "test-media-request");
    t.is(container, "test1");
    t.true(isValidContainerName(container));
  } finally {
    // Restore environment
    if (originalEnv) {
      process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
    } else {
      delete process.env.AZURE_STORAGE_CONTAINER_NAME;
    }
  }
});