import test from "ava";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import XLSX from "xlsx";
import nock from "nock";
import { port } from "../src/start.js";
import { gcsUrlExists } from "../src/blobHandler.js";
import { getDefaultContainerName, getUserContainerName } from "../src/constants.js";
import { cleanupHashAndFile, createTestMediaFile, startTestServer, stopTestServer, setupTestDirectory } from "./testUtils.helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

function isGCSConfigured() {
  return (
    process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
    process.env.GCP_SERVICE_ACCOUNT_KEY
  );
}

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

async function uploadScopedFile(filePath, {
  contextId = null,
  userId = null,
  workspaceId = null,
  appletId = null,
  fileScope = null,
  hash = null,
} = {}) {
  const form = new FormData();
  if (contextId) form.append("contextId", contextId);
  if (userId) form.append("userId", userId);
  if (workspaceId) form.append("workspaceId", workspaceId);
  if (appletId) form.append("appletId", appletId);
  if (fileScope) form.append("fileScope", fileScope);
  if (hash) form.append("hash", hash);
  form.append("file", fs.createReadStream(filePath));

  return await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: (status) => true,
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}

// Setup: Create test directory and start server
test.before(async (t) => {
  await startTestServer();
  await setupTestDirectory(t);
});

// Clean up server after tests
test.after.always(async () => {
  await stopTestServer();
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

  // Mock external HEAD and GET to avoid network dependency
  const body = "hello from example";
  const scope = nock("https://example.com")
    .head("/test.txt")
    .reply(200, "", {
      "Content-Type": "text/plain",
      "Content-Length": body.length.toString(),
    })
    .get("/test.txt")
    .reply(200, body, {
      "Content-Type": "text/plain",
      "Content-Length": body.length.toString(),
    });

  const response = await axios.get(baseUrl, {
    params: {
      fetch: remoteUrl,
      requestId,
    },
    validateStatus: (status) => true,
    timeout: 10000,
  });

  t.is(response.status, 200, "Should fetch and store remote file");
  t.truthy(response.data.url, "Should return file URL");
  t.true(scope.isDone(), "All external requests should be mocked and used");
});

test.serial("applet-user uploads use the user container and stay isolated by applet folder", async (t) => {
  const fileA = await createTestFile("alpha applet content", "txt");
  const fileB = await createTestFile("beta applet content", "txt");
  const userId = `user-${uuidv4().slice(0, 8)}`;
  const appletA = `applet-${uuidv4().slice(0, 6)}`;
  const appletB = `applet-${uuidv4().slice(0, 6)}`;
  const hashA = "aaaaaaaaaaaaaaaa";
  const hashB = "bbbbbbbbbbbbbbbb";
  const contextIdA = `applet-user:${appletA}:${userId}`;
  const contextIdB = `applet-user:${appletB}:${userId}`;

  let responseA;
  let responseB;

  try {
    responseA = await uploadScopedFile(fileA, {
      contextId: contextIdA,
      userId,
      appletId: appletA,
      fileScope: "applet-user",
      hash: hashA,
    });
    responseB = await uploadScopedFile(fileB, {
      contextId: contextIdB,
      userId,
      appletId: appletB,
      fileScope: "applet-user",
      hash: hashB,
    });

    t.is(responseA.status, 200);
    t.is(responseB.status, 200);

    const userContainerName = getUserContainerName(
      getDefaultContainerName(),
      userId,
    );

    if (!responseA.data.url.startsWith("http://localhost:7071/files/")) {
      t.true(responseA.data.url.includes(`/${userContainerName}/`));
      t.true(responseB.data.url.includes(`/${userContainerName}/`));
      t.false(responseA.data.url.includes(`applet-user-${appletA}-${userId}`));
      t.false(responseB.data.url.includes(`applet-user-${appletB}-${userId}`));
    }
    t.is(responseA.data.folderPath, `applets/${appletA}`);
    t.is(responseB.data.folderPath, `applets/${appletB}`);
    t.is(responseA.data.contextId, contextIdA);
    t.is(responseB.data.contextId, contextIdB);

    const listA = await axios.get(baseUrl, {
      params: {
        listFolder: true,
        userId,
        appletId: appletA,
        fileScope: "applet-user",
      },
      validateStatus: () => true,
      timeout: 30000,
    });
    const listB = await axios.get(baseUrl, {
      params: {
        listFolder: true,
        userId,
        appletId: appletB,
        fileScope: "applet-user",
      },
      validateStatus: () => true,
      timeout: 30000,
    });

    if (listA.status === 200 && listB.status === 200) {
      t.is(listA.data.folderPath, `applets/${appletA}`);
      t.is(listB.data.folderPath, `applets/${appletB}`);
      t.is(listA.data.count, 1);
      t.is(listB.data.count, 1);
      t.is(listA.data.files[0].hash, hashA);
      t.is(listB.data.files[0].hash, hashB);
    } else {
      t.is(listA.status, 500);
      t.is(listB.status, 500);
      t.is(listA.data, "Storage provider does not support folder listing");
      t.is(listB.data, "Storage provider does not support folder listing");
    }
  } finally {
    if (responseA?.data?.hash) {
      await axios.delete(baseUrl, {
        params: { hash: responseA.data.hash, contextId: contextIdA },
        validateStatus: () => true,
        timeout: 10000,
      });
    }
    if (responseB?.data?.hash) {
      await axios.delete(baseUrl, {
        params: { hash: responseB.data.hash, contextId: contextIdB },
        validateStatus: () => true,
        timeout: 10000,
      });
    }
    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
  }
});

// Test: Redis caching behavior for remote files
test.serial("should cache remote files in Redis", async (t) => {
  const requestId = uuidv4();
  const hash = "test-cache-" + uuidv4();
  const testContent = "This is test content for caching";
  const testUrl = "https://test-server.example.com/test.txt";

  // Mock the external HTTP requests (HEAD for validation and GET for fetching)
  // We need multiple HEAD mocks because each request validates the URL
  const scope = nock("https://test-server.example.com")
    .persist() // Allow the mocks to be reused
    .head("/test.txt")
    .reply(200, "", {
      "Content-Type": "text/plain",
      "Content-Length": testContent.length.toString(),
    })
    .get("/test.txt")
    .reply(200, testContent, {
      "Content-Type": "text/plain",
      "Content-Length": testContent.length.toString(),
    });

  try {
    // First request should fetch and cache the file with hash
    const firstResponse = await axios.get(baseUrl, {
      params: {
        fetch: testUrl,
        requestId,
        hash,
        timeout: 10000,
      },
      validateStatus: (status) => true,
    });

    t.is(firstResponse.status, 200, "Should successfully fetch and cache remote file");
    t.truthy(firstResponse.data.url, "Should return file URL");

    // Second request should return cached result using hash
    const secondResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: (status) => true,
    });

    t.is(secondResponse.status, 200, "Should return cached file from Redis");
    t.truthy(secondResponse.data.url, "Should return cached file URL");

    // Cleanup
    await cleanupHashAndFile(hash, secondResponse.data.url, baseUrl);
  } finally {
    // Clean up nock
    nock.cleanAll();
  }
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

// Test: blobPath lookup should return a short-lived URL
test.serial("should return short-lived URL for blobPath lookup", async (t) => {
  const fileContent = "blobPath test content";
  const filePath = await createTestFile(fileContent, "txt");
  const requestId = uuidv4();
  let response;

  try {
    // Upload a file first
    response = await uploadFile(filePath, requestId);
    t.is(response.status, 200, "Upload should succeed");

    // Extract the blob path from the upload URL
    const uploadUrl = response.data.url;
    let extractedBlobPath;

    if (uploadUrl.includes("127.0.0.1:10000")) {
      // Azurite URL: http://127.0.0.1:10000/devstoreaccount1/container/blobpath
      const urlObj = new URL(uploadUrl);
      const parts = urlObj.pathname.split("/").filter(Boolean);
      // Skip account name and container name
      extractedBlobPath = parts.slice(2).join("/");
    } else if (uploadUrl.includes("blob.core.windows.net")) {
      // Azure URL: https://account.blob.core.windows.net/container/blobpath
      const urlObj = new URL(uploadUrl.split("?")[0]);
      const parts = urlObj.pathname.split("/").filter(Boolean);
      // Skip container name
      extractedBlobPath = parts.slice(1).join("/");
    } else {
      // Local URL: http://localhost:port/files/requestId/filename
      const urlObj = new URL(uploadUrl);
      const parts = urlObj.pathname.split("/").filter(Boolean);
      // Skip "files" prefix
      extractedBlobPath = parts.slice(1).join("/");
    }

    t.truthy(extractedBlobPath, "Should extract blob path from URL");

    // Look up by blobPath (no hash)
    const lookupResponse = await axios.get(baseUrl, {
      params: { blobPath: extractedBlobPath },
      validateStatus: (status) => true,
    });

    t.is(lookupResponse.status, 200, "blobPath lookup should succeed");
    t.truthy(lookupResponse.data.shortLivedUrl, "Should return shortLivedUrl");
    t.truthy(lookupResponse.data.url, "Should return url");
    if (isGCSConfigured()) {
      t.truthy(lookupResponse.data.gcs, "Should return a GCS backup URL");
      t.true(
        await gcsUrlExists(lookupResponse.data.gcs),
        "Returned GCS backup URL should exist",
      );
    }

    // Verify the short-lived URL is accessible and returns correct content
    const fileResponse = await axios.get(lookupResponse.data.shortLivedUrl, {
      validateStatus: (status) => true,
    });
    t.is(fileResponse.status, 200, "Short-lived URL should be accessible");
    t.true(fileResponse.data.includes(fileContent), "Should return correct file content");
  } finally {
    fs.unlinkSync(filePath);
    if (response?.data?.url) {
      await cleanupHashAndFile(null, response.data.url, baseUrl);
    }
  }
});

// Test: blobPath lookup should return 404 for non-existent blob
test.serial("should return 404 for non-existent blobPath", async (t) => {
  const response = await axios.get(baseUrl, {
    params: { blobPath: `non-existent-${uuidv4()}/fake-file.txt` },
    validateStatus: (status) => true,
  });

  t.is(response.status, 404, "Should return 404 for non-existent blobPath");
});
