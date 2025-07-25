import test from "ava";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LocalStorageProvider } from "../../src/services/storage/LocalStorageProvider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.before(() => {
  // Create test directory
  const testDir = path.join(__dirname, "test-files");
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
});

test.after(() => {
  // Cleanup test directory
  const testDir = path.join(__dirname, "test-files");
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

test("should create provider with valid path", (t) => {
  const provider = new LocalStorageProvider(path.join(__dirname, "test-files"));
  t.truthy(provider);
});

test("should throw error with missing path", (t) => {
  t.throws(
    () => {
      new LocalStorageProvider(null);
    },
    { message: "Missing public folder path" },
  );
});

test("should create public folder if it does not exist", (t) => {
  const testDir = path.join(__dirname, "test-files", "new-folder");
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }

  const provider = new LocalStorageProvider(testDir);
  t.true(fs.existsSync(testDir));
});

test("should upload and delete file", async (t) => {
  const provider = new LocalStorageProvider(path.join(__dirname, "test-files"));

  // Create test file
  const testContent = "Hello World!";
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // Upload file
    const requestId = "test-upload";
    const result = await provider.uploadFile({}, testFile, requestId);

    t.truthy(result.url);
    t.truthy(result.blobName);
    t.true(result.url.includes("/files/"));
    t.true(result.blobName.startsWith(requestId));

    // Verify file exists
    const exists = await provider.fileExists(result.url);
    t.true(exists);

    // Delete file
    const deleted = await provider.deleteFiles(requestId);
    t.true(deleted.length > 0);
    t.true(deleted[0].startsWith(requestId));

    // Verify file is gone
    const existsAfterDelete = await provider.fileExists(result.url);
    t.false(existsAfterDelete);
  } finally {
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test("should handle file download", async (t) => {
  const provider = new LocalStorageProvider(path.join(__dirname, "test-files"));

  // Create test file
  const testContent = "Hello World!";
  const testFile = path.join(__dirname, "test.txt");
  fs.writeFileSync(testFile, testContent);

  try {
    // Upload file
    const requestId = "test-download";
    const result = await provider.uploadFile({}, testFile, requestId);

    // Download to new location
    const downloadPath = path.join(__dirname, "downloaded.txt");
    await provider.downloadFile(result.url, downloadPath);

    // Verify content
    const downloadedContent = fs.readFileSync(downloadPath, "utf8");
    t.is(downloadedContent, testContent);

    // Cleanup
    await provider.deleteFiles(requestId);
    fs.unlinkSync(downloadPath);
  } finally {
    // Cleanup test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test("should handle cleanup of multiple files", async (t) => {
  const provider = new LocalStorageProvider(path.join(__dirname, "test-files"));

  // Create test files
  const testContent = "Hello World!";
  const testFile1 = path.join(__dirname, "test1.txt");
  const testFile2 = path.join(__dirname, "test2.txt");
  fs.writeFileSync(testFile1, testContent);
  fs.writeFileSync(testFile2, testContent);

  try {
    // Upload files
    const requestId1 = "test-cleanup-1";
    const requestId2 = "test-cleanup-2";
    const result1 = await provider.uploadFile({}, testFile1, requestId1);
    const result2 = await provider.uploadFile({}, testFile2, requestId2);

    // Cleanup files
    const cleaned = await provider.cleanup([result1.url, result2.url]);
    t.is(cleaned.length, 2);

    // Verify files are gone
    const exists1 = await provider.fileExists(result1.url);
    const exists2 = await provider.fileExists(result2.url);
    t.false(exists1);
    t.false(exists2);
  } finally {
    // Cleanup test files
    if (fs.existsSync(testFile1)) fs.unlinkSync(testFile1);
    if (fs.existsSync(testFile2)) fs.unlinkSync(testFile2);
  }
});
