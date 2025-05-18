import test from 'ava';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GCSStorageProvider } from '../../src/services/storage/GCSStorageProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.before(() => {
    // Ensure we have the required environment variables
    if (!process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 && !process.env.GCP_SERVICE_ACCOUNT_KEY) {
        console.warn('Skipping GCS tests - GCP credentials not set');
    }
});

test('should create provider with valid credentials', (t) => {
    if (!process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 && !process.env.GCP_SERVICE_ACCOUNT_KEY) {
        t.pass('Skipping test - GCS not configured');
        return;
    }

    const credentials = {
        project_id: 'test-project',
        client_email: 'test@test.com',
        private_key: 'test-key'
    };

    const provider = new GCSStorageProvider(credentials, 'test-bucket');
    t.truthy(provider);
});

test('should throw error with missing credentials', (t) => {
    t.throws(() => {
        new GCSStorageProvider(null, 'test-bucket');
    }, { message: 'Missing GCS credentials or bucket name' });
});

test('should upload and delete file', async (t) => {
    if (!process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 && !process.env.GCP_SERVICE_ACCOUNT_KEY) {
        t.pass('Skipping test - GCS not configured');
        return;
    }

    const credentials = JSON.parse(
        process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
            ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString()
            : process.env.GCP_SERVICE_ACCOUNT_KEY
    );

    const provider = new GCSStorageProvider(
        credentials,
        process.env.GCS_BUCKETNAME || 'cortextempfiles'
    );

    // Create test file
    const testContent = 'Hello World!';
    const testFile = path.join(__dirname, 'test.txt');
    fs.writeFileSync(testFile, testContent);

    try {
        // Upload file
        const requestId = 'test-upload';
        const result = await provider.uploadFile({}, testFile, requestId);
        
        t.truthy(result.url);
        t.truthy(result.blobName);
        t.true(result.url.startsWith('gs://'));
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

test('should handle file download', async (t) => {
    if (!process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 && !process.env.GCP_SERVICE_ACCOUNT_KEY) {
        t.pass('Skipping test - GCS not configured');
        return;
    }

    const credentials = JSON.parse(
        process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
            ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString()
            : process.env.GCP_SERVICE_ACCOUNT_KEY
    );

    const provider = new GCSStorageProvider(
        credentials,
        process.env.GCS_BUCKETNAME || 'cortextempfiles'
    );

    // Create test file
    const testContent = 'Hello World!';
    const testFile = path.join(__dirname, 'test.txt');
    fs.writeFileSync(testFile, testContent);

    try {
        // Upload file
        const requestId = 'test-download';
        const result = await provider.uploadFile({}, testFile, requestId);

        // Download to new location
        const downloadPath = path.join(__dirname, 'downloaded.txt');
        await provider.downloadFile(result.url, downloadPath);

        // Verify content
        const downloadedContent = fs.readFileSync(downloadPath, 'utf8');
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

test('should handle file existence check with spaces and special characters', async (t) => {
    if (!process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 && !process.env.GCP_SERVICE_ACCOUNT_KEY) {
        t.pass('Skipping test - GCS not configured');
        return;
    }

    const credentials = JSON.parse(
        process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64
            ? Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString()
            : process.env.GCP_SERVICE_ACCOUNT_KEY
    );

    const provider = new GCSStorageProvider(
        credentials,
        process.env.GCS_BUCKETNAME || 'cortextempfiles'
    );

    // Create test file with spaces and special characters in name
    const testContent = 'Hello World!';
    const testFileName = 'test file with spaces & special chars!.txt';
    const testFile = path.join(__dirname, testFileName);
    fs.writeFileSync(testFile, testContent);

    try {
        // Upload file
        const requestId = 'test-special-chars';
        const result = await provider.uploadFile({}, testFile, requestId);
        
        t.truthy(result.url);
        t.true(result.url.includes(testFileName));
        t.true(result.url.startsWith('gs://'));

        // Verify file exists with original URL
        const exists = await provider.fileExists(result.url);
        t.true(exists, 'File should exist with original URL');

        // Verify file exists with encoded URL
        const encodedUrl = result.url.replace(/ /g, '%20');
        const existsEncoded = await provider.fileExists(encodedUrl);
        t.true(existsEncoded, 'File should exist with encoded URL');

        // Cleanup
        await provider.deleteFiles(requestId);
        
        // Verify file is gone
        const existsAfterDelete = await provider.fileExists(result.url);
        t.false(existsAfterDelete, 'File should not exist after deletion');
    } finally {
        // Cleanup test file
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }
    }
}); 