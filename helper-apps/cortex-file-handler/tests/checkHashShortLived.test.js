import fs from "fs";
import os from "os";
import path from "path";
import test from "ava";
import axios from "axios";
import FormData from "form-data";
import { v4 as uuidv4 } from "uuid";

import { port } from "../src/start.js";
import {
  cleanupHashAndFile,
} from "./testUtils.helper.js";

const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to determine if Azure is configured
function isAzureConfigured() {
  return (
    process.env.AZURE_STORAGE_CONNECTION_STRING &&
    process.env.AZURE_STORAGE_CONNECTION_STRING.trim() !== ""
  );
}

// Helper function to create a test file
async function createTestFile(content = "Test content for short-lived URL testing") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
  const filePath = path.join(tmpDir, "test.txt");
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Helper function to upload a file and get response
async function uploadTestFile(filePath, customHash = null) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("requestId", uuidv4());
  form.append("save", "true");
  
  if (customHash) {
    form.append("hash", customHash);
  }

  const response = await axios.post(baseUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Type": "multipart/form-data",
    },
    validateStatus: () => true,
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return response;
}

test.serial("checkHash should always return shortLivedUrl", async (t) => {
  const filePath = await createTestFile("Content for shortLivedUrl test");
  const hash = `test-shortlived-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check hash - should always return shortLivedUrl now
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: () => true,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data, "Response should have data");
    
    // Verify short-lived URL fields are present
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.truthy(checkResponse.data.expiresInMinutes, "Response should include expiresInMinutes");
    t.is(checkResponse.data.expiresInMinutes, 5, "Default expiration should be 5 minutes");
    
    // Verify shortLivedUrl behavior based on storage provider
    if (isAzureConfigured()) {
      // With Azure, shortLivedUrl should be different from original URL
      t.not(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With Azure storage, shortLivedUrl should be different from original URL"
      );
    } else {
      // With LocalStorage, shortLivedUrl equals original URL (fallback behavior)
      t.is(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With LocalStorage provider, shortLivedUrl should equal original URL (fallback behavior)"
      );
    }
    
    // Verify both URLs point to the same base file
    const originalUrlBase = checkResponse.data.url.split('?')[0];
    const shortLivedUrlBase = checkResponse.data.shortLivedUrl.split('?')[0];
    t.is(originalUrlBase, shortLivedUrlBase, "Base URLs should be the same");
    
    // Verify original response fields are still present
    t.truthy(checkResponse.data.hash, "Response should include hash");
    t.truthy(checkResponse.data.filename, "Response should include filename");
    t.truthy(checkResponse.data.url, "Response should include original url");
    t.truthy(checkResponse.data.timestamp, "Response should include timestamp");

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});

test.serial("checkHash should respect custom shortLivedMinutes parameter", async (t) => {
  const filePath = await createTestFile("Content for custom expiration test");
  const hash = `test-custom-expire-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    t.is(uploadResponse.data.hash, hash, "Upload should return the correct hash");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check hash with custom expiration time
    const customMinutes = 15;
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
        shortLivedMinutes: customMinutes,
      },
      validateStatus: () => true,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.is(
      checkResponse.data.expiresInMinutes,
      customMinutes,
      `Expiration should be ${customMinutes} minutes`
    );

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});

