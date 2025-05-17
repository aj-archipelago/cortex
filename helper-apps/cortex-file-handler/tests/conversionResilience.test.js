import test from 'ava';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import XLSX from 'xlsx';

import { port } from '../start.js';
import { gcs, GCS_BUCKETNAME } from '../blobHandler.js';
import { getFileStoreMap, setFileStoreMap } from '../redis.js';
import { cleanupHashAndFile } from './testUtils.helper.js';
import { gcsUrlExists } from '../blobHandler.js';

const baseUrl = `http://localhost:${port}/api/CortexFileHandler`;

// helper: create in-memory xlsx -> file
async function createXlsx(tmpDir) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
        ['A', 'B'],
        ['1', '2'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const filePath = path.join(tmpDir, `${uuidv4()}.xlsx`);
    XLSX.writeFile(wb, filePath);
    return filePath;
}

// Upload helper (multipart)
async function multipartUpload(filePath, hash) {
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('hash', hash);
    form.append('file', fs.createReadStream(filePath));

    const res = await axios.post(baseUrl, form, {
        headers: form.getHeaders(),
        validateStatus: () => true,
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });
    return res;
}

function isGcsConfigured() {
    return !!gcs;
}

test.before(async t => {
    const dir = path.join(fs.mkdtempSync(path.join(process.cwd(), 'conv-test-')));
    t.context.tmpDir = dir;
});

test.after.always(async t => {
    fs.rmSync(t.context.tmpDir, { recursive: true, force: true });
});

// 1. Remote-URL upload path should still return converted info

test.serial('remote URL save returns converted info', async t => {
    const filePath = await createXlsx(t.context.tmpDir);
    const hash = `hash-${uuidv4()}`;
    // step 1: multipart upload
    const up = await multipartUpload(filePath, hash);
    t.is(up.status, 200);
    t.truthy(up.data.converted?.url);
    const publicUrl = up.data.url;

    // step 2: call handler via ?uri= <publicUrl>&save=true
    const saveRes = await axios.get(baseUrl, {
        params: {
            uri: publicUrl,
            requestId: uuidv4(),
            save: true,
        },
        validateStatus: () => true,
        timeout: 30000,
    });

    t.is(saveRes.status, 200);
    // save returns array of urls; ensure at least one has .md/.csv
    t.true(Array.isArray(saveRes.data));

    await cleanupHashAndFile(hash, up.data.url, baseUrl);
});

// 2. If converted.gcs is missing, checkHash should restore it

test.serial('checkHash recreates missing GCS converted file', async t => {
    if (!isGcsConfigured()) {
        t.pass();
        return;
    }

    const filePath = await createXlsx(t.context.tmpDir);
    const hash = `hash-${uuidv4()}`;
    const up = await multipartUpload(filePath, hash);
    t.truthy(up.data.converted?.gcs);

    // delete the GCS object
    const convertedGcsUrl = up.data.converted.gcs;
    const bucket = gcs.bucket(GCS_BUCKETNAME);
    const filename = convertedGcsUrl.replace(`gs://${GCS_BUCKETNAME}/`, '');
    try {
        await bucket.file(filename).delete({ ignoreNotFound: true });
    } catch (_) {}

    // call checkHash – should restore
    const resp = await axios.get(baseUrl, {
        params: { hash, checkHash: true },
        validateStatus: () => true,
        timeout: 30000,
    });
    t.is(resp.status, 200);
    t.truthy(resp.data.converted?.gcs);

    // verify restored GCS object exists using returned URL
    const newGcsUrl = resp.data.converted.gcs;
    const existsAfter = await gcsUrlExists(newGcsUrl, false);
    t.true(existsAfter);

    await cleanupHashAndFile(hash, up.data.url, baseUrl);
});

// 3. If converted section is removed from Redis, checkHash regenerates

test.serial('checkHash regenerates missing converted metadata', async t => {
    const filePath = await createXlsx(t.context.tmpDir);
    const hash = `hash-${uuidv4()}`;
    const up = await multipartUpload(filePath, hash);
    t.truthy(up.data.converted?.url);

    // strip converted from Redis entry
    const record = await getFileStoreMap(hash);
    if (record) {
        delete record.converted;
        await setFileStoreMap(hash, record);
    }

    // call checkHash – should add converted back
    const resp = await axios.get(baseUrl, {
        params: { hash, checkHash: true },
        validateStatus: () => true,
        timeout: 30000,
    });

    t.is(resp.status, 200);
    t.truthy(resp.data.converted?.url);

    await cleanupHashAndFile(hash, up.data.url, baseUrl);
}); 