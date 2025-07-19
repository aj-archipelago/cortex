import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock modules before importing anything else.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn()
}));
vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn()
}));

// Now import the functions.
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

// Optionally, set up the mock implementation.
// getSignedUrl.mockResolvedValue('mocked-signed-url');

const mockCallback = vi.fn(x => 42 + x);

describe('Sample test suite', () => {
  test('when sth do sth', async () => {
    getSignedUrl.mockReturnValue(1)
    console.log(getSignedUrl);
    console.log(mockCallback);
    const resp = await getSignedUrl({});
    expect(getSignedUrl).toHaveBeenCalled();
  });
});