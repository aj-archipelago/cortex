import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const APPTEK_BASE_URL = process.env.APPTEK_API_URL || 'https://api.apptek.com/api/v2/glossary';
const APPTEK_TOKEN = process.env.APPTEK_TOKEN;

export default async function GlossaryHandler(context, req) {
    const { method, url, body, query, headers } = req;
    // Use token from header if present, else from env
    const token = headers['x-token'] || headers['X-Token'] || APPTEK_TOKEN;
    if (!token) {
        context.res = { status: 401, body: { error: 'Missing x-token or APPTEK_TOKEN' } };
        return;
    }
    try {
        // List glossaries
        if (method === 'GET' && url.includes('/list')) {
            const resp = await fetch(`${APPTEK_BASE_URL}/list`, {
                method: 'GET',
                headers: { 'accept': 'application/json', 'x-token': token }
            });
            console.log(resp)
            const data = await resp.json();
            context.res = { status: resp.status, body: data };
            return;
        }
        // Create glossary
        if (method === 'POST' && url.match(/\/api\/glossary\/[a-z]{2}-[a-z]{2}/)) {
            const langPair = url.match(/\/api\/glossary\/([a-z]{2}-[a-z]{2})/)[1];
            const name = query.name || (body && body.name) || '';
            const resp = await fetch(`${APPTEK_BASE_URL}/${langPair}?name=${encodeURIComponent(name)}`, {
                method: 'POST',
                headers: { 'accept': 'application/json', 'x-token': token, 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await resp.json();
            context.res = { status: resp.status, body: data };
            return;
        }
        // Delete glossary
        if (method === 'DELETE' && url.match(/\/api\/glossary\/.+/)) {
            const glossaryId = url.split('/').pop();
            const resp = await fetch(`${APPTEK_BASE_URL}/${glossaryId}`, {
                method: 'DELETE',
                headers: { 'accept': 'application/json', 'x-token': token }
            });
            const data = await resp.json().catch(() => ({}));
            context.res = { status: resp.status, body: data };
            return;
        }
        // Edit glossary: delete then create
        if (method === 'POST' && url.includes('/edit/')) {
            const glossaryId = url.split('/edit/').pop();
            // 1. Delete
            await fetch(`${APPTEK_BASE_URL}/${glossaryId}`, {
                method: 'DELETE',
                headers: { 'accept': 'application/json', 'x-token': token }
            });
            // 2. Create (reuse create logic)
            const { source_lang_code, target_lang_code, entries, name } = body;
            const langPair = `${source_lang_code}-${target_lang_code}`;
            const resp = await fetch(`${APPTEK_BASE_URL}/${langPair}?name=${encodeURIComponent(name || glossaryId)}`, {
                method: 'POST',
                headers: { 'accept': 'application/json', 'x-token': token, 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await resp.json();
            context.res = { status: resp.status, body: data };
            return;
        }
        context.res = { status: 404, body: { error: 'Not found' } };
    } catch (error) {
        context.res = { status: 500, body: { error: error.message } };
    }
}
