import { describe, it, expect, beforeEach, vi } from 'vitest';
import GlossaryHandler from '../../glossaryHandler.js';

// Helper to call handler
async function callHandler({ method, url, body = {}, query = {}, headers = {} }) {
  const context = {};
  const req = { method, url, body, query, headers };
  await GlossaryHandler(context, req);
  return context.res;
}

describe('GlossaryHandler Unit', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.resetModules();
    vi.doMock('node-fetch', () => ({
      __esModule: true,
      default: fetchMock
    }));
  });

  it('should reject missing x-token', async () => {
    const res = await callHandler({ method: 'GET', url: '/api/glossary/list' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/x-token/i);
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
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ id: 'glossary-id' }) });
    const body = { source_lang_code: 'en', target_lang_code: 'es', entries: [{ source: 'a', target: 'b' }] };
    const res = await callHandler({ method: 'POST', url: '/api/glossary/en-es', body });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/en-es'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('glossary-id');
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
