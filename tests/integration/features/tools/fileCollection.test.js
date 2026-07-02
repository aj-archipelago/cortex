// fileCollection.test.js
// Integration tests for file collection tool (cloud-storage-based)
//
// Coverage:
//   Pathway operations (via callPathway):
//     - LIST: list files, sort by date/filename, limit, includeAllChats
//     - SEARCH: search by filename query, separator normalization, min-length
//     - REMOVE: remove by hash, by filename, not-found error
//   Utility functions:
//     - findFileInCollection: by hash, filename, URL, contains match, 4-char minimum
//     - resolveFileParameter: resolve hash/filename/URL to file URL
//     - generateFileMessageContent: resolve to chat content object
//     - syncAndStripFilesFromChatHistory: strip cloud files from chat history
//   Edge cases:
//     - Empty collection, file not found, chatId filtering
//
// Gaps / not covered:
//   - Compound fileAccessPlan coverage for distinct contexts beyond user-global
//     agent use cases is limited in this suite
//   - File handler metadata enrichment in listFolder response
//   - File conversion (converted URLs) — requires actual doc conversion infrastructure
//   - GCS backup/restore — requires GCS credentials
//   - chatId-scoped uploads with fileScope=chat — requires Azurite or real Azure

import test from 'ava';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import {
    findFileInCollection,
    resolveFileParameter,
    generateFileMessageContent,
    syncAndStripFilesFromChatHistory,
    computeBufferHash,
    listFilesForContext,
} from '../../../../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let testServer;

