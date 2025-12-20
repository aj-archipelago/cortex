// shortLivedUrl.test.js
// Unit tests for short-lived URL functionality

import test from 'ava';
import sinon from 'sinon';
import { checkHashExists, ensureShortLivedUrl } from '../../../lib/fileUtils.js';
import { axios } from '../../../lib/requestExecutor.js';

test.beforeEach(t => {
    t.context.sandbox = sinon.createSandbox();
});

test.afterEach.always(t => {
    t.context.sandbox.restore();
});

test('checkHashExists should return shortLivedUrl when available', async t => {
    const hash = 'test-hash-123';
    const fileHandlerUrl = 'https://file-handler.example.com';
    const mockResponse = {
        status: 200,
        data: {
            url: 'https://storage.example.com/file.pdf?sv=2023-11-03&se=2025-01-01T00:00:00Z&sig=long-lived',
            shortLivedUrl: 'https://storage.example.com/file.pdf?sv=2023-11-03&se=2024-01-01T10:15:00Z&sig=short-lived',
            gcs: 'gs://bucket/file.pdf',
            hash: hash,
            filename: 'file.pdf'
        }
    };

    const axiosGetStub = t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    const result = await checkHashExists(hash, fileHandlerUrl);

    t.truthy(result);
    t.is(result.url, mockResponse.data.shortLivedUrl, 'Should return shortLivedUrl');
    t.is(result.gcs, mockResponse.data.gcs, 'Should return GCS URL');
    t.is(result.hash, hash, 'Should return hash');

    // Verify axios was called with correct parameters
    t.true(axiosGetStub.calledOnce);
    const callArgs = axiosGetStub.getCall(0).args;
    t.true(callArgs[0].includes('checkHash=true'));
    t.true(callArgs[0].includes('shortLivedMinutes=5'));
});

test('checkHashExists should fallback to regular URL when shortLivedUrl not available', async t => {
    const hash = 'test-hash-456';
    const fileHandlerUrl = 'https://file-handler.example.com';
    const mockResponse = {
        status: 200,
        data: {
            url: 'https://storage.example.com/file.pdf?sv=2023-11-03&se=2025-01-01T00:00:00Z&sig=long-lived',
            // No shortLivedUrl in response
            gcs: 'gs://bucket/file.pdf',
            hash: hash,
            filename: 'file.pdf'
        }
    };

    t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    const result = await checkHashExists(hash, fileHandlerUrl);

    t.truthy(result);
    t.is(result.url, mockResponse.data.url, 'Should fallback to regular URL');
    t.is(result.gcs, mockResponse.data.gcs, 'Should return GCS URL');
});

test('checkHashExists should prefer converted URL in shortLivedUrl', async t => {
    const hash = 'test-hash-789';
    const fileHandlerUrl = 'https://file-handler.example.com';
    const mockResponse = {
        status: 200,
        data: {
            url: 'https://storage.example.com/file.xlsx?sv=2023-11-03&se=2025-01-01T00:00:00Z&sig=long-lived',
            shortLivedUrl: 'https://storage.example.com/file.csv?sv=2023-11-03&se=2024-01-01T10:15:00Z&sig=short-lived',
            converted: {
                url: 'https://storage.example.com/file.csv?sv=2023-11-03&se=2025-01-01T00:00:00Z&sig=long-lived',
                gcs: 'gs://bucket/file.csv'
            },
            gcs: 'gs://bucket/file.xlsx',
            hash: hash
        }
    };

    t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    const result = await checkHashExists(hash, fileHandlerUrl);

    t.truthy(result);
    // shortLivedUrl should be based on converted file
    t.is(result.url, mockResponse.data.shortLivedUrl, 'Should use shortLivedUrl (which prefers converted)');
    // GCS should prefer converted
    t.is(result.gcs, mockResponse.data.converted.gcs, 'Should prefer converted GCS URL');
});

test('checkHashExists should return null when file not found', async t => {
    const hash = 'non-existent-hash';
    const fileHandlerUrl = 'https://file-handler.example.com';
    const mockResponse = {
        status: 404,
        data: { message: 'File not found' }
    };

    t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    const result = await checkHashExists(hash, fileHandlerUrl);

    t.is(result, null, 'Should return null when file not found');
});

test('checkHashExists should return null when hash or fileHandlerUrl missing', async t => {
    t.is(await checkHashExists(null, 'https://file-handler.example.com'), null);
    t.is(await checkHashExists('hash-123', null), null);
    t.is(await checkHashExists('', 'https://file-handler.example.com'), null);
});

test('checkHashExists should handle errors gracefully', async t => {
    const hash = 'test-hash-error';
    const fileHandlerUrl = 'https://file-handler.example.com';

    t.context.sandbox.replace(axios, 'get', sinon.stub().rejects(new Error('Network error')));

    const result = await checkHashExists(hash, fileHandlerUrl);

    t.is(result, null, 'Should return null on error');
});

test('ensureShortLivedUrl should resolve file to short-lived URL when hash available', async t => {
    const fileObject = {
        url: 'https://storage.example.com/file.pdf?sv=2023-11-03&se=2025-01-01T00:00:00Z&sig=long-lived',
        gcs: 'gs://bucket/file.pdf',
        hash: 'test-hash-123',
        filename: 'file.pdf'
    };
    const fileHandlerUrl = 'https://file-handler.example.com';
    const shortLivedUrl = 'https://storage.example.com/file.pdf?sv=2023-11-03&se=2024-01-01T10:15:00Z&sig=short-lived';

    const mockResponse = {
        status: 200,
        data: {
            url: fileObject.url,
            shortLivedUrl: shortLivedUrl,
            gcs: fileObject.gcs,
            hash: fileObject.hash
        }
    };

    t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    const result = await ensureShortLivedUrl(fileObject, fileHandlerUrl);

    t.truthy(result);
    t.is(result.url, shortLivedUrl, 'Should use short-lived URL');
    t.is(result.gcs, fileObject.gcs, 'Should preserve GCS URL');
    t.is(result.hash, fileObject.hash, 'Should preserve hash');
    t.is(result.filename, fileObject.filename, 'Should preserve filename');
});

test('ensureShortLivedUrl should return original object when no hash', async t => {
    const fileObject = {
        url: 'https://storage.example.com/file.pdf',
        filename: 'file.pdf'
        // No hash
    };
    const fileHandlerUrl = 'https://file-handler.example.com';

    const result = await ensureShortLivedUrl(fileObject, fileHandlerUrl);

    t.deepEqual(result, fileObject, 'Should return original object when no hash');
});

test('ensureShortLivedUrl should return original object when no fileHandlerUrl', async t => {
    const fileObject = {
        url: 'https://storage.example.com/file.pdf',
        hash: 'test-hash-123',
        filename: 'file.pdf'
    };

    const result = await ensureShortLivedUrl(fileObject, null);

    t.deepEqual(result, fileObject, 'Should return original object when no fileHandlerUrl');
});

test('ensureShortLivedUrl should fallback to original object on error', async t => {
    const fileObject = {
        url: 'https://storage.example.com/file.pdf',
        hash: 'test-hash-error',
        filename: 'file.pdf'
    };
    const fileHandlerUrl = 'https://file-handler.example.com';

    t.context.sandbox.replace(axios, 'get', sinon.stub().rejects(new Error('Network error')));

    const result = await ensureShortLivedUrl(fileObject, fileHandlerUrl);

    t.deepEqual(result, fileObject, 'Should fallback to original object on error');
});

test('ensureShortLivedUrl should update GCS URL from checkHash response', async t => {
    const fileObject = {
        url: 'https://storage.example.com/file.xlsx',
        gcs: 'gs://bucket/file.xlsx',
        hash: 'test-hash-789',
        filename: 'file.xlsx'
    };
    const fileHandlerUrl = 'https://file-handler.example.com';
    const convertedGcs = 'gs://bucket/file.csv';

    const mockResponse = {
        status: 200,
        data: {
            url: fileObject.url,
            shortLivedUrl: 'https://storage.example.com/file.csv?sv=2023-11-03&se=2024-01-01T10:15:00Z&sig=short-lived',
            converted: {
                gcs: convertedGcs
            },
            gcs: fileObject.gcs,
            hash: fileObject.hash
        }
    };

    t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    const result = await ensureShortLivedUrl(fileObject, fileHandlerUrl);

    t.truthy(result);
    t.is(result.gcs, convertedGcs, 'Should update GCS URL from converted');
});

test('ensureShortLivedUrl should respect shortLivedMinutes parameter', async t => {
    const fileObject = {
        url: 'https://storage.example.com/file.pdf',
        hash: 'test-hash-123',
        filename: 'file.pdf'
    };
    const fileHandlerUrl = 'https://file-handler.example.com';
    const shortLivedMinutes = 10;

    const mockResponse = {
        status: 200,
        data: {
            url: fileObject.url,
            shortLivedUrl: 'https://storage.example.com/file.pdf?sv=2023-11-03&se=2024-01-01T10:15:00Z&sig=short-lived',
            hash: fileObject.hash
        }
    };

    const axiosGetStub = t.context.sandbox.replace(axios, 'get', sinon.stub().resolves(mockResponse));

    await ensureShortLivedUrl(fileObject, fileHandlerUrl, null, shortLivedMinutes);

    // Verify axios was called with correct shortLivedMinutes
    const callArgs = axiosGetStub.getCall(0).args;
    t.true(callArgs[0].includes(`shortLivedMinutes=${shortLivedMinutes}`));
});
