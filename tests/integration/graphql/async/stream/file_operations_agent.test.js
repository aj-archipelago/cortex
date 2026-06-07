// file_operations_agent.test.js
// Integration coverage for the current sys_entity_agent file convention:
// callers provide explicit file refs in chat history and a fileAccessPlan that
// describes the locations the agent/tools may read.

import test from 'ava';
import serverFactory from '../../../../../index.js';
import { callPathway } from '../../../../../lib/pathwayTools.js';
import {
    addFileToCollection,
    buildFileLocation,
    getRedisClient,
    listFilesForFileAccessPlan,
    loadFileCollection,
    resolveFileParameter,
    syncAndStripFilesFromChatHistory,
    uploadFileToCloud,
} from '../../../../../lib/fileUtils.js';

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

const uniqueId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

const redisCleanup = async (...contextIds) => {
    const redisClient = await getRedisClient();
    if (!redisClient) return;

    await Promise.all(
        contextIds
            .filter(Boolean)
            .map((contextId) => redisClient.del(`FileStoreMap:ctx:${contextId}`)),
    );
};

const removeFiles = async (fileAccessPlan, hashes) => {
    const fileIds = hashes.filter(Boolean);
    if (fileIds.length === 0) return;

    try {
        await callPathway('sys_tool_file_collection', {
            fileAccessPlan,
            fileIds,
            userMessage: `Remove test files ${fileIds.join(', ')}`,
        });
    } catch {
        // Best-effort cloud cleanup; Redis cleanup below is still authoritative for the test.
    }
};

const seedFile = async ({
    contextId,
    filename,
    content,
    fileScope = 'global',
    chatId = null,
    workspaceId = null,
    appletId = null,
}) => {
    const fileLocation = buildFileLocation(contextId, {
        chatId,
        workspaceId,
        appletId,
        fileScope,
    });

    const upload = await uploadFileToCloud(
        Buffer.from(content, 'utf8'),
        'text/plain; charset=utf-8',
        filename,
        null,
        fileLocation,
    );

    const entry = await addFileToCollection(
        fileLocation.contextId,
        null,
        upload.url,
        filename,
        upload.hash,
        null,
        null,
        chatId,
        { workspaceId, appletId, fileScope },
    );

    return {
        ...entry,
        ...upload,
        filename,
        fileLocation,
    };
};

const workspaceFileRef = (file) => {
    const blobPath = file.blobPath || file.name;
    return blobPath ? `/workspace/files/${blobPath}` : file.filename;
};

test('sys_entity_agent file preprocessing uses explicit file refs and fileAccessPlan', async t => {
    const contextId = uniqueId('test-file-ops-user');
    const fileAccessPlan = [{ kind: 'user-global', userContextId: contextId, write: true }];
    const seeded = [];

    try {
        seeded.push(await seedFile({
            contextId,
            filename: 'test-file-1.txt',
            content: 'File 1 Content\nThis is the first test file.',
        }));
        seeded.push(await seedFile({
            contextId,
            filename: 'test-file-2.txt',
            content: 'File 2 Content\nThis is the second test file.',
        }));
        seeded.push(await seedFile({
            contextId,
            filename: 'test-file-3.txt',
            content: 'File 3 Content\nThis is the third test file.',
        }));

        const listedFiles = await listFilesForFileAccessPlan(fileAccessPlan);
        for (const file of seeded) {
            t.truthy(
                listedFiles.find(candidate => candidate.hash === file.hash),
                `${file.filename} should be visible through fileAccessPlan folder listing`,
            );
        }

        const listedFirstFile = listedFiles.find(file => file.hash === seeded[0].hash);
        const explicitRef = workspaceFileRef(listedFirstFile);
        const resolvedUrl = await resolveFileParameter(explicitRef, fileAccessPlan);
        t.truthy(resolvedUrl, 'explicit workspace file ref should resolve through fileAccessPlan');

        const chatHistory = [{
            role: 'user',
            content: [
                JSON.stringify({
                    type: 'file',
                    workspacePath: explicitRef,
                    filename: seeded[0].filename,
                }),
                JSON.stringify({
                    type: 'file',
                    workspacePath: workspaceFileRef(listedFiles.find(file => file.hash === seeded[1].hash)),
                    filename: seeded[1].filename,
                }),
                JSON.stringify({
                    type: 'file',
                    workspacePath: workspaceFileRef(listedFiles.find(file => file.hash === seeded[2].hash)),
                    filename: seeded[2].filename,
                }),
                JSON.stringify({
                    type: 'text',
                    text: 'Please read all three files.',
                }),
            ],
        }];

        const result = await syncAndStripFilesFromChatHistory(chatHistory, fileAccessPlan);
        t.false('availableFiles' in result, 'file availability is exposed through file tools, not chat-history sync');

        const processedContent = result.chatHistory[0].content;
        for (const file of seeded) {
            t.truthy(
                processedContent.find(item => (
                    item?.type === 'text'
                    && item.text.includes(file.filename)
                    && item.text.includes('available via file tools')
                )),
                `${file.filename} should be represented as a compact file placeholder`,
            );
        }

        const collection = await loadFileCollection(fileAccessPlan, { useCache: false });
        t.true(collection.length >= 3, 'metadata collection remains readable through the same fileAccessPlan');
    } finally {
        await removeFiles(fileAccessPlan, seeded.map(file => file?.hash));
        await redisCleanup(contextId);
    }
});

