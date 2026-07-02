import test from 'ava';

process.env.WHISPER_MEDIA_API_URL = 'http://media-helper.test';

let requestExecutorModulePromise;
let fileUtilsModulePromise;

async function loadRequestExecutor() {
    if (!requestExecutorModulePromise) {
        requestExecutorModulePromise = import('../../../lib/requestExecutor.js');
    }
    return await requestExecutorModulePromise;
}

async function loadFileUtils() {
    if (!fileUtilsModulePromise) {
        fileUtilsModulePromise = import('../../../lib/fileUtils.js');
    }
    return await fileUtilsModulePromise;
}

test.serial('listFilesForContext forwards applet-user routing hints to CFH', async t => {
    const { axios } = await loadRequestExecutor();
    const { listFilesForContext } = await loadFileUtils();
    const originalGet = axios.get;
    let capturedUrl = null;

    axios.get = async (url) => {
        capturedUrl = url;
        return { data: { files: [] } };
    };

    try {
        const files = await listFilesForContext(
            'applet-user:applet-123:user-456',
            {
                userId: 'user-456',
                appletId: 'applet-123',
                fileScope: 'applet-user',
            },
        );

        t.deepEqual(files, []);
        t.truthy(capturedUrl);

        const url = new URL(capturedUrl);
        t.is(url.searchParams.get('listFolder'), 'true');
        t.is(url.searchParams.get('contextId'), 'applet-user:applet-123:user-456');
        t.is(url.searchParams.get('userId'), 'user-456');
        t.is(url.searchParams.get('appletId'), 'applet-123');
        t.is(url.searchParams.get('fileScope'), 'applet-user');
    } finally {
        axios.get = originalGet;
    }
});

test.serial('user-files file access target lists the full user file share read-only', async t => {
    const { axios } = await loadRequestExecutor();
    const { getWriteFileAccessTarget, listFilesForFileAccessPlan } = await loadFileUtils();
    const originalGet = axios.get;
    let capturedUrl = null;

    axios.get = async (url) => {
        capturedUrl = url;
        return {
            data: {
                files: [
                    {
                        name: 'frog-copy.png',
                        hash: 'frog-hash',
                        url: 'https://files.test/media/frog-copy.png',
                    },
                ],
            },
        };
    };

    const fileAccessPlan = [
        { kind: 'chat', userContextId: 'user-456', chatId: 'chat-123', write: true },
        { kind: 'user-files', userContextId: 'user-456' },
    ];

    try {
        const writeTarget = getWriteFileAccessTarget(fileAccessPlan);
        t.is(writeTarget.kind, 'chat');
        t.is(writeTarget.writeFileScope, 'chat');

        const files = await listFilesForFileAccessPlan([
            { kind: 'user-files', userContextId: 'user-456' },
        ]);

        t.is(files.length, 1);
        t.is(files[0]._fileAccessKind, 'user-files');
        t.is(files[0]._readFileScope, 'all');
        t.false(files[0]._writeTarget);
        t.truthy(capturedUrl);

        const url = new URL(capturedUrl);
        t.is(url.searchParams.get('listFolder'), 'true');
        t.is(url.searchParams.get('contextId'), 'user-456');
        t.is(url.searchParams.get('userId'), 'user-456');
        t.is(url.searchParams.get('fileScope'), 'all');
    } finally {
        axios.get = originalGet;
    }
});