test.serial("checkHash should handle invalid shortLivedMinutes parameter gracefully", async (t) => {
  const filePath = await createTestFile("Content for invalid expiration test");
  const hash = `test-invalid-expire-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check hash with invalid expiration time (should default to 5)
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
        shortLivedMinutes: "invalid",
      },
      validateStatus: () => true,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed even with invalid shortLivedMinutes");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.is(
      checkResponse.data.expiresInMinutes,
      5,
      "Should default to 5 minutes for invalid input"
    );

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});

test.serial("checkHash shortLivedUrl should be accessible", async (t) => {
  const filePath = await createTestFile("Content for URL accessibility test");
  const hash = `test-url-access-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check hash to get shortLivedUrl
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: () => true,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");

    // Verify the shortLivedUrl is accessible  
    // Note: Azurite (development storage) has limitations with SAS token validation
    // that may cause 403 errors even with valid tokens. This is a known testing limitation.
    if (isAzureConfigured() && !checkResponse.data.shortLivedUrl.includes('devstoreaccount1')) {
      // Only test URL accessibility with real Azure storage
      const fileResponse = await axios.get(checkResponse.data.shortLivedUrl, {
        responseType: "text",
        timeout: 10000,
        validateStatus: () => true,
      });
      
      t.is(fileResponse.status, 200, "shortLivedUrl should be accessible with real Azure storage");
      t.is(fileResponse.data, "Content for URL accessibility test", "File content should match");
    } else {
      // Skip URL accessibility test for Azurite/LocalStorage due to known limitations
      t.pass("Skipping URL accessibility test for development storage (Azurite has SAS token limitations)");
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});

test.serial("checkHash should return consistent response structure", async (t) => {
  const filePath = await createTestFile("Content for response structure test");
  const hash = `test-response-structure-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check hash multiple times to ensure consistent structure
    const checkResponse1 = await axios.get(baseUrl, {
      params: { hash, checkHash: true },
      validateStatus: () => true,
    });

    const checkResponse2 = await axios.get(baseUrl, {
      params: { hash, checkHash: true, shortLivedMinutes: 10 },
      validateStatus: () => true,
    });

    // Both responses should have the same structure
    const requiredFields = [
      'message', 'filename', 'url', 'hash', 'timestamp', 
      'shortLivedUrl', 'expiresInMinutes'
    ];

    requiredFields.forEach(field => {
      t.truthy(checkResponse1.data[field], `First response should have ${field}`);
      t.truthy(checkResponse2.data[field], `Second response should have ${field}`);
    });

    // expiresInMinutes should be different
    t.is(checkResponse1.data.expiresInMinutes, 5, "First response should have 5 minutes");
    t.is(checkResponse2.data.expiresInMinutes, 10, "Second response should have 10 minutes");

    // shortLivedUrl behavior depends on storage provider
    if (isAzureConfigured()) {
      // With Azure, different expiration times should generate different URLs
      t.not(
        checkResponse1.data.shortLivedUrl,
        checkResponse2.data.shortLivedUrl,
        "With Azure storage, shortLivedUrls with different expiration should be different"
      );
    } else {
      // With LocalStorage, URLs are the same (no SAS tokens)
      t.is(
        checkResponse1.data.shortLivedUrl,
        checkResponse2.data.shortLivedUrl,
        "With LocalStorage provider, shortLivedUrls are the same regardless of expiration time"
      );
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});

test.serial("checkHash should handle fallback when SAS token generation is not supported", async (t) => {
  const filePath = await createTestFile("Content for fallback behavior test");
  const hash = `test-fallback-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check hash
    const checkResponse = await axios.get(baseUrl, {
      params: {
        hash,
        checkHash: true,
      },
      validateStatus: () => true,
    });

    t.is(checkResponse.status, 200, "checkHash should succeed");
    t.truthy(checkResponse.data.shortLivedUrl, "Response should include shortLivedUrl");
    t.truthy(checkResponse.data.expiresInMinutes, "Response should include expiresInMinutes");

    if (isAzureConfigured()) {
      // When Azure is configured, shortLivedUrl should be different from original URL
      t.not(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With Azure storage, shortLivedUrl should be different from original URL"
      );
      
      // Should contain SAS token parameters
      t.true(
        checkResponse.data.shortLivedUrl.includes('?'),
        "Azure shortLivedUrl should contain query parameters"
      );
    } else {
      // When using LocalStorageProvider (fallback), shortLivedUrl should equal original URL
      t.is(
        checkResponse.data.shortLivedUrl,
        checkResponse.data.url,
        "With LocalStorage provider, shortLivedUrl should equal original URL (fallback behavior)"
      );
    }

    // Verify the shortLivedUrl is accessible regardless of storage provider
    // Note: Azurite (development storage) has limitations with SAS token validation
    if (isAzureConfigured() && !checkResponse.data.shortLivedUrl.includes('devstoreaccount1')) {
      // Only test URL accessibility with real Azure storage
      const fileResponse = await axios.get(checkResponse.data.shortLivedUrl, {
        responseType: "text",
        timeout: 10000,
        validateStatus: () => true,
      });

      t.is(fileResponse.status, 200, "shortLivedUrl should be accessible with real Azure storage");
      t.is(fileResponse.data, "Content for fallback behavior test", "File content should match");
    } else {
      // Skip URL accessibility test for Azurite/LocalStorage due to known limitations
      t.pass("Skipping URL accessibility test for development storage (Azurite has SAS token limitations)");
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});

test.serial("checkHash should maintain consistent behavior across multiple calls", async (t) => {
  const filePath = await createTestFile("Content for consistency test");
  const hash = `test-consistency-${uuidv4()}`;
  let uploadedUrl = null;

  try {
    // Upload file
    const uploadResponse = await uploadTestFile(filePath, hash);
    t.is(uploadResponse.status, 200, "File upload should succeed");
    uploadedUrl = uploadResponse.data.url;

    // Wait for Redis operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Make multiple checkHash calls
    const responses = [];
    for (let i = 0; i < 3; i++) {
      const checkResponse = await axios.get(baseUrl, {
        params: {
          hash,
          checkHash: true,
        },
        validateStatus: () => true,
      });
      
      t.is(checkResponse.status, 200, `checkHash call ${i + 1} should succeed`);
      responses.push(checkResponse.data);
      
      // Small delay between calls to ensure different timestamps (1 second for SAS tokens)
      await new Promise(resolve => setTimeout(resolve, 1100));
    }

    // Verify all responses have required fields
    responses.forEach((response, index) => {
      t.truthy(response.shortLivedUrl, `Response ${index + 1} should have shortLivedUrl`);
      t.truthy(response.expiresInMinutes, `Response ${index + 1} should have expiresInMinutes`);
      t.is(response.hash, hash, `Response ${index + 1} should have correct hash`);
      t.is(response.expiresInMinutes, 5, `Response ${index + 1} should have default expiration`);
    });

    // If using Azure, each call should generate a new short-lived URL
    if (isAzureConfigured()) {
      // All shortLivedUrls should be different (new SAS tokens each time)
      const shortLivedUrls = responses.map(r => r.shortLivedUrl);
      const uniqueUrls = new Set(shortLivedUrls);
      t.is(uniqueUrls.size, shortLivedUrls.length, "Each call should generate unique short-lived URL with Azure");
    }

  } finally {
    fs.unlinkSync(filePath);
    if (uploadedUrl) {
      await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
    }
  }
});