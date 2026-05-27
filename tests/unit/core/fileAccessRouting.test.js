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
