// Set test environment
process.env.NODE_ENV = 'test';

// Mock environment variables
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'test-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
process.env.S3_BUCKET_NAME = 'test-bucket';
