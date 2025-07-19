import { describe, it, expect, beforeEach, vi } from 'vitest';
// Helper to call handler
async function callHandler({ method, url, body = {}, query = {}, headers = {} }) {
  const { default: GlossaryHandler } = await import('../../glossaryHandler.js');
  const context = {};
  const req = { method, url, body, query, headers };
  await GlossaryHandler(context, req);
  return context.res;
}

describe('GlossaryHandler Unit', () => {
  let fetchMock;
  let s3HandlerMock;
  
  beforeEach(() => {
    fetchMock = vi.fn();
    s3HandlerMock = {
      saveGlossaryId: vi.fn().mockResolvedValue({ versionId: 'mock-version-id', key: 'mock-key' }),
      getGlossaryVersions: vi.fn(),
      getGlossaryVersion: vi.fn()
    };
    
    vi.resetModules();
    vi.doMock('node-fetch', () => ({
      __esModule: true,
      default: fetchMock
    }));
    vi.doMock('../../s3Handler.js', () => ({
      __esModule: true,
      saveGlossaryId: s3HandlerMock.saveGlossaryId,
      getGlossaryVersions: s3HandlerMock.getGlossaryVersions,
      getGlossaryVersion: s3HandlerMock.getGlossaryVersion
    }));
  });


  it('should proxy GET /list', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ glossaries: [] }) });
    const res = await callHandler({ method: 'GET', url: '/api/glossary/list', headers: {} });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/list'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(res.status).toBe(200);
    expect(res.body.glossaries).toEqual([]);
  });

  it('should proxy POST /en-es (create glossary)', async () => {
    // Mock API response with glossary_id instead of id to match actual API response
    fetchMock.mockResolvedValue({ 
      status: 200, 
      json: async () => ({ glossary_id: 'glossary-id' }) 
    });
    
    const body = { 
      source_lang_code: 'en', 
      target_lang_code: 'es', 
      entries: [{ source: 'a', target: 'b' }],
      name: 'Test Glossary'
    };
    
    const res = await callHandler({ 
      method: 'POST', 
      url: '/api/glossary/en-es', 
      body 
    });
    
    // Verify fetch was called with correct URL and method
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/en-es'),
      expect.objectContaining({ 
        method: 'POST',
        headers: expect.objectContaining({
          'accept': 'application/json',
          'content-type': 'application/json'
        }),
        body: expect.any(String)
      })
    );
    
    // Verify S3 save was called
    expect(s3HandlerMock.saveGlossaryId).toHaveBeenCalledWith(
      'glossary-id',
      'en-es',
      'Test Glossary'
    );
    
    // Verify response
    expect(res.status).toBe(200);
    expect(res.body.glossary_id).toBe('glossary-id');
    expect(res.body.version).toEqual({
      versionId: 'mock-version-id',
      key: 'mock-key'
    });
  });

  it('should proxy DELETE /glossary_id', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ success: true }) });
    const res = await callHandler({ method: 'DELETE', url: '/api/glossary/test-id' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/test-id'),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should proxy POST /edit/:id (edit glossary)', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, json: async () => ({}) }) // delete
      .mockResolvedValueOnce({ status: 200, json: async () => ({ id: 'new-id' }) }); // create
    const body = { source_lang_code: 'en', target_lang_code: 'es', entries: [{ source: 'a', target: 'b' }], name: 'Test' };
    const res = await callHandler({ method: 'POST', url: '/api/glossary/edit/old-id', body });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('new-id');
  });
});
