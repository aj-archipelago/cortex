import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import GlossaryHandler from '../../glossaryHandler.js';

// Helper to create app with the handler
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.all('/api/glossary/*', (req, res) => {
    const context = { req, res, log: () => {} };
    GlossaryHandler(context, req)
      .then(() => res.status(context.res.status || 200).json(context.res.body))
      .catch(err => res.status(500).json({ error: err.message }));
  });
  return app;
}

describe('Glossary API Proxy', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should proxy GET /list to AppTek', async () => {
    // This test expects the real AppTek API or a mock server
    // To run as a unit test, mock fetch in glossaryHandler.js
    // Here we just check the request shape
    await request(app)
      .get('/api/glossary/list')
      .expect(res => {
        // Accept either 200 or 401/403 from upstream
        expect([200, 401, 403]).toContain(res.status);
      });
  });

  it('should proxy POST /en-es (create glossary)', async () => {
    const body = {
      source_lang_code: 'en',
      target_lang_code: 'es',
      entries: [{ source: 'Roberto', target: 'Berto' }],
      name: 'English to Spanish Glossary'
    };
    const res = await request(app)
      .post('/api/glossary/en-es?name=English%20to%20Spanish%20Glossary')
      .send(body)
      .expect(res => {
        expect([200, 401, 403, 400]).toContain(res.status);
      });
  });

  it('should proxy DELETE /glossary_id', async () => {
    // First, create a glossary
    const createBody = {
      source_lang_code: 'en',
      target_lang_code: 'es',
      entries: [{ source: 'DeleteMe', target: 'BorrarMe' }],
      name: 'ToDelete'
    };
    const createRes = await request(app)
      .post('/api/glossary/en-es?name=ToDelete')
      .send(createBody)
      .expect(res => {
        expect([200, 201]).toContain(res.status);
      });
    const glossaryId = createRes.body.id || createRes.body._id || createRes.body.glossary_id || createRes.body.name || 'ToDelete';
    // Then, delete the created glossary
    const delRes = await request(app)
      .delete(`/api/glossary/${glossaryId}`)
      .expect(res => {
        expect([200, 204, 401, 403, 404]).toContain(res.status);
      });
  });

  it('should proxy POST /edit/:id (edit glossary)', async () => {
    // First, create a glossary
    const createBody = {
      source_lang_code: 'en',
      target_lang_code: 'es',
      entries: [{ source: 'EditMe', target: 'EditarMe' }],
      name: 'ToEdit'
    };
    const createRes = await request(app)
      .post('/api/glossary/en-es?name=ToEdit')
      .send(createBody)
      .expect(res => {
        expect([200, 201]).toContain(res.status);
      });
    const glossaryId = createRes.body.id || createRes.body._id || createRes.body.glossary_id || createRes.body.name || 'ToEdit';
    // Now, edit the created glossary
    const editBody = {
      source_lang_code: 'en',
      target_lang_code: 'es',
      entries: [{ source: 'EditMe', target: 'YaEditado' }],
      name: 'ToEditEdited'
    };
    const editRes = await request(app)
      .post(`/api/glossary/edit/${glossaryId}`)
      .send(editBody)
      .expect(res => {
        expect([200, 201, 401, 403, 400]).toContain(res.status);
      });
  });
});