test.serial('app-private file access target reads applet-user and legacy workspace scopes', async t => {
    const { axios } = await loadRequestExecutor();
    const { getWriteFileAccessTarget, listFilesForFileAccessPlan } = await loadFileUtils();
    const originalGet = axios.get;
    const capturedUrls = [];

    axios.get = async (url) => {
        capturedUrls.push(url);
        const parsed = new URL(url);
        const fileScope = parsed.searchParams.get('fileScope');
        return {
            data: {
                files: [
                    {
                        name: `${fileScope}/report.txt`,
                        hash: `${fileScope}-hash`,
                        url: `https://files.test/${fileScope}/report.txt`,
                    },
                ],
            },
        };
    };

    const fileAccessPlan = [
        {
            kind: 'app-private',
            userContextId: 'user-456',
            appletId: 'applet-123',
            workspaceId: 'workspace-789',
            write: true,
        },
    ];

    try {
        const writeTarget = getWriteFileAccessTarget(fileAccessPlan);
        t.is(writeTarget.contextId, 'applet-user:applet-123:user-456');
        t.is(writeTarget.writeFileScope, 'applet-user');

        const files = await listFilesForFileAccessPlan(fileAccessPlan);

        t.is(files.length, 2);
        t.deepEqual(files.map(file => file._readFileScope).sort(), [
            'applet-user',
            'workspace-user-legacy',
        ]);
        t.deepEqual(capturedUrls.map(url => new URL(url).searchParams.get('fileScope')), [
            'applet-user',
            'workspace-user-legacy',
        ]);
        t.is(new URL(capturedUrls[0]).searchParams.get('contextId'), 'applet-user:applet-123:user-456');
        t.is(new URL(capturedUrls[1]).searchParams.get('contextId'), 'user-456');
        t.is(new URL(capturedUrls[1]).searchParams.get('workspaceId'), 'workspace-789');
    } finally {
        axios.get = originalGet;
    }
});

test.serial('scoped name listing makes documented global prefixes relative to user-global scope', async t => {
    const { axios } = await loadRequestExecutor();
    const { listFileNamesForFileAccessPlan } = await loadFileUtils();
    const originalGet = axios.get;
    const capturedUrls = [];

    axios.get = async (url) => {
        capturedUrls.push(url);
        return {
            data: {
                items: [
                    ['global/reports/q1.csv', 123, '2026-01-01T00:00:00.000Z'],
                ],
                truncated: false,
            },
        };
    };

    try {
        await listFileNamesForFileAccessPlan(
            [{ kind: 'user-global', userContextId: 'user-456', write: true }],
            { subPath: '/workspace/files/global', maxResultsPerTarget: 10 },
        );
        await listFileNamesForFileAccessPlan(
            [{ kind: 'user-global', userContextId: 'user-456', write: true }],
            { subPath: '/workspace/files/global/reports', maxResultsPerTarget: 10 },
        );

        t.is(capturedUrls.length, 2);

        const rootUrl = new URL(capturedUrls[0]);
        t.is(rootUrl.searchParams.get('operation'), 'listNames');
        t.is(rootUrl.searchParams.get('fileScope'), 'global');
        t.false(rootUrl.searchParams.has('subPath'));

        const nestedUrl = new URL(capturedUrls[1]);
        t.is(nestedUrl.searchParams.get('fileScope'), 'global');
        t.is(nestedUrl.searchParams.get('subPath'), 'reports');
    } finally {
        axios.get = originalGet;
    }
});

test.serial('scoped name listing makes documented chat prefixes relative to chat scope', async t => {
    const { axios } = await loadRequestExecutor();
    const { listFileNamesForFileAccessPlan } = await loadFileUtils();
    const originalGet = axios.get;
    const capturedUrls = [];

    axios.get = async (url) => {
        capturedUrls.push(url);
        return {
            data: {
                items: [
                    ['chats/chat-123/session-notes.txt', 456, '2026-01-01T00:00:00.000Z'],
                ],
                truncated: false,
            },
        };
    };

    try {
        await listFileNamesForFileAccessPlan(
            [{ kind: 'chat', userContextId: 'user-456', chatId: 'chat-123', write: true }],
            { subPath: '/workspace/files/chats/chat-123', maxResultsPerTarget: 10 },
        );
        await listFileNamesForFileAccessPlan(
            [{ kind: 'chat', userContextId: 'user-456', chatId: 'chat-123', write: true }],
            { subPath: '/workspace/files/chats/chat-123/uploads', maxResultsPerTarget: 10 },
        );

        t.is(capturedUrls.length, 2);

        const rootUrl = new URL(capturedUrls[0]);
        t.is(rootUrl.searchParams.get('operation'), 'listNames');
        t.is(rootUrl.searchParams.get('fileScope'), 'chat');
        t.is(rootUrl.searchParams.get('chatId'), 'chat-123');
        t.false(rootUrl.searchParams.has('subPath'));

        const nestedUrl = new URL(capturedUrls[1]);
        t.is(nestedUrl.searchParams.get('fileScope'), 'chat');
        t.is(nestedUrl.searchParams.get('chatId'), 'chat-123');
        t.is(nestedUrl.searchParams.get('subPath'), 'uploads');
    } finally {
        axios.get = originalGet;
    }
});
