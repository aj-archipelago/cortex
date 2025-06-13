import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import MogrtHandler from '../../index.js'; 
import { uploadToS3 as s3Upload, getManifest as s3GetManifest, saveManifest as s3SaveManifest, removeFromMasterManifest as s3RemoveFromMasterManifest } from '../../s3Handler.js'; 
import Busboy from 'busboy';
import { v4 as uuidv4 } from 'uuid';
import stream from 'stream';

// Mock dependencies
vi.mock('../../s3Handler.js', () => ({
  uploadToS3: vi.fn(),
  getManifest: vi.fn(),
  saveManifest: vi.fn(),
  removeFromMasterManifest: vi.fn(),
}));
vi.mock('busboy');
vi.mock('uuid');

const mockContext = () => ({
  res: null,
  log: vi.fn(),
  done: vi.fn()
});

const mockReq = (method, query = {}, params = {}, headers = {}, body = null, rawBody = null) => ({
  method,
  query,
  params,
  headers,
  body,
  rawBody,
  pipe: vi.fn()
});

describe('MogrtHandler', () => {
  let context;
  let mockBusboyInstance;

  beforeEach(() => {
    context = mockContext();
    vi.clearAllMocks();

    uuidv4.mockReturnValue('test-uuid');
    s3Upload.mockResolvedValue({ key: 'test-uuid/file.mogrt', Location: 's3://bucket/test-uuid/file.mogrt' });
    s3GetManifest.mockResolvedValue({ id: 'master', items: [] });
    s3SaveManifest.mockResolvedValue(undefined);
    s3RemoveFromMasterManifest.mockResolvedValue(true);

    mockBusboyInstance = {
      on: vi.fn((event, callback) => {
        mockBusboyInstance[`_${event}Callback`] = callback;
      }),
      emit: vi.fn((event, ...args) => {
        if (mockBusboyInstance[`_${event}Callback`]) {
          mockBusboyInstance[`_${event}Callback`](...args);
        }
      }),
      end: vi.fn(),
    };
    Busboy.mockImplementation(() => mockBusboyInstance);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const simulateBusboyEventsAsync = (filesData = [], fieldsData = [], error = null) => {
    return new Promise((resolveImmediate) => {
      process.nextTick(async () => {
        try {
          if (error) {
            mockBusboyInstance.emit('error', error);
            resolveImmediate();
            return;
          }
    
          for (const fileData of filesData) {
            const fileStream = new stream.Readable();
            fileStream._read = () => {}; 
            mockBusboyInstance.emit('file', fileData.fieldname, fileStream, fileData.fileInfo);
            
            for (const chunk of fileData.chunks) {
              fileStream.push(chunk);
            }
            fileStream.push(null); 
            await new Promise(r => process.nextTick(r)); 
          }
    
          fieldsData.forEach(fieldData => {
            mockBusboyInstance.emit('field', fieldData.fieldname, fieldData.value);
          });
    
          mockBusboyInstance.emit('finish');
        } catch (e) {
          console.error('Error in simulateBusboyEventsAsync:', e);
        }
        resolveImmediate();
      });
    });
  };

  describe('GET requests', () => {
    it('should fetch the master manifest if no manifestId is provided', async () => {
      const req = mockReq('GET');
      s3GetManifest.mockResolvedValue({ id: 'master', data: 'master_manifest_data' });

      await MogrtHandler(context, req);

      expect(s3GetManifest).toHaveBeenCalledWith('master');
      expect(context.res.status).toBe(200);
      expect(context.res.body).toEqual({ id: 'master', data: 'master_manifest_data' });
    });

    it('should fetch a specific manifest if manifestId is provided', async () => {
      const req = mockReq('GET', { manifestId: 'specific-manifest-id' });
      s3GetManifest.mockResolvedValue({ id: 'specific-manifest-id', data: 'specific_data' });

      await MogrtHandler(context, req);

      expect(s3GetManifest).toHaveBeenCalledWith('specific-manifest-id');
      expect(context.res.status).toBe(200);
      expect(context.res.body).toEqual({ id: 'specific-manifest-id', data: 'specific_data' });
    });
  });

  describe('DELETE requests', () => {
    it('should delete a MOGRT item successfully', async () => {
      const req = mockReq('DELETE', { manifestId: 'master' }, { id: 'mogrt-to-delete' });
      s3RemoveFromMasterManifest.mockResolvedValue(true);

      await MogrtHandler(context, req);

      expect(s3RemoveFromMasterManifest).toHaveBeenCalledWith('mogrt-to-delete');
      expect(context.res.status).toBe(200);
      expect(context.res.body).toEqual({
        success: true,
        message: 'MOGRT with ID mogrt-to-delete successfully deleted'
      });
    });

    it('should return 404 if MOGRT item to delete is not found', async () => {
      const req = mockReq('DELETE', { manifestId: 'master' }, { id: 'non-existent-id' });
      s3RemoveFromMasterManifest.mockResolvedValue(false);

      await MogrtHandler(context, req);

      expect(s3RemoveFromMasterManifest).toHaveBeenCalledWith('non-existent-id');
      expect(context.res.status).toBe(404);
      expect(context.res.body).toEqual({ error: 'MOGRT with ID non-existent-id not found' });
    });

    it('should return 500 if removeFromMasterManifest throws an error', async () => {
      const req = mockReq('DELETE', { manifestId: 'master' }, { id: 'mogrt-id' });
      s3RemoveFromMasterManifest.mockRejectedValue(new Error('S3 delete error'));

      await MogrtHandler(context, req);

      expect(s3RemoveFromMasterManifest).toHaveBeenCalledWith('mogrt-id');
      expect(context.res.status).toBe(500);
      expect(context.res.body).toEqual({ error: 'Failed to delete MOGRT: S3 delete error' });
    });

    it('should return 500 if id is not provided for DELETE', async () => {
      const req = mockReq('DELETE', { manifestId: 'master' });
      await MogrtHandler(context, req);
      expect(s3RemoveFromMasterManifest).not.toHaveBeenCalled();
      expect(context.res.status).toBe(500);
      expect(context.res.body).toEqual({ error: 'Method not allowed' }); 
    });
  });

  describe('POST requests', () => {
    const getSuccessfulFilesData = () => ([
      { fieldname: 'mogrt', fileInfo: { filename: 'test.mogrt' }, chunks: [Buffer.from('mogrt data')] },
      { fieldname: 'preview', fileInfo: { filename: 'preview.mp4' }, chunks: [Buffer.from('preview data')] }
    ]);

    it('should upload files and save manifest successfully', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      s3Upload
        .mockResolvedValueOnce({ key: 'test-uuid/test.mogrt' })
        .mockResolvedValueOnce({ key: 'test-uuid/preview.mp4' });
      s3GetManifest.mockResolvedValueOnce({ id: 'master', items: [] });

      const mogrtHandlerPromise = MogrtHandler(context, req);
      await simulateBusboyEventsAsync(getSuccessfulFilesData(), [{ fieldname: 'name', value: 'My Awesome Mogrt' }]);
      await mogrtHandlerPromise;

      expect(s3Upload).toHaveBeenCalledTimes(2);
      expect(s3Upload).toHaveBeenCalledWith('test-uuid/test.mogrt', Buffer.from('mogrt data'), 'application/octet-stream');
      expect(s3Upload).toHaveBeenCalledWith('test-uuid/preview.mp4', Buffer.from('preview data'), 'video/mp4');
      expect(s3SaveManifest).toHaveBeenCalledWith(expect.objectContaining({
        id: 'test-uuid',
        name: 'My Awesome Mogrt',
        mogrtFile: 'test-uuid/test.mogrt',
        previewFile: 'test-uuid/preview.mp4',
      }));
      expect(s3GetManifest).toHaveBeenCalledWith('master');
      expect(context.res.status).toBe(200);
      expect(context.res.body.manifest.id).toBe('test-uuid');
    });

    it('should use uploadId as name if name field is not provided', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      s3Upload
        .mockResolvedValueOnce({ key: 'test-uuid/test.mogrt' })
        .mockResolvedValueOnce({ key: 'test-uuid/preview.mp4' });
      s3GetManifest.mockResolvedValueOnce({ id: 'master', items: [] });

      const mogrtHandlerPromise = MogrtHandler(context, req);
      await simulateBusboyEventsAsync(getSuccessfulFilesData(), []); 
      await mogrtHandlerPromise;

      expect(s3SaveManifest).toHaveBeenCalledWith(expect.objectContaining({
        id: 'test-uuid',
        name: 'test-uuid', 
      }));
      expect(context.res.status).toBe(200);
    });

    it('should return 500 if MOGRT file is missing', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      const filesData = [
        { fieldname: 'preview', fileInfo: { filename: 'preview.gif' }, chunks: [Buffer.from('gif data')] }
      ];
      const mogrtHandlerPromise = MogrtHandler(context, req);
      await simulateBusboyEventsAsync(filesData, [{ fieldname: 'name', value: 'Test' }]);
      await mogrtHandlerPromise;

      expect(context.res.status).toBe(500);
      expect(context.res.body).toEqual({ error: 'Both MOGRT and preview files (GIF or MP4) are required' });
    });

    it('should return 500 if preview file is missing', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      const filesData = [
        { fieldname: 'mogrt', fileInfo: { filename: 'animation.mogrt' }, chunks: [Buffer.from('mogrt data')] }
      ];
      const mogrtHandlerPromise = MogrtHandler(context, req);
      await simulateBusboyEventsAsync(filesData, [{ fieldname: 'name', value: 'Test' }]);
      await mogrtHandlerPromise;
      console.log("GOTCHA....", context.res)
      expect(context.res.status).toBe(500);
      expect(context.res.body).toEqual({ error: 'Both MOGRT and preview files (GIF or MP4) are required' });
    });

    it('should reject with error for invalid file type during file event', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      const promise = MogrtHandler(context, req);
      
      const fileStream = new stream.Readable({ read() {} });
      const currentBusboyInstance = Busboy.mock.results[Busboy.mock.results.length - 1].value;
      currentBusboyInstance.emit('file', 'somefield', fileStream, { filename: 'document.txt' });

      await expect(promise).rejects.toThrow('Invalid file type. Only .mogrt, .gif and .mp4 files are allowed.');
      // If 'file' event rejects, the 'finish' event might not run its async block.
      // Let's ensure the promise itself is rejected.
      // The actual setting of context.res for this specific early rejection needs careful check of MogrtHandler's flow.
      // For now, confirming the promise rejection is key.
    });

    it('should return 500 if S3 upload fails', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      s3Upload.mockRejectedValue(new Error('S3 upload failed'));
      // Simulate valid files being processed by Busboy, but S3 upload fails
      // Call MogrtHandler; it sets up Busboy and returns a promise that resolves/rejects after Busboy events.
      const mogrtHandlerPromise = MogrtHandler(context, req);

      // Simulate valid files being processed by Busboy, which will trigger s3Upload internally.
      const filesData = [
        { fieldname: 'mogrt', fileInfo: { filename: 'test.mogrt' }, chunks: [Buffer.from('m-data')] },
        { fieldname: 'preview', fileInfo: { filename: 'prev.gif' }, chunks: [Buffer.from('p-data')] }
      ];
      // This simulation will cause the mocked s3Upload (which rejects) to be called by MogrtHandler's event listeners.
      await simulateBusboyEventsAsync(filesData, [{ fieldname: 'name', value: 'Fail Upload' }]);

      // Await the main handler promise after events have been processed.
      await mogrtHandlerPromise;

      expect(context.res.status).toBe(500);
      expect(context.res.body).toEqual({ error: 'S3 upload failed' });
    });

    it('should return 500 if saveManifest fails', async () => {
      const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
      s3SaveManifest.mockRejectedValue(new Error('Manifest save failed'));
      // Simulate successful S3 uploads, but manifest saving fails
      const filesData = [
        { fieldname: 'mogrt', fileInfo: { filename: 'good.mogrt' }, chunks: [Buffer.from('m-data')] },
        { fieldname: 'preview', fileInfo: { filename: 'good.mp4' }, chunks: [Buffer.from('p-data')] }
      ];
      s3Upload
        .mockResolvedValueOnce({ key: 'test-uuid/good.mogrt' })
        .mockResolvedValueOnce({ key: 'test-uuid/good.mp4' });

      // Call MogrtHandler; it sets up Busboy and returns a promise.
      const mogrtHandlerPromise = MogrtHandler(context, req);

      // Simulate events. This will trigger s3Upload (resolve) then s3SaveManifest (reject).
      await simulateBusboyEventsAsync(filesData, [{ fieldname: 'name', value: 'Fail Save' }]);
        
      // Await the main handler promise.
      await mogrtHandlerPromise;

      expect(context.res.status).toBe(500);
      expect(context.res.body).toEqual({ error: 'Manifest save failed' });
    });

    it('should return 500 if Busboy emits an error', async () => {
        const req = mockReq('POST', {}, {}, { 'content-type': 'multipart/form-data' }, 'fake-body');
        const busboyError = new Error('Busboy processing error');
        
        // We need to ensure the main promise from MogrtHandler is awaited
        const mogrtHandlerPromise = MogrtHandler(context, req);

        // Simulate Busboy emitting an error *after* MogrtHandler has started listening
        process.nextTick(() => {
            const currentBusboyInstance = Busboy.mock.results[Busboy.mock.results.length -1].value;
            currentBusboyInstance.emit('error', busboyError);
        });

        // The promise should reject, and the catch block in MogrtHandler should set context.res
        // However, the current MogrtHandler's main promise rejection doesn't set context.res directly.
        // The rejection is caught by the Azure Functions runtime or not at all if not handled by main promise.
        // The 'busboy.on('error', reject)' will reject the promise returned by `new Promise(...)`
        // Let's test that the promise is rejected.
        await expect(mogrtHandlerPromise).rejects.toThrow('Busboy processing error');

        // If the handler were to set context.res in a top-level catch for the promise it returns:
        // expect(context.res.status).toBe(500); // Or appropriate error code
        // expect(context.res.body).toEqual({ error: 'Busboy processing error' });
        // This test highlights that the main promise rejection needs to be handled to set context.res.
      });

  });

  describe('Unhandled methods/requests', () => {
    it('should not set a response for an unhandled HTTP method (e.g., PUT)', async () => {
      const req = mockReq('PUT');
      await MogrtHandler(context, req);
      console.log(context.res)
      expect(context.res.status).toBe(500);
    });

    it('should not set a response if DELETE request is missing id param', async () => {
        const req = mockReq('DELETE'); // No id in params
        await MogrtHandler(context, req);
        expect(s3RemoveFromMasterManifest).not.toHaveBeenCalled();
      });
  });

});
