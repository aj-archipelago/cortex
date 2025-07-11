import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';

// Create mock functions
const mockSend = vi.fn();
const mockS3Client = vi.fn();

// Mock AWS SDK modules
vi.mock('@aws-sdk/client-s3', () => {
    mockS3Client.mockImplementation(() => ({ send: mockSend }));
    return {
        S3Client: mockS3Client,
        PutObjectCommand: vi.fn(input => input),
        GetObjectCommand: vi.fn(input => input)
    };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: vi.fn(() => Promise.resolve('https://mock-signed-url.com'))
}));

// Mock s3Handler module
const mockGetManifest = vi.fn();
const mockUploadToS3 = vi.fn();
const mockSaveManifest = vi.fn();

vi.mock('../../s3Handler.js', () => ({
    getManifest: mockGetManifest,
    uploadToS3: mockUploadToS3,
    saveManifest: mockSaveManifest,
    resetS3Client: vi.fn()
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_FILES_DIR = path.join(__dirname, '..', 'test-files');

// Create test files directory if it doesn't exist
if (!fs.existsSync(TEST_FILES_DIR)) {
    fs.mkdirSync(TEST_FILES_DIR, { recursive: true });
}

// Create test files
const TEST_MOGRT_PATH = path.join(TEST_FILES_DIR, 'test.mogrt');
const TEST_PREVIEW_GIF_PATH = path.join(TEST_FILES_DIR, 'test.gif');
const TEST_PREVIEW_MP4_PATH = path.join(TEST_FILES_DIR, 'test.mp4');

fs.writeFileSync(TEST_MOGRT_PATH, 'test mogrt content');
fs.writeFileSync(TEST_PREVIEW_GIF_PATH, 'test preview gif content');
fs.writeFileSync(TEST_PREVIEW_MP4_PATH, 'test preview mp4 content');

describe('MOGRT Handler API Integration', () => {
    let app;

    beforeAll(async () => {
        vi.setTimeout(15000); // Increase timeout for async operations
        
        // Create express app
        app = express();
        
        // Set test AWS credentials
        process.env.AWS_ACCESS_KEY_ID = 'test-key';
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
        process.env.AWS_REGION = 'us-east-1';
        
        // Import and setup the handler
        const { default: MogrtHandler } = await import('../../index.js');
        app.all('/api/MogrtHandler', (req, res) => {
            const context = {
                log: vi.fn(),
                res: {}
            };
            
            MogrtHandler(context, req)
                .then(() => {
                    res.status(context.res.status || 200).json(context.res.body);
                })
                .catch(err => {
                    res.status(500).json({ error: err.message });
                });
        });
    });

    beforeEach(() => {
        vi.clearAllMocks();

        // Default successful responses
        mockGetManifest.mockImplementation(async (id) => ({
            id: id === 'master' ? 'test-id' : id,
            mogrtFile: 'test.mogrt',
            previewFile: 'test.gif',
            mogrtUrl: 'signed-url-1',
            previewUrl: 'signed-url-2'
        }));

        mockUploadToS3.mockImplementation((uploadId, fileData, filename) => {
            return Promise.resolve({
                key: `uploads/${uploadId}/${filename}`,
                location: `https://test-bucket.s3.amazonaws.com/uploads/${uploadId}/${filename}`
            });
        });

        mockSaveManifest.mockResolvedValue();
    });

    describe('GET /api/MogrtHandler', () => {
        it('should return master manifest', async () => {
            const response = await request(app)
                .get('/api/MogrtHandler')
                .expect('Content-Type', /json/)
                .expect(200);

            expect(mockGetManifest).toHaveBeenCalledWith('master');
            expect(response.body).toEqual(expect.objectContaining({
                id: 'test-id',
                mogrtUrl: 'signed-url-1',
                previewUrl: 'signed-url-2'
            }));
        });

        it('should return specific manifest when manifestId provided', async () => {
            const response = await request(app)
                .get('/api/MogrtHandler?manifestId=specific-id')
                .expect('Content-Type', /json/)
                .expect(200);

            expect(mockGetManifest).toHaveBeenCalledWith('specific-id');
            expect(response.body).toEqual(expect.objectContaining({
                id: 'specific-id',
                mogrtUrl: 'signed-url-1',
                previewUrl: 'signed-url-2'
            }));
        });

        it('should handle manifest not found error', async () => {
            const error = new Error('Manifest not found');
            error.name = 'NoSuchKey';
            mockGetManifest.mockRejectedValueOnce(error);

            const response = await request(app)
                .get('/api/MogrtHandler?manifestId=non-existent')
                .expect('Content-Type', /json/)
                .expect(500);

            expect(response.body.error).toBe('Manifest not found');
        });
    });

    describe('POST /api/MogrtHandler', () => {
        test('should upload MOGRT and GIF preview files', async () => {
            mockUploadToS3.mockResolvedValue({ key: 'test-key' });
            mockSaveManifest.mockResolvedValue({});

            const response = await request(app)
                .post('/api/MogrtHandler')
                .attach('mogrt', TEST_MOGRT_PATH)
                .attach('preview', TEST_PREVIEW_GIF_PATH)
                .expect(200);

            expect(mockUploadToS3).toHaveBeenCalledTimes(2);
            expect(mockSaveManifest).toHaveBeenCalled();
        });

        test('should upload MOGRT and MP4 preview files', async () => {
            mockUploadToS3.mockResolvedValue({ key: 'test-key' });
            mockSaveManifest.mockResolvedValue({});

            const response = await request(app)
                .post('/api/MogrtHandler')
                .attach('mogrt', TEST_MOGRT_PATH)
                .attach('preview', TEST_PREVIEW_MP4_PATH)
                .expect(200);

            expect(mockUploadToS3).toHaveBeenCalledTimes(2);
            expect(mockSaveManifest).toHaveBeenCalled();
        });

        test('should reject invalid preview file type', async () => {
            const TEST_INVALID_PATH = path.join(TEST_FILES_DIR, 'test.txt');
            fs.writeFileSync(TEST_INVALID_PATH, 'invalid content');

            const response = await request(app)
                .post('/api/MogrtHandler')
                .attach('mogrt', TEST_MOGRT_PATH)
                .attach('preview', TEST_INVALID_PATH)
                .expect(400);

            expect(response.body.error).toContain('Invalid file type');
            fs.unlinkSync(TEST_INVALID_PATH);
        });

        it('should reject upload with missing files', async () => {
            const response = await request(app)
                .post('/api/MogrtHandler')
                .attach('mogrt', TEST_MOGRT_PATH)
                .expect('Content-Type', /json/)
                .expect(500);

            expect(response.body.error).toMatch(/required/i);
        });
    });

    describe('API Documentation', () => {
        test('GET /docs should serve Swagger UI', async () => {
            const response = await request(app)
                .get('/docs')
                .expect('Content-Type', /html/)
                .expect(200);
            
            // Swagger UI HTML should contain these key elements
            expect(response.text).toContain('swagger-ui');
            expect(response.text).toContain('MOGRT Handler API');
        });
    });

    afterAll(() => {
        // Clean up test files
        fs.unlinkSync(TEST_MOGRT_PATH);
        fs.unlinkSync(TEST_PREVIEW_GIF_PATH);
        fs.unlinkSync(TEST_PREVIEW_MP4_PATH);
        fs.rmdirSync(TEST_FILES_DIR);
    });
});
