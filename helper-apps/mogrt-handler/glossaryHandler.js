import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { saveGlossaryId, getGlossaryVersions, getGlossaryVersion } from './s3Handler.js';

dotenv.config();

const APPTEK_BASE_URL = process.env.APPTEK_API_URL || 'https://api.apptek.com/api/v2/glossary';
const APPTEK_TOKEN = process.env.APPTEK_TOKEN;

export default async function GlossaryHandler(context, req) {
    const { method, url, body, query, headers } = req;
    // Use token from header if present, else from env
    const token = APPTEK_TOKEN;
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
            const data = await resp.json();
            context.res = { status: resp.status, body: data };
            return;
        }
        // Create glossary
        if (method === 'POST' && url.match(/\/api\/glossary\/[a-z]{2}-[a-z]{2}/)) {
            const langPair = url.match(/\/api\/glossary\/([a-z]{2}-[a-z]{2})/)[1];
            body.name = ""

            for (const entry of body.entries) {
                entry.target_alternatives = [];
            }
            const resp = await fetch(`${APPTEK_BASE_URL}/${langPair}`, {
                method: 'POST',
                headers: { 'accept': 'application/json', 'x-token': token, 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            console.log(resp)
            const data = await resp.json();
            
            // If successful, save the glossary ID to S3 with versioning
            if (resp.status === 200 && data.glossary_id) {
                try {
                    const versionInfo = await saveGlossaryId(data.glossary_id, langPair, name);
                    // Add version info to the response
                    data.version = {
                        versionId: versionInfo.versionId,
                        key: versionInfo.key
                    };
                } catch (s3Error) {
                    console.error('Error saving glossary ID to S3:', s3Error);
                    // Don't fail the request if S3 storage fails
                    data.versioningError = 'Failed to save glossary version to S3';
                }
            }
            
            context.res = { status: resp.status, body: data };
            return;
        }
        // Delete glossary
        if (method === 'DELETE' && url.match(/\/api\/glossary\/.+/)) {
            const glossaryId = url.split('/').pop();
            console.log(`🗑️ Attempting to delete glossary with ID: ${glossaryId}`);
            
            try {
                const resp = await fetch(`${APPTEK_BASE_URL}/${glossaryId}`, {
                    method: 'DELETE',
                    headers: { 'accept': 'application/json', 'x-token': token }
                });
                
                console.log(`📤 Delete request sent, response status: ${resp.status}`);
                
                const data = await resp.json().catch(() => {
                    console.log(`⚠️ No JSON in delete response, using empty object`);
                    return {};
                });
                
                if (resp.status === 200) {
                    console.log(`✅ Successfully deleted glossary ${glossaryId}`);
                } else {
                    console.error(`❌ Failed to delete glossary ${glossaryId}, status: ${resp.status}`, data);
                }
                
                context.res = { status: resp.status, body: data };
            } catch (error) {
                console.error(`❌ Error during glossary deletion: ${error.message}`);
                context.res = { status: 500, body: { error: `Error deleting glossary: ${error.message}` } };
            }
            return;
        }
        // Edit glossary: delete then create
        if (method === 'POST' && url.includes('/edit/')) {
            const glossaryId = url.split('/edit/').pop();
            // 1. Delete
            console.log(`🗑️ Deleting glossary with ID: ${glossaryId} as part of edit operation`);
            try {
                const deleteResp = await fetch(`${APPTEK_BASE_URL}/${glossaryId}`, {
                    method: 'DELETE',
                    headers: { 'accept': 'application/json', 'x-token': token }
                });
                
                console.log(`📤 Delete request (for edit) sent, response status: ${deleteResp.status}`);
                
                if (deleteResp.status === 200) {
                    console.log(`✅ Successfully deleted glossary ${glossaryId} for edit operation`);
                } else {
                    console.warn(`⚠️ Non-200 status when deleting glossary for edit: ${deleteResp.status}`);
                }
            } catch (deleteError) {
                console.error(`❌ Error during glossary deletion for edit: ${deleteError.message}`);
                // Continue with create even if delete fails
            }
            // 2. Create (reuse create logic)
            const { source_lang_code, target_lang_code, entries } = body;
            body.name = ""
            const langPair = `${source_lang_code}-${target_lang_code}`;
            const resp = await fetch(`${APPTEK_BASE_URL}/${langPair}`, {
                method: 'POST',
                headers: { 'accept': 'application/json', 'x-token': token, 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await resp.json();
            
            // If successful, save the glossary ID to S3 with versioning
            if (resp.status === 200 && data.glossary_id) {
                try {
                    const versionInfo = await saveGlossaryId(data.glossary_id, langPair);
                    // Add version info to the response
                    data.version = {
                        versionId: versionInfo.versionId,
                        key: versionInfo.key
                    };
                } catch (s3Error) {
                    console.error('Error saving glossary ID to S3:', s3Error);
                    // Don't fail the request if S3 storage fails
                    data.versioningError = 'Failed to save glossary version to S3';
                }
            }
            
            context.res = { status: resp.status, body: data };
            return;
        }
        // Get versions of a glossary
        if (method === 'GET' && url.match(/\/api\/glossary\/([a-z]{2}-[a-z]{2})\/versions\/(.*)/)) {
            const matches = url.match(/\/api\/glossary\/([a-z]{2}-[a-z]{2})\/versions\/(.*)/); 
            const langPair = matches[1];
            const glossaryId = matches[2];
            const name = query.name || '';
            
            try {
                const versions = await getGlossaryVersions(glossaryId, langPair, name);
                context.res = { status: 200, body: { versions } };
            } catch (error) {
                context.res = { status: 500, body: { error: error.message } };
            }
            return;
        }
        
        // Get a specific version of a glossary
        if (method === 'GET' && url.match(/\/api\/glossary\/([a-z]{2}-[a-z]{2})\/version\/(.*)\/(.*)/))
        {
            const matches = url.match(/\/api\/glossary\/([a-z]{2}-[a-z]{2})\/version\/(.*)\/(.*)/);
            const langPair = matches[1];
            const glossaryId = matches[2];
            const versionId = matches[3];
            const name = query.name || '';
            
            try {
                const version = await getGlossaryVersion(glossaryId, langPair, versionId, name);
                context.res = { status: 200, body: version };
            } catch (error) {
                context.res = { status: 500, body: { error: error.message } };
            }
            return;
        }
        
        // Get glossary by ID
        if (method === 'GET' && url.match(/\/api\/glossary\/([^/]+)$/))
        {
            const glossaryId = url.match(/\/api\/glossary\/([^/]+)$/)[1];
            console.log(`📖 Fetching glossary with ID: ${glossaryId}`);
            
            try {
                const resp = await fetch(`${APPTEK_BASE_URL}/${glossaryId}`, {
                    method: 'GET',
                    headers: {'x-token': token }
                });
                
                console.log(`📤 Get glossary request sent, response status: ${resp.status}`);
                
                const data = await resp.json().catch(() => {
                    console.log(`⚠️ No JSON in response, using empty object`);
                    return {};
                });
                
                if (resp.status === 200) {
                    console.log(`✅ Successfully retrieved glossary ${glossaryId}`);
                } else {
                    console.error(`❌ Failed to retrieve glossary ${glossaryId}, status: ${resp.status}`, data);
                }
                
                context.res = { status: resp.status, body: data };
            } catch (error) {
                console.error(`❌ Error retrieving glossary: ${error.message}`);
                context.res = { status: 500, body: { error: `Error retrieving glossary: ${error.message}` } };
            }
            return;
        }
        
        context.res = { status: 404, body: { error: 'Not found' } };
    } catch (error) {
        context.res = { status: 500, body: { error: error.message } };
    }
}