// Unique per-run userId so tests don't collide
const TEST_USER_ID = `test-fc-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

// Uploaded file metadata (populated in before hook)
const uploadedFiles = [];

function getFileHandlerUrl() {
    if (process.env.WHISPER_MEDIA_API_URL && process.env.WHISPER_MEDIA_API_URL !== 'null') {
        return process.env.WHISPER_MEDIA_API_URL;
    }
    return 'http://localhost:7071';
}

async function uploadFile(content, filename, userId) {
    const fileHandlerUrl = getFileHandlerUrl();
    const contentBuffer = Buffer.from(content);
    const hash = await computeBufferHash(contentBuffer);

    const tempDir = path.join(__dirname, '../../../../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `test-${Date.now()}-${filename}`);
    fs.writeFileSync(tempFile, content);

    try {
        const form = new FormData();
        // Metadata fields MUST precede the file part — the file handler reads
        // them from `fields` inside the busboy onFile handler, before the file
        // data is consumed. Fields appended after the file stream won't be
        // available in time for folder-path / container derivation.
        if (userId) form.append('userId', userId);
        form.append('hash', hash);
        form.append('file', fs.createReadStream(tempFile), { filename, contentType: 'application/octet-stream' });

        let uploadUrl = fileHandlerUrl;
        if (!fileHandlerUrl.includes('/api/')) {
            uploadUrl = `${fileHandlerUrl}/api/CortexFileHandler`;
        }

        const response = await axios.post(uploadUrl, form, {
            headers: form.getHeaders(),
            timeout: 30000,
            validateStatus: (status) => status >= 200 && status < 500,
        });

        if (response.status !== 200 || !response.data?.url) {
            throw new Error(`Upload failed: ${response.status} - ${JSON.stringify(response.data)}`);
        }

        await new Promise(resolve => setTimeout(resolve, 300));

        return {
            url: response.data.url,
            hash: response.data.hash || hash,
            filename: response.data.filename || filename,
            displayFilename: response.data.displayFilename || filename,
            userId,
        };
    } finally {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
}

async function deleteByHash(hash, userId) {
    const fileHandlerUrl = getFileHandlerUrl();
    let url = fileHandlerUrl;
    if (!url.includes('/api/')) url = `${url}/api/CortexFileHandler`;
    try {
        await axios.delete(url, {
            params: { hash, ...(userId ? { contextId: userId } : {}) },
            timeout: 10000,
            validateStatus: () => true,
        });
    } catch { /* ignore */ }
}

const createFileAccessPlan = (contextId) => [{ kind: 'user-global', userContextId: contextId, write: true }];

// ── Setup & Teardown ────────────────────────────────────────────────

test.before(async () => {
    const { server, startServer } = await serverFactory();
    if (startServer) await startServer();
    testServer = server;

    // Upload 3 test files
    const files = [
        { content: 'Alpha document content', filename: 'alpha-report.txt' },
        { content: 'Bravo image metadata',   filename: 'bravo-photo.jpg' },
        { content: 'Charlie data payload',   filename: 'charlie-data.csv' },
    ];

    for (const f of files) {
        const uploaded = await uploadFile(f.content, f.filename, TEST_USER_ID);
        uploadedFiles.push(uploaded);
    }
});

test.after.always('cleanup', async () => {
    // Delete uploaded files
    for (const f of uploadedFiles) {
        await deleteByHash(f.hash, f.userId || TEST_USER_ID);
    }
    if (testServer) await testServer.stop();
});

// ── Pathway: LIST ───────────────────────────────────────────────────

test.serial('LIST: should list all uploaded files', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        userMessage: 'List my files',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.true(parsed.count >= 3, `Expected at least 3 files, got ${parsed.count}`);
    t.truthy(parsed.files);
    // Each file should have hash, displayFilename, url
    for (const f of parsed.files) {
        t.truthy(f.url, 'File should have url');
    }
});

test.serial('LIST: should allow read-only file access plans for read operations', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: [{ kind: 'user-global', userContextId: TEST_USER_ID, write: false }],
        userMessage: 'List files read-only',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.true(parsed.count >= 3, `Expected at least 3 files, got ${parsed.count}`);
});

test.serial('LIST: should sort by filename', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        sortBy: 'filename',
        userMessage: 'List files sorted by name',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    const names = parsed.files.map(f => (f.displayFilename || f.filename || '').toLowerCase());
    const sorted = [...names].sort();
    t.deepEqual(names, sorted, 'Files should be sorted alphabetically');
});

test.serial('LIST: should respect limit', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        limit: 2,
        userMessage: 'List files with limit 2',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.true(parsed.count <= 2, `Expected at most 2 files, got ${parsed.count}`);
});

test.serial('LIST: empty context should return no files', async t => {
    const emptyContext = `empty-ctx-${Date.now()}`;
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(emptyContext),
        userMessage: 'List files',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.count, 0);
});

// ── Pathway: SEARCH ─────────────────────────────────────────────────

test.serial('SEARCH: should find file by filename substring', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        operation: 'search',
        query: 'alpha',
        userMessage: 'Search for alpha',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.operation, 'search');
    t.true(parsed.count >= 1, 'Should find at least 1 file');
    const names = parsed.files.map(f => (f.displayFilename || '').toLowerCase());
    t.true(names.some(n => n.includes('alpha')), 'Should find alpha file');
    t.true(parsed.files.some(f => typeof f.workspacePath === 'string' && f.workspacePath.startsWith('/workspace/files/')));
});

test.serial('SEARCH: should not double-apply documented user-global prefixes', async t => {
    for (const prefix of ['global', '/workspace/files/global']) {
        const result = await callPathway('sys_tool_file_collection', {
            fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
            operation: 'search',
            query: 'alpha',
            prefix,
            userMessage: `Search for alpha under ${prefix}`,
        });
        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.true(parsed.count >= 1, `Should find alpha file with prefix ${prefix}`);
        t.true(
            parsed.files.some(f => (f.workspacePath || '').includes('/workspace/files/global/')),
            `Should return global workspace path with prefix ${prefix}`,
        );
    }
});

test.serial('SEARCH: should be case-insensitive', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        query: 'BRAVO',
        userMessage: 'Search for BRAVO',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.true(parsed.count >= 1, 'Case-insensitive search should find bravo');
});

test.serial('SEARCH: should normalize separators (dash/underscore/space)', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        query: 'charlie data',
        userMessage: 'Search with space separator',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.true(parsed.count >= 1, 'Should find file with normalized separators');
});

test.serial('SEARCH: no results should return empty list', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        query: 'nonexistent-file-xyz-999',
        userMessage: 'Search for nonexistent file',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.count, 0);
    t.true(parsed.message.includes('No files found'));
});

test.serial('SEARCH: should respect limit', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        query: 'a', // broad match
        limit: 1,
        userMessage: 'Search with limit',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.true(parsed.count <= 1);
});

test.serial('SEARCH: should filter by csv type and return compact path results by default', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        operation: 'search',
        query: 'charlie data',
        type: 'csv',
        limit: 5,
        userMessage: 'Search for CSV data files',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.operation, 'search');
    t.is(parsed.type, 'csv');
    t.true(parsed.count >= 1, 'Should find the CSV file');
    const csvFile = parsed.files.find(f => (f.filename || '').toLowerCase() === 'charlie-data.csv');
    t.truthy(csvFile);
    t.true(csvFile.workspacePath.endsWith('/charlie-data.csv'));
    t.is(csvFile.url, null);
});

// ── Pathway: REMOVE ─────────────────────────────────────────────────

test.serial('REMOVE: should remove file by hash', async t => {
    // Upload a throwaway file
    const f = await uploadFile('delete me by hash', 'delete-by-hash.txt', TEST_USER_ID);

    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        fileIds: [f.hash],
        userMessage: 'Remove file',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.removedCount, 1);
});

test.serial('REMOVE: should remove file by displayFilename', async t => {
    const f = await uploadFile('delete me by name', 'delete-by-name.txt', TEST_USER_ID);

    // Wait for listing to reflect
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        fileIds: ['delete-by-name.txt'],
        userMessage: 'Remove file by name',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.removedCount, 1);
});

test.serial('REMOVE: should error when file not found', async t => {
    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        fileIds: ['nonexistent-file-hash-abc'],
        userMessage: 'Remove nonexistent file',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, false);
    t.true(parsed.error.includes('not found') || parsed.error.includes('No files found'));
});

test.serial('REMOVE: should handle multiple files', async t => {
    const f1 = await uploadFile('multi delete 1', 'multi-del-1.txt', TEST_USER_ID);
    const f2 = await uploadFile('multi delete 2', 'multi-del-2.txt', TEST_USER_ID);

    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: createFileAccessPlan(TEST_USER_ID),
        fileIds: [f1.hash, f2.hash],
        userMessage: 'Remove multiple files',
    });
    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.removedCount, 2);
});

test.serial('REMOVE: should refuse files from read-only file access targets', async t => {
    const sharedContextId = `shared-fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sharedFile = await uploadFile(
        'shared readonly content',
        'shared-readonly.txt',
        sharedContextId,
    );
    uploadedFiles.push(sharedFile);

    const result = await callPathway('sys_tool_file_collection', {
        fileAccessPlan: [
            { kind: 'user-global', userContextId: TEST_USER_ID, write: true },
            { kind: 'user-global', userContextId: sharedContextId, write: false },
        ],
        fileIds: [sharedFile.hash],
        userMessage: 'Remove the shared file',
    });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.true(
        parsed.error.includes('Cannot remove read-only files'),
        `Unexpected error: ${parsed.error}`,
    );

    const stillExists = await resolveFileParameter(sharedFile.hash, [
        { kind: 'user-global', userContextId: sharedContextId, write: false },
    ]);
    t.truthy(stillExists);
});

// ── findFileInCollection (pure function) ────────────────────────────

test('findFileInCollection: find by hash', t => {
    const collection = [
        { hash: 'abc123', displayFilename: 'doc.pdf', url: 'https://example.com/doc.pdf' },
    ];
    const result = findFileInCollection('abc123', collection);
    t.truthy(result);
    t.is(result.hash, 'abc123');
});

test('findFileInCollection: find by displayFilename (case-insensitive)', t => {
    const collection = [
        { hash: 'abc', displayFilename: 'Report.PDF', url: 'https://example.com/report.pdf' },
    ];
    const result = findFileInCollection('report.pdf', collection);
    t.truthy(result);
    t.is(result.hash, 'abc');
});

test('findFileInCollection: find by URL', t => {
    const collection = [
        { hash: 'abc', displayFilename: 'doc.pdf', url: 'https://example.com/doc.pdf' },
    ];
    const result = findFileInCollection('https://example.com/doc.pdf', collection);
    t.truthy(result);
});

test('findFileInCollection: contains match requires minimum 4 characters', t => {
    const collection = [
        { hash: 'abc', displayFilename: 'alpha-report.txt', url: 'https://example.com/alpha.txt' },
    ];
    // 3 chars — no match
    t.is(findFileInCollection('alp', collection), null);
    // 4 chars — match
    t.truthy(findFileInCollection('alph', collection));
});

test('findFileInCollection: contains match on displayFilename', t => {
    const collection = [
        { hash: 'abc', displayFilename: 'quarterly-report-2024.pdf', url: 'https://example.com/report.pdf' },
    ];
    const result = findFileInCollection('quarterly-report', collection);
    t.truthy(result);
    t.is(result.hash, 'abc');
});

test('findFileInCollection: returns null when not found', t => {
    const collection = [
        { hash: 'abc', displayFilename: 'doc.pdf', url: 'https://example.com/doc.pdf' },
    ];
    t.is(findFileInCollection('nonexistent', collection), null);
});

test('findFileInCollection: handles null/undefined inputs', t => {
    t.is(findFileInCollection(null, []), null);
    t.is(findFileInCollection('test', null), null);
    t.is(findFileInCollection('', []), null);
});

// ── resolveFileParameter ────────────────────────────────────────────

test.serial('resolveFileParameter: resolve by hash', async t => {
    const file = uploadedFiles[0];
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);
    const resolved = await resolveFileParameter(file.hash, fileAccessPlan);
    t.truthy(resolved, 'Should resolve hash to URL');
    t.true(resolved.startsWith('http'), 'Resolved value should be a URL');
});

test.serial('resolveFileParameter: resolve by displayFilename', async t => {
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);
    const resolved = await resolveFileParameter('alpha-report.txt', fileAccessPlan);
    t.truthy(resolved, 'Should resolve displayFilename to URL');
});

test.serial('resolveFileParameter: returns null when not found', async t => {
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);
    const resolved = await resolveFileParameter('nonexistent-file.xyz', fileAccessPlan);
    t.is(resolved, null);
});

test.serial('resolveFileParameter: returns null without fileAccessPlan', async t => {
    const resolved = await resolveFileParameter('anything', null);
    t.is(resolved, null);
});

// ── generateFileMessageContent ──────────────────────────────────────

test.serial('generateFileMessageContent: resolve file to content object', async t => {
    const file = uploadedFiles[0];
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);
    const content = await generateFileMessageContent(file.hash, fileAccessPlan);
    t.truthy(content, 'Should return content object');
    t.is(content.type, 'image_url');
    t.truthy(content.url);
    t.truthy(content.hash);
});

test.serial('generateFileMessageContent: returns null for unknown file', async t => {
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);
    const content = await generateFileMessageContent('unknown-hash-xyz', fileAccessPlan);
    t.is(content, null);
});

test.serial('generateFileMessageContent: returns null without fileAccessPlan', async t => {
    const content = await generateFileMessageContent('anything', null);
    t.is(content, null);
});

// ── syncAndStripFilesFromChatHistory ────────────────────────────────

test.serial('syncAndStripFilesFromChatHistory: strips files that exist in cloud', async t => {
    const file = uploadedFiles[0];
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);

    const chatHistory = [{
        role: 'user',
        content: [
            { type: 'file', url: file.url, hash: file.hash, filename: file.filename },
            { type: 'text', text: 'Please analyze this file.' }
        ]
    }];

    const result = await syncAndStripFilesFromChatHistory(chatHistory, fileAccessPlan);
    t.truthy(result);
    t.truthy(result.chatHistory);

    // The file should be replaced with a text placeholder
    const content = result.chatHistory[0].content;
    const placeholder = content.find(c => c.type === 'text' && c.text?.includes('available via file tools'));
    t.truthy(placeholder, 'File should be replaced with placeholder');

    // The text message should be preserved
    const textMsg = content.find(c => c.type === 'text' && c.text?.includes('analyze'));
    t.truthy(textMsg, 'Non-file content should be preserved');
});

test.serial('syncAndStripFilesFromChatHistory: preserves files not in cloud', async t => {
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);

    const chatHistory = [{
        role: 'user',
        content: [
            { type: 'file', url: 'https://example.com/not-in-cloud.pdf', hash: 'fake-hash-xyz', filename: 'not-in-cloud.pdf' },
            { type: 'text', text: 'Describe this.' }
        ]
    }];

    const result = await syncAndStripFilesFromChatHistory(chatHistory, fileAccessPlan);
    const content = result.chatHistory[0].content;

    // File not in cloud should be preserved as-is
    const fileItem = content.find(c => c.type === 'file');
    t.truthy(fileItem, 'File not in cloud should be preserved');
});

test.serial('syncAndStripFilesFromChatHistory: handles empty chatHistory', async t => {
    const fileAccessPlan = createFileAccessPlan(TEST_USER_ID);
    const result = await syncAndStripFilesFromChatHistory([], fileAccessPlan);
    t.deepEqual(result.chatHistory, []);
});

test.serial('syncAndStripFilesFromChatHistory: handles null fileAccessPlan', async t => {
    const chatHistory = [{ role: 'user', content: 'Hello' }];
    const result = await syncAndStripFilesFromChatHistory(chatHistory, null);
    t.deepEqual(result.chatHistory, chatHistory);
});

// ── listFilesForContext ─────────────────────────────────────────────

test.serial('listFilesForContext: lists uploaded files', async t => {
    const files = await listFilesForContext(TEST_USER_ID);
    t.true(files.length >= 3, `Expected at least 3 files, got ${files.length}`);
});

test.serial('listFilesForContext: empty context returns empty array', async t => {
    const files = await listFilesForContext(`empty-${Date.now()}`);
    t.is(files.length, 0);
});

test.serial('listFilesForContext: null contextId returns empty array', async t => {
    const files = await listFilesForContext(null);
    t.is(files.length, 0);
});
