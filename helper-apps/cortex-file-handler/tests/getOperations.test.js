import test from "ava";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import XLSX from "xlsx";
import { port } from "../src/start.js";
import { cleanupHashAndFile, createTestMediaFile } from "./testUtils.helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to create test files
async function createTestFile(content, extension) {
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  // Use a shorter filename to avoid filesystem limits
  const filename = path.join(
    testDir,
    `test-${uuidv4().slice(0, 8)}.${extension}`,
  );
  fs.writeFileSync(filename, content);
  return filename;
}

// Helper function to upload file
async function uploadFile(filePath, requestId = null, hash = null) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  if (requestId) form.append("requestId", requestId);
  if (hash) form.append("hash", hash);

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return response;
}

// Setup: Create test directory
test.before(async (t) => {
  const testDir = path.join(__dirname, "test-files");
  await fs.promises.mkdir(testDir, { recursive: true });
  t.context = { testDir };
});

// Test: Document processing with save=true
test.serial("should process document with save=true", async (t) => {
  // Create a minimal XLSX workbook in-memory
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Score"],
    ["Alice", 10],
    ["Bob", 8],
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");

  // Write it to a temp file inside the test directory
  const filePath = path.join(t.context.testDir, `${uuidv4()}.xlsx`);
  XLSX.writeFile(workbook, filePath);

  const requestId = uuidv4();
  let response;
  let convertedUrl;

  try {
    // First upload the file
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Upload should succeed");

    // Then process with save=true
    const processResponse = await axios.get(baseUrl, {
      params: {
        uri: response.data.url,
        requestId,
        save: true,
      },
      validateStatus: (status) => true,
    });

    t.is(processResponse.status, 200, "Document processing should succeed");
    t.truthy(processResponse.data.url, "Should return converted file URL");
    t.true(
      processResponse.data.url.includes(".csv"),
      "Should return a CSV URL",
    );

    // Store the converted URL for cleanup
    convertedUrl = processResponse.data.url;

    // Verify the converted file is accessible immediately after conversion
    const fileResponse = await axios.get(convertedUrl, {
      validateStatus: (status) => true,
    });

    t.is(fileResponse.status, 200, "Converted file should be accessible");
    t.true(
      fileResponse.data.includes("Name,Score"),
      "CSV should contain headers",
    );
    t.true(fileResponse.data.includes("Alice,10"), "CSV should contain data");
  } finally {
    // Clean up both the original and converted files
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
    if (convertedUrl) {
      await cleanupHashAndFile(null, convertedUrl, baseUrl);
    }
    // Clean up the local file last
    fs.unlinkSync(filePath);
  }
});

// Test: Document processing with save=false
test.serial("should process document with save=false", async (t) => {
  const fileContent = "Test document content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  let response;

  try {
    // First upload the file
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Upload should succeed");

    // Then process with save=false
    const processResponse = await axios.get(baseUrl, {
      params: {
        uri: response.data.url,
        requestId,
        save: false,
      },
      validateStatus: (status) => true,
    });

    t.is(processResponse.status, 200, "Document processing should succeed");
    t.true(
      Array.isArray(processResponse.data),
      "Should return array of chunks",
    );
    t.true(processResponse.data.length > 0, "Should return non-empty chunks");
    // ensure the first chunk contains the right content
    t.true(
      processResponse.data[0].includes(fileContent),
      "First chunk should contain the right content",
    );
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

// Test: Media file chunking
test.serial("should chunk media file", async (t) => {
  // Create a proper 10-second test audio file (MP3)
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const filePath = path.join(testDir, `test-${uuidv4()}.mp3`);

  try {
    await createTestMediaFile(filePath, 10);

    const requestId = uuidv4();
    let response;

    try {
      // First upload the file
      response = await uploadFile(filePath, requestId);
      t.is(response.status, 200, "Upload should succeed");

      // Then request chunking
      const chunkResponse = await axios.get(baseUrl, {
        params: {
          uri: response.data.url,
          requestId,
        },
        validateStatus: (status) => true,
      });

      t.is(chunkResponse.status, 200, "Chunking should succeed");
      t.true(
        Array.isArray(chunkResponse.data),
        "Should return array of chunks",
      );
      t.true(chunkResponse.data.length > 0, "Should return non-empty chunks");

      // Verify each chunk has required properties
      chunkResponse.data.forEach((chunk) => {
        t.truthy(chunk.uri, "Chunk should have URI");
        t.true(
          typeof chunk.offset === "number",
          "Chunk should have a numeric offset",
        );
      });
    } finally {
      if (response?.data?.url) {
        await cleanupHashAndFile(null, response.data.url, baseUrl);
      }
    }
  } finally {
    // Clean up the test file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

// Test: Remote file fetching with fetch parameter
test.serial("should fetch remote file", async (t) => {
  const requestId = uuidv4();
  const remoteUrl = "https://example.com/test.txt";

  try {
    const response = await axios.get(baseUrl, {
      params: {
        fetch: remoteUrl,
        requestId,
      },
      validateStatus: (status) => true,
    });

    t.is(response.status, 400, "Should reject invalid URL");
    t.is(
      response.data,
      "Invalid or inaccessible URL",
      "Should return correct error message",
    );
  } catch (error) {
    // Handle network errors gracefully - this is acceptable for this test
    t.true(
      error.code === 'ECONNRESET' || 
      error.code === 'ENOTFOUND' || 
      error.message.includes('socket hang up') ||
      error.message.includes('Network Error'),
      "Network error is acceptable for this test"
    );
  }
});

// Test: Redis caching behavior for remote files
test.serial("should cache remote files in Redis", async (t) => {
  const requestId = uuidv4();
  const hash = "test-cache-" + uuidv4();

  // First request should cache the file
  const firstResponse = await axios.get(baseUrl, {
    params: {
      fetch: "https://example.com/test.txt",
      requestId,
      hash,
      timeout: 10000,
    },
    validateStatus: (status) => true,
  });

  // Second request should return cached result
  const secondResponse = await axios.get(baseUrl, {
    params: {
      hash,
      checkHash: true,
    },
    validateStatus: (status) => true,
  });

  t.is(secondResponse.status, 404, "Should return 404 for invalid URL");
});

// Test: Error cases for invalid URLs
test.serial("should handle invalid URLs", async (t) => {
  const requestId = uuidv4();
  const invalidUrls = [
    "not-a-url",
    "http://",
    "https://",
    "ftp://invalid",
    "file:///nonexistent",
  ];

  for (const url of invalidUrls) {
    const response = await axios.get(baseUrl, {
      params: {
        uri: url,
        requestId,
      },
      validateStatus: (status) => true,
    });

    t.is(response.status, 400, `Should reject invalid URL: ${url}`);
    t.true(
      response.data.includes("Invalid") || response.data.includes("Error"),
      "Should return error message",
    );
  }
});

// Test: Long filename handling
test.serial("should handle long filenames", async (t) => {
  const fileContent = "Test content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  let response;

  try {
    // First upload the file
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Upload should succeed");

    // Create a URL with a very long filename
    const longFilename = "a".repeat(1100) + ".txt";
    const longUrl = response.data.url.replace(/[^/]+$/, longFilename);

    // Try to process the file with the long filename
    const processResponse = await axios.get(baseUrl, {
      params: {
        uri: longUrl,
        requestId,
      },
      validateStatus: (status) => true,
    });

    t.is(
      processResponse.status,
      400,
      "Should reject URL with too long filename",
    );
    t.is(
      processResponse.data,
      "URL pathname is too long",
      "Should return correct error message",
    );
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});
