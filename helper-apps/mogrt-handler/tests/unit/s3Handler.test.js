import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as s3Handler from '../../s3Handler.js';

// Mock S3Client module
vi.mock('@aws-sdk/client-s3', () => {
    const mockSend = vi.fn();
    const mockS3Client = vi.fn(() => ({
        send: mockSend
    }));
    return {
        S3Client: mockS3Client,
        PutObjectCommand: vi.fn(),
        GetObjectCommand: vi.fn()
    };
});

describe('s3Handler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        s3Handler.resetS3Client();
        
        // Reset AWS environment variables
        process.env.AWS_ACCESS_KEY_ID = 'test-key';
        process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
        process.env.AWS_REGION = 'us-east-1';
    });

    describe('getS3Client', () => {
        test('should create new S3Client instance when not initialized', () => {
            const client = s3Handler.getS3Client();
            expect(S3Client).toHaveBeenCalledWith({
                region: 'us-east-1'
            });
        });

        test('should reuse existing S3Client instance', () => {
            s3Handler.getS3Client();
            s3Handler.getS3Client();
            expect(S3Client).toHaveBeenCalledTimes(1);
        });

        test('should create new instance after reset', () => {
            s3Handler.getS3Client();
            s3Handler.resetS3Client();
            s3Handler.getS3Client();
            expect(S3Client).toHaveBeenCalledTimes(2);
        });

        test('should use AWS_REGION from environment when available', () => {
            process.env.AWS_REGION = 'eu-west-1';
            s3Handler.resetS3Client();
            s3Handler.getS3Client();
            expect(S3Client).toHaveBeenCalledWith({
                region: 'eu-west-1'
            });
        });
    });

    describe('uploadToS3', () => {
        test('should upload file to S3 successfully', async () => {
            const uploadId = 'test-uuid';
            const fileData = Buffer.from('test data');
            const filename = 'test.mogrt';

            await s3Handler.uploadToS3(uploadId, fileData, filename);

            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
            expect(PutObjectCommand).toHaveBeenCalledWith({
                Bucket: process.env.S3_BUCKET,
                Key: `${uploadId}/${filename}`,
                Body: fileData
            });
        });

        test('should handle stream input', async () => {
            const uploadId = 'test-uuid';
            const stream = new Readable();
            stream.push('test data');
            stream.push(null);
            const filename = 'test.mogrt';

            await s3Handler.uploadToS3(uploadId, stream, filename);

            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
            expect(PutObjectCommand).toHaveBeenCalledWith({
                Bucket: process.env.S3_BUCKET,
                Key: `${uploadId}/${filename}`,
                Body: stream
            });
        });
    });

    describe('getManifest', () => {
        beforeEach(() => {
            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            mockSend.mockImplementation(async (command) => {
                if (command instanceof GetObjectCommand && command.input.Key === 'master-manifest.json') {
                    return {
                        Body: {
                            transformToString: vi.fn().mockResolvedValue(JSON.stringify([
                                {
                                    id: 'existing-id',
                                    mogrtFile: 'existing.mogrt',
                                    previewFile: 'existing.gif'
                                }
                            ]))
                        }
                    };
                }
                return {};
            });
        });

        test('should return master manifest when manifestId is "master"', async () => {
            const result = await s3Handler.getManifest('master');

            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand));
            expect(result).toEqual([{
                id: 'existing-id',
                mogrtFile: 'existing.mogrt',
                previewFile: 'existing.gif'
            }]);
        });

        test('should return individual manifest with signed URLs', async () => {
            vi.mock('@aws-sdk/s3-request-presigner', () => ({
                getSignedUrl: vi.fn().mockResolvedValue('https://mock-signed-url.com')
            }));

            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            mockSend.mockImplementationOnce(async () => ({
                Body: {
                    transformToString: vi.fn().mockResolvedValue(JSON.stringify({
                        id: 'test-id',
                        mogrtFile: 'test.mogrt',
                        previewFile: 'test.gif'
                    }))
                }
            }));

            const result = await s3Handler.getManifest('test-id');

            expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand));
            expect(result).toEqual({
                id: 'test-id',
                mogrtFile: 'test.mogrt',
                previewFile: 'test.gif',
                mogrtUrl: 'https://mock-signed-url.com',
                previewUrl: 'https://mock-signed-url.com'
            });
        });

        test('should handle manifest not found error', async () => {
            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            mockSend.mockRejectedValueOnce({ name: 'NoSuchKey' });

            await expect(s3Handler.getManifest('non-existent')).rejects.toThrow('Manifest not found');
        });
    });

    describe('saveManifest', () => {
        test('should save individual manifest and update master manifest', async () => {
            const mockS3Client = vi.mocked(S3Client);
            const mockSend = vi.mocked(mockS3Client().send);
            mockSend.mockImplementationOnce(async () => ({
                Body: {
                    transformToString: vi.fn().mockResolvedValue(JSON.stringify([
                        {
                            id: 'existing-id',
                            mogrtFile: 'existing.mogrt',
                            previewFile: 'existing.gif'
                        }
                    ]))
                }
            })).mockResolvedValue({});

            const manifest = {
                id: 'new-test-id',
                mogrtFile: 'new-test.mogrt',
                previewFile: 'new-test.gif'
            };

            await s3Handler.saveManifest(manifest);

            expect(mockSend).toHaveBeenCalledTimes(3); // Get master, Put individual, Put master
            expect(PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
                Key: 'new-test-id/manifest.json',
                Body: JSON.stringify(manifest)
            }));
        });
    });
});