test('fileAccessPlan combines user global and app shared workspace file refs', async t => {
    const userContextId = uniqueId('u');
    const appletId = uniqueId('a');
    const workspaceId = uniqueId('w');
    const appSharedContextId = `applet-shared:${appletId}`;
    const fileAccessPlan = [
        { kind: 'user-global', userContextId, write: true },
        { kind: 'app-shared', appletId, workspaceId, write: false },
    ];
    const seeded = [];

    try {
        seeded.push(await seedFile({
            contextId: userContextId,
            filename: 'user-global-note.txt',
            content: 'User global file content.',
        }));
        seeded.push(await seedFile({
            contextId: appSharedContextId,
            filename: 'app-shared-note.txt',
            content: 'Current app shared file content.',
            fileScope: 'applet-shared',
            appletId,
        }));
        seeded.push(await seedFile({
            contextId: workspaceId,
            filename: 'workspace-shared-note.txt',
            content: 'Legacy workspace shared file content.',
            fileScope: 'workspace-shared-legacy',
            workspaceId,
        }));

        const listedFiles = await listFilesForFileAccessPlan(fileAccessPlan);
        const byFilename = new Map(
            listedFiles.map(file => [file.displayFilename || file.filename, file]),
        );

        t.truthy(byFilename.get('user-global-note.txt'), 'user-global target should be listed');
        t.truthy(byFilename.get('app-shared-note.txt'), 'current app-shared target should be listed');
        t.truthy(byFilename.get('workspace-shared-note.txt'), 'legacy workspace-shared target should be listed');

        const appSharedRef = workspaceFileRef(byFilename.get('app-shared-note.txt'));
        const workspaceSharedRef = workspaceFileRef(byFilename.get('workspace-shared-note.txt'));

        const resolvedAppSharedUrl = await resolveFileParameter(appSharedRef, fileAccessPlan);
        const resolvedWorkspaceSharedUrl = await resolveFileParameter(workspaceSharedRef, fileAccessPlan);

        t.truthy(resolvedAppSharedUrl, 'current app-shared workspace ref should resolve');
        t.truthy(resolvedWorkspaceSharedUrl, 'legacy workspace-shared workspace ref should resolve');

        const chatHistory = [{
            role: 'user',
            content: [
                { type: 'file', workspacePath: appSharedRef, filename: 'app-shared-note.txt' },
                { type: 'file', workspacePath: workspaceSharedRef, filename: 'workspace-shared-note.txt' },
                { type: 'text', text: 'Compare these workspace files.' },
            ],
        }];

        const result = await syncAndStripFilesFromChatHistory(chatHistory, fileAccessPlan);
        const processedContent = result.chatHistory[0].content;

        t.truthy(processedContent.find(item => item.text?.includes('app-shared-note.txt')));
        t.truthy(processedContent.find(item => item.text?.includes('workspace-shared-note.txt')));
    } finally {
        await removeFiles(fileAccessPlan, seeded.map(file => file?.hash));
        await redisCleanup(userContextId, appSharedContextId, workspaceId);
    }
});
