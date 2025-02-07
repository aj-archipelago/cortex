import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';

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
    __esModule: true,
    getManifest: mockGetManifest,
    uploadToS3: mockUploadToS3,
    saveManifest: mockSaveManifest,
    resetS3Client: vi.fn()
}));
// Create a mock Busboy function
const mockBusboyFactory = vi.fn();

// Mock busboy module
vi.mock('busboy', () => mockBusboyFactory);

import MogrtHandler from '../../index.js';

describe('MogrtHandler', () => {
    let mockContext;
    let mockReq;

    beforeAll(() => {
        vi.setTimeout(15000); // Increase timeout for async operations
    });

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Reset AWS environment variables
        process.env.AWS_ACCESS_KEY_ID = 'test-key';
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
        process.env.AWS_REGION = 'us-east-1';
        
        mockContext = {
            log: vi.fn(),
            res: {}
        };
        
        mockReq = {
            headers: { 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundaryABC123' },
            query: {},
            method: 'GET',
            pipe: vi.fn(function(dest) { return dest; })
        };

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

        // Setup default Busboy mock behavior
        mockBusboyFactory.mockImplementation(() => {
            const mockBusboy = new Readable({
                read() {}
            });
            mockBusboy.on = vi.fn((event, callback) => {
                if (event === 'file') {
                    process.nextTick(() => {
                        const fileStream = new Readable({
                            read() {
                                this.push('test data');
                                this.push(null);
                            }
                        });
                        callback('mogrt', fileStream, { filename: 'test.mogrt' });
                        callback('preview', fileStream, { filename: 'test.gif' });
                        // Emit finish event after files are processed
                        mockBusboy.emit('finish');
                    });
                }
                return mockBusboy;
            });
            mockBusboy.emit = vi.fn((event) => {
                const listeners = mockBusboy.on.mock.calls
                    .filter(([e]) => e === event)
                    .map(([, callback]) => callback);
                listeners.forEach(callback => callback());
                return mockBusboy;
            });
            return mockBusboy;
        });
    });

    describe('GET requests', () => {
        it('should return master manifest when no manifestId provided', async () => {

            await MogrtHandler(mockContext, mockReq);

            expect(mockGetManifest).toHaveBeenCalledWith('master');
            expect(mockContext.res).toEqual({
                status: 200,
                body: expect.objectContaining({
                    id: 'test-id',
                    mogrtUrl: 'signed-url-1',
                    previewUrl: 'signed-url-2'
                })
            });
        });

        it('should return specific manifest when manifestId provided', async () => {
            mockReq.query.manifestId = 'specific-id';

            await MogrtHandler(mockContext, mockReq);

            expect(mockGetManifest).toHaveBeenCalledWith('specific-id');
            expect(mockContext.res).toEqual({
                status: 200,
                body: expect.objectContaining({
                    id: 'specific-id',
                    mogrtUrl: 'signed-url-1',
                    previewUrl: 'signed-url-2'
                })
            });
        });

        it('should handle manifest not found error', async () => {
            const error = new Error('Manifest not found');
            error.name = 'NoSuchKey';
            mockGetManifest.mockRejectedValueOnce(error);

            await MogrtHandler(mockContext, mockReq);

            expect(mockContext.res).toEqual({
                status: 500,
                body: {
                    error: 'Manifest not found'
                }
            });
        });
    });

    describe('POST requests', () => {
        beforeEach(() => {
            mockReq.method = 'POST';
        });

        it('should validate required files', async () => {
            await MogrtHandler(mockContext, mockReq);
            
            expect(mockReq.pipe).toHaveBeenCalled();
            expect(mockBusboyFactory).toHaveBeenCalledWith({
                headers: mockReq.headers
            });
        });

        it('should handle upload errors', async () => {
            const error = new Error('Upload failed');
            error.name = 'UploadError';
            mockUploadToS3.mockRejectedValueOnce(error);

            await MogrtHandler(mockContext, mockReq);

            expect(mockContext.res).toEqual({
                status: 500,
                body: {
                    error: 'Upload failed'
                }
            });
        });
    });

    describe('Invalid requests', () => {
        it('should reject unsupported methods', async () => {
            mockReq.method = 'PUT';
            await MogrtHandler(mockContext, mockReq);

            expect(mockContext.res).toEqual({
                status: 500,
                body: {
                    error: 'Method not allowed'
                }
            });
        });
    });
});
