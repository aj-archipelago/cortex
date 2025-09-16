import test from 'ava';
import axios from 'axios';
import FormData from 'form-data';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import XLSX from 'xlsx';
import os from 'os';
import { fileURLToPath } from 'url';
import { 
  startTestServer, 
  stopTestServer, 
  cleanupHashAndFile 
} from './testUtils.helper.js';
import { port } from '../src/start.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to extract file extension from URL
function getFileExtensionFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const lastDotIndex = pathname.lastIndexOf('.');
    if (lastDotIndex !== -1 && lastDotIndex < pathname.length - 1) {
      return pathname.substring(lastDotIndex);
    }
  } catch (error) {
    console.log("Error parsing extension from URL:", error);
  }
  return null;
}

// Helper function to upload files
async function uploadFile(filePath, requestId = null, hash = null) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  
  if (requestId) {
    form.append('requestId', requestId);
  }
  if (hash) {
    form.append('hash', hash);
  }

  const response = await axios.post(baseUrl, form, {
    headers: form.getHeaders(),
    validateStatus: (status) => true,
    timeout: 60000,
  });

  return response;
}

// Test setup
test.before(async (t) => {
  await startTestServer();
  // Create a test directory for temporary files
  t.context.testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-shortlived-conversion-'));
});

test.after(async (t) => {
  // Clean up test directory
  if (t.context.testDir && fs.existsSync(t.context.testDir)) {
    fs.rmSync(t.context.testDir, { recursive: true, force: true });
  }
  await stopTestServer();
});

/**
 * Test that short-lived URLs are generated from converted files, not original files
 */
test.serial(
  "checkHash should generate shortLivedUrl from converted file URL for Excel files",
  async (t) => {
    // Create a minimal XLSX workbook in-memory
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Product", "Price", "Quantity"],
      ["Apple", 1.50, 100],
      ["Banana", 0.75, 200],
      ["Cherry", 2.00, 50],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Products");

    // Write it to a temp file
    const filePath = path.join(t.context.testDir, `${uuidv4()}.xlsx`);
    XLSX.writeFile(workbook, filePath);

    const hash = `test-shortlived-conversion-${uuidv4()}`;
    let uploadedUrl;
    let convertedUrl;

    try {
      // 1. Upload the XLSX file with hash (conversion should run automatically)
      const uploadResponse = await uploadFile(filePath, null, hash);
      t.is(uploadResponse.status, 200, "Upload should succeed");
      t.truthy(uploadResponse.data.converted, "Upload response must contain converted info");
      t.truthy(uploadResponse.data.converted.url, "Converted URL should be present");

      uploadedUrl = uploadResponse.data.url;
      convertedUrl = uploadResponse.data.converted.url;

      // Verify the original file is .xlsx and converted file is .csv
      t.is(getFileExtensionFromUrl(uploadedUrl), '.xlsx', "Original URL should point to .xlsx file");
      t.is(getFileExtensionFromUrl(convertedUrl), '.csv', "Converted URL should point to .csv file");

      // 2. Give Redis a moment to persist
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 3. Check hash to get short-lived URL
      const checkResponse = await axios.get(baseUrl, {
        params: { hash, checkHash: true },
        validateStatus: (status) => true,
        timeout: 30000,
      });

      t.is(checkResponse.status, 200, "checkHash should succeed");
      t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
      t.truthy(checkResponse.data.converted, "Response should include converted info");

      // 4. CRITICAL TEST: Verify short-lived URL is based on converted file, not original
      const shortLivedUrlBase = checkResponse.data.shortLivedUrl.split('?')[0]; // Remove query params
      const convertedUrlBase = checkResponse.data.converted.url.split('?')[0]; // Remove query params
      const originalUrlBase = checkResponse.data.url.split('?')[0]; // Remove query params

      // The short-lived URL should be based on the converted file URL
      t.is(
        shortLivedUrlBase, 
        convertedUrlBase,
        "Short-lived URL should be based on converted file URL (.csv), not original file URL (.xlsx)"
      );

      // Double-check: short-lived URL should NOT be based on original file
      t.not(
        shortLivedUrlBase,
        originalUrlBase,
        "Short-lived URL should NOT be based on original file URL (.xlsx)"
      );

      // Verify the short-lived URL points to a CSV file, not Excel
      t.true(
        checkResponse.data.shortLivedUrl.includes('.csv'),
        "Short-lived URL should point to .csv file (converted), not .xlsx file (original)"
      );

      t.false(
        checkResponse.data.shortLivedUrl.includes('.xlsx'),
        "Short-lived URL should NOT contain .xlsx extension"
      );

    } finally {
      // Clean up
      fs.unlinkSync(filePath);
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
      if (convertedUrl) {
        await cleanupHashAndFile(null, convertedUrl, baseUrl);
      }
    }
  },
);

/**
 * Test that short-lived URLs fallback to original files when no conversion exists
 */
test.serial(
  "checkHash should generate shortLivedUrl from original file URL when no conversion exists",
  async (t) => {
    // Create a simple text file (no conversion needed)
    const testContent = "This is a simple text file that doesn't need conversion.";
    const filePath = path.join(t.context.testDir, `${uuidv4()}.txt`);
    fs.writeFileSync(filePath, testContent);

    const hash = `test-shortlived-original-${uuidv4()}`;
    let uploadedUrl;

    try {
      // 1. Upload the text file with hash (no conversion should occur)
      const uploadResponse = await uploadFile(filePath, null, hash);
      t.is(uploadResponse.status, 200, "Upload should succeed");
      t.falsy(uploadResponse.data.converted, "Upload response should NOT contain converted info for .txt files");

      uploadedUrl = uploadResponse.data.url;
      t.is(getFileExtensionFromUrl(uploadedUrl), '.txt', "Original URL should point to .txt file");

      // 2. Give Redis a moment to persist
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 3. Check hash to get short-lived URL
      const checkResponse = await axios.get(baseUrl, {
        params: { hash, checkHash: true },
        validateStatus: (status) => true,
        timeout: 30000,
      });

      t.is(checkResponse.status, 200, "checkHash should succeed");
      t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
      t.falsy(checkResponse.data.converted, "Response should NOT include converted info for .txt files");

      // 4. CRITICAL TEST: Verify short-lived URL is based on original file when no conversion exists
      const shortLivedUrlBase = checkResponse.data.shortLivedUrl.split('?')[0]; // Remove query params
      const originalUrlBase = checkResponse.data.url.split('?')[0]; // Remove query params

      // The short-lived URL should be based on the original file URL
      t.is(
        shortLivedUrlBase,
        originalUrlBase,
        "Short-lived URL should be based on original file URL when no conversion exists"
      );

      // Verify the short-lived URL points to the text file
      t.true(
        checkResponse.data.shortLivedUrl.includes('.txt'),
        "Short-lived URL should point to .txt file (original)"
      );

    } finally {
      // Clean up
      fs.unlinkSync(filePath);
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  },
);