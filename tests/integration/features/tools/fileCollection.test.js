// fileCollection.test.js
// Integration tests for the current FileCollection tool contract.

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import {
    addFileToCollection,
    buildFileLocation,
    getRedisClient,
    uploadFileToCloud,
} from '../../../../lib/fileUtils.js';

let testServer;

test.before(async () => {
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;
});

test.after.always('cleanup server', async () => {
    if (testServer) {
        await testServer.stop();
    }
});

const createContext = () => {
    const contextId = `test-file-collection-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return {
        contextId,
        fileAccessPlan: [{ kind: 'user-global', userContextId: contextId, write: true }],
    };
};

const cleanup = async (contextId, fileAccessPlan, hashes = []) => {
    for (const hash of hashes.filter(Boolean)) {
        try {
            await callPathway('sys_tool_file_collection', {
                fileAccessPlan,
                fileIds: [hash],
                userMessage: `Remove test file ${hash}`,
            });
        } catch {
            // Best-effort cloud cleanup.
        }
    }

    try {
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${contextId}`);
        }
    } catch {
        // Ignore cleanup errors.
    }
};

const seedFile = async (t, contextId, filename, content) => {
    const fileLocation = buildFileLocation(contextId, { fileScope: 'global' });
    let upload;
    try {
        upload = await uploadFileToCloud(
            Buffer.from(content, 'utf8'),
            'text/plain; charset=utf-8',
            filename,
            null,
            fileLocation,
        );
    } catch (error) {
        if (error?.message?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return null;
        }
        throw error;
    }

    if (!upload?.url) {
        t.log('Test skipped - file handler URL not configured');
        t.pass();
        return null;
    }

    const entry = await addFileToCollection(
        contextId,
        null,
        upload.url,
        filename,
        upload.hash || null,
        null,
        null,
        null,
    );

    return {
        ...entry,
        url: upload.url,
        hash: upload.hash || entry.hash,
    };
};

test('FileCollection lists files from the provided file access plan', async t => {
    const { contextId, fileAccessPlan } = createContext();
    const seeded = [];

    try {
        seeded.push(await seedFile(t, contextId, 'alpha-notes.txt', 'Alpha notes'));
        seeded.push(await seedFile(t, contextId, 'beta-report.txt', 'Beta report'));
        if (seeded.some(file => !file)) return;

        const result = await callPathway('sys_tool_file_collection', {
            fileAccessPlan,
            sortBy: 'filename',
            userMessage: 'List test files',
        });

        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.true(parsed.count >= 2);
        t.true(parsed.totalFiles >= 2);
        t.true(parsed.files.some(file => file.displayFilename === 'alpha-notes.txt'));
        t.true(parsed.files.some(file => file.displayFilename === 'beta-report.txt'));
    } finally {
        await cleanup(contextId, fileAccessPlan, seeded.map(file => file?.hash));
    }
});

test('FileCollection searches by normalized filename', async t => {
    const { contextId, fileAccessPlan } = createContext();
    const seeded = [];

    try {
        seeded.push(await seedFile(t, contextId, 'quarterly_report.txt', 'Quarterly report'));
        seeded.push(await seedFile(t, contextId, 'meeting-notes.txt', 'Meeting notes'));
        if (seeded.some(file => !file)) return;

        const result = await callPathway('sys_tool_file_collection', {
            fileAccessPlan,
            query: 'quarterly report',
            userMessage: 'Search test files',
        });

        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.true(parsed.count >= 1);
        t.true(parsed.files.some(file => file.displayFilename === 'quarterly_report.txt'));
        t.false(parsed.files.some(file => file.displayFilename === 'meeting-notes.txt'));
    } finally {
        await cleanup(contextId, fileAccessPlan, seeded.map(file => file?.hash));
    }
});

test('FileCollection resolves a file reference to details', async t => {
    const { contextId, fileAccessPlan } = createContext();
    let seeded = null;

    try {
        seeded = await seedFile(t, contextId, 'resolve-target.txt', 'Resolve me');
        if (!seeded) return;

        const result = await callPathway('sys_tool_file_collection', {
            fileAccessPlan,
            fileRef: 'resolve-target.txt',
            userMessage: 'Resolve test file',
        });

        const parsed = JSON.parse(result);
        t.is(parsed.success, true);
        t.is(parsed.file.displayFilename, 'resolve-target.txt');
        t.is(parsed.file.hash, seeded.hash);
        t.truthy(parsed.file.workspacePath);
        t.truthy(parsed.file.url);
    } finally {
        await cleanup(contextId, fileAccessPlan, [seeded?.hash]);
    }
});

test('FileCollection removes writable files and rejects missing files', async t => {
    const { contextId, fileAccessPlan } = createContext();
    let seeded = null;

    try {
        seeded = await seedFile(t, contextId, 'remove-target.txt', 'Remove me');
        if (!seeded) return;

        const missingResult = await callPathway('sys_tool_file_collection', {
            fileAccessPlan,
            fileIds: ['missing-file.txt'],
            userMessage: 'Remove missing test file',
        });
        const missingParsed = JSON.parse(missingResult);
        t.is(missingParsed.success, false);
        t.regex(missingParsed.error, /No files found matching/);

        const removeResult = await callPathway('sys_tool_file_collection', {
            fileAccessPlan,
            fileIds: [seeded.hash],
            userMessage: 'Remove test file',
        });

        const removeParsed = JSON.parse(removeResult);
        t.is(removeParsed.success, true);
        t.is(removeParsed.removedCount, 1);
        t.is(removeParsed.removedFiles[0].hash, seeded.hash);
        seeded = null;
    } finally {
        await cleanup(contextId, fileAccessPlan, [seeded?.hash]);
    }
});
