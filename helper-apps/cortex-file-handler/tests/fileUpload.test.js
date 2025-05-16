import test from 'ava';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import FormData from 'form-data';
import { port } from '../start.js';
import { gcs } from '../blobHandler.js';
import { cleanupHashAndFile } from './testUtils.helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// Helper function to determine if GCS is configured
function isGCSConfigured() {
    return (
        process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 ||
        process.env.GCP_SERVICE_ACCOUNT_KEY
    );
}

// Helper function to create test files
async function createTestFile(content, extension) {
    const testDir = path.join(__dirname, 'test-files');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }
    const filename = path.join(testDir, `${uuidv4()}.${extension}`);
    fs.writeFileSync(filename, content);
    return filename;
}

// Helper function to upload file
async function uploadFile(filePath, requestId = null, hash = null) {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    if (requestId) form.append('requestId', requestId);
    if (hash) form.append('hash', hash);

    const response = await axios.post(baseUrl, form, {
        headers: {
            ...form.getHeaders(),
            'Content-Type': 'multipart/form-data',
        },
        validateStatus: (status) => true,
        timeout: 5000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    return response;
}

// Helper function to verify GCS file
async function verifyGCSFile(gcsUrl) {
    if (!isGCSConfigured() || !gcs) return true;
    
    try {
        const bucket = gcsUrl.split('/')[2];
        const filename = gcsUrl.split('/').slice(3).join('/');
        const [exists] = await gcs.bucket(bucket).file(filename).exists();
        return exists;
    } catch (error) {
        console.error('Error verifying GCS file:', error);
        return false;
    }
}

// Helper function to fetch file content from a URL
async function fetchFileContent(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
}

// Setup: Create test directory
test.before(async (t) => {
    const testDir = path.join(__dirname, 'test-files');
    await fs.promises.mkdir(testDir, { recursive: true });
    t.context = { testDir };
});

// Cleanup
test.after.always(async (t) => {
    await fs.promises.rm(t.context.testDir, { recursive: true, force: true });
});

// Basic File Upload Tests
test.serial('should handle basic file upload', async (t) => {
    const fileContent = 'test content';
    const filePath = await createTestFile(fileContent, 'txt');
    const requestId = uuidv4();
    
    try {
        const response = await uploadFile(filePath, requestId);
        
        t.is(response.status, 200);
        t.truthy(response.data.url);
        t.truthy(response.data.filename);

        // Verify file content matches
        const uploadedContent = await fetchFileContent(response.data.url);
        t.deepEqual(uploadedContent, Buffer.from(fileContent), 'Uploaded file content should match');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test.serial('should handle file upload with hash', async (t) => {
    const fileContent = 'test content';
    const filePath = await createTestFile(fileContent, 'txt');
    const requestId = uuidv4();
    const hash = 'test-hash-' + uuidv4();
    let uploadedUrl;
    let convertedUrl;
    try {
        // First upload the file
        const response = await uploadFile(filePath, requestId, hash);
        t.is(response.status, 200);
        t.truthy(response.data.url);
        uploadedUrl = response.data.url;
        if (response.data.converted && response.data.converted.url) {
            convertedUrl = response.data.converted.url;
        }
        console.log('Upload hash response.data', response.data)
        
        // Wait for Redis operations to complete and verify storage
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const checkResponse = await axios.get(baseUrl, {
            params: {
                hash,
                checkHash: true,
            },
            validateStatus: (status) => true,
        });
        console.log('Upload hash checkResponse', checkResponse)
        if (checkResponse.status !== 200) {
            // Only log if not 200
            console.error('Hash check failed:', {
                status: checkResponse.status,
                data: checkResponse.data
            });
        }
        // Hash should exist since we just uploaded it
        t.is(checkResponse.status, 200);
        t.truthy(checkResponse.data.hash);
        
        // Verify file exists and content matches
        const fileResponse = await axios.get(response.data.url, { responseType: 'arraybuffer' });
        t.is(fileResponse.status, 200);
        t.deepEqual(Buffer.from(fileResponse.data), Buffer.from(fileContent), 'Uploaded file content should match');
    } finally {
        fs.unlinkSync(filePath);
        await cleanupHashAndFile(hash, uploadedUrl, baseUrl);
        if (convertedUrl) {
            await cleanupHashAndFile(`${hash}_converted`, convertedUrl, baseUrl);
        }
    }
});

// Document Processing Tests
test.serial('should handle PDF document upload and conversion', async (t) => {
    // Create a simple PDF file
    const fileContent = '%PDF-1.4\nTest PDF content';
    const filePath = await createTestFile(fileContent, 'pdf');
    const requestId = uuidv4();
    
    try {
        const response = await uploadFile(filePath, requestId);
        t.is(response.status, 200);
        t.truthy(response.data.url);

        // Verify original PDF content matches
        const uploadedContent = await fetchFileContent(response.data.url);
        t.deepEqual(uploadedContent, Buffer.from(fileContent), 'Uploaded PDF content should match');
        
        // Check if converted version exists
        if (response.data.converted) {
            t.truthy(response.data.converted.url);
            const convertedResponse = await axios.get(response.data.converted.url, { responseType: 'arraybuffer' });
            t.is(convertedResponse.status, 200);
            // For conversion, just check non-empty
            t.true(Buffer.from(convertedResponse.data).length > 0, 'Converted file should not be empty');
        }
    } finally {
        fs.unlinkSync(filePath);
    }
});

// Media Chunking Tests
test.serial('should handle media file chunking', async (t) => {
    // Create a large test file to trigger chunking
    const chunkContent = 'x'.repeat(1024 * 1024);
    const filePath = await createTestFile(chunkContent, 'mp4');
    const requestId = uuidv4();
    
    try {
        const response = await uploadFile(filePath, requestId);
        t.is(response.status, 200);
        t.truthy(response.data);
        
        // For media files, we expect either an array of chunks or a single URL
        if (Array.isArray(response.data)) {
            t.true(response.data.length > 0);
            
            // Verify each chunk
            for (const chunk of response.data) {
                t.truthy(chunk.uri);
                t.truthy(chunk.offset);
                
                // Verify chunk exists and content matches
                const chunkResponse = await axios.get(chunk.uri, { responseType: 'arraybuffer' });
                t.is(chunkResponse.status, 200);
                // Each chunk should be a slice of the original content
                const expectedChunk = Buffer.from(chunkContent).slice(chunk.offset, chunk.offset + chunk.length || undefined);
                t.deepEqual(Buffer.from(chunkResponse.data), expectedChunk, 'Chunk content should match original');
                
                // If GCS is configured, verify backup
                if (isGCSConfigured() && chunk.gcs) {
                    const exists = await verifyGCSFile(chunk.gcs);
                    t.true(exists, 'GCS chunk should exist');
                }
            }
        } else {
            // Single file response
            t.truthy(response.data.url);
            const fileResponse = await axios.get(response.data.url, { responseType: 'arraybuffer' });
            t.is(fileResponse.status, 200);
            t.deepEqual(Buffer.from(fileResponse.data), Buffer.from(chunkContent), 'Uploaded file content should match');
        }
    } finally {
        fs.unlinkSync(filePath);
    }
});

// Error Handling Tests
test.serial('should handle invalid file upload', async (t) => {
    const requestId = uuidv4();
    const form = new FormData();
    // Send a file with no name and no content
    form.append('file', Buffer.from(''), { filename: '' });
    form.append('requestId', requestId);
    
    const response = await axios.post(baseUrl, form, {
        headers: {
            ...form.getHeaders(),
            'Content-Type': 'multipart/form-data',
        },
        validateStatus: (status) => true,
        timeout: 5000,
    });
    
    // Log the response for debugging
    console.log('Invalid file upload response:', {
        status: response.status,
        data: response.data
    });
    
    t.is(response.status, 400, 'Should reject invalid file with 400 status');
    t.is(response.data, 'Invalid file: missing filename', 'Should return correct error message');
});

// Cleanup Tests
test.serial('should handle file deletion', async (t) => {
    const filePath = await createTestFile('test content', 'txt');
    const requestId = uuidv4();
    
    try {
        // Upload file
        const uploadResponse = await uploadFile(filePath, requestId);
        t.is(uploadResponse.status, 200);
        
        // Wait a moment for file to be fully written
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Extract the file identifier from the URL
        const fileUrl = new URL(uploadResponse.data.url);
        const fileIdentifier = fileUrl.pathname.split('/').pop().split('_')[0];
        console.log('File identifier for deletion:', fileIdentifier);
        
        // Delete file using the correct identifier
        const deleteUrl = `${baseUrl}?operation=delete&requestId=${fileIdentifier}`;
        console.log('Deleting file with URL:', deleteUrl);
        const deleteResponse = await axios.delete(deleteUrl);
        t.is(deleteResponse.status, 200);
        
        // Wait a moment for deletion to complete
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Verify file is gone
        const verifyResponse = await axios.get(uploadResponse.data.url, {
            validateStatus: (status) => true,
        });
        t.is(verifyResponse.status, 404, 'File should be deleted');
        
        // If GCS is configured, verify backup is gone
        if (isGCSConfigured() && uploadResponse.data.gcs) {
            const exists = await verifyGCSFile(uploadResponse.data.gcs);
            t.false(exists, 'GCS file should be deleted');
        }
    } finally {
        fs.unlinkSync(filePath);
    }
});

// Save Option Test
test.serial('should handle document upload with save option', async (t) => {
    const fileContent = 'Sample DOCX content';
    const filePath = await createTestFile(fileContent, 'docx');

    const initialRequestId = uuidv4();
    const saveRequestId = uuidv4();

    let uploadedUrl;

    try {
        // First, upload the document so we have a publicly reachable URL
        const uploadResponse = await uploadFile(filePath, initialRequestId);
        t.is(uploadResponse.status, 200);
        t.truthy(uploadResponse.data.url, 'Upload should return a URL');

        uploadedUrl = uploadResponse.data.url;

        // Now call the handler again with the save flag
        const saveResponse = await axios.get(baseUrl, {
            params: {
                uri: uploadedUrl,
                requestId: saveRequestId,
                save: true,
            },
            validateStatus: (status) => true,
        });

        // The current implementation returns an empty array but should still be 200
        t.is(saveResponse.status, 200, 'Save request should succeed');
        t.true(Array.isArray(saveResponse.data), 'Response body should be an array');
    } finally {
        fs.unlinkSync(filePath);

        // Cleanup the initially uploaded file
        if (uploadedUrl) {
            const identifier = new URL(uploadedUrl).pathname.split('/').pop().split('_')[0];
            await axios.delete(`${baseUrl}?operation=delete&requestId=${identifier}`).catch(() => {});
        }

        // Cleanup files created by save request
        await axios.delete(`${baseUrl}?operation=delete&requestId=${saveRequestId}`).catch(() => {});
    }
}); 