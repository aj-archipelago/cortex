import test from 'ava';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AzureStorageProvider } from '../../src/services/storage/AzureStorageProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.before(() => {
    // Ensure we have the required environment variables
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
        console.warn('Skipping Azure tests - AZURE_STORAGE_CONNECTION_STRING not set');
    }
});

test('should create provider with valid credentials', (t) => {
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
        t.pass('Skipping test - Azure not configured');
        return;
    }

    const provider = new AzureStorageProvider(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
        'test-container'
    );
    t.truthy(provider);
});

test('should throw error with missing credentials', (t) => {
    t.throws(() => {
        new AzureStorageProvider(null, 'test-container');
    }, { message: 'Missing Azure Storage connection string or container name' });
});

test('should upload and delete file', async (t) => {
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
        t.pass('Skipping test - Azure not configured');
        return;
    }

    const provider = new AzureStorageProvider(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
        'test-container'
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
        t.true(result.url.includes('test-container'));
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
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
        t.pass('Skipping test - Azure not configured');
        return;
    }

    const provider = new AzureStorageProvider(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
        'test-container'
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