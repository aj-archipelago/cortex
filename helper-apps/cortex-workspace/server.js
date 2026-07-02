import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execSync as shellExecSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { requireAuth, setSecret } from './lib/auth.js';
import { execSync, execBackground, getResult, listBackgroundJobs } from './lib/shell.js';
import { readFile, writeFile, editFile, browseDir } from './lib/files.js';
import {
    getStatus,
    resetWorkspace,
    createBackup,
    restoreBackup,
    restoreBackupFromUrl,
    restoreBackupFromUrlEncrypted,
    uploadBackupToUrl,
    uploadStreamingBackupToUrl,
} from './lib/system.js';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const BLOB_FILES_DIR = process.env.WORKSPACE_BLOB_FILES_DIR || '/cloud-files';
const WORKSPACE_FILES_DIR = path.join(WORKSPACE_DIR, 'files');

// Wrap async route handlers so Express 4 catches rejections
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.use(express.json({ limit: '10mb' }));

function unmountPath(mountPath) {
    try {
        shellExecSync(`umount "${mountPath}"`, { stdio: 'ignore', timeout: 5000 });
        return;
    } catch {
        // Fall through to lazy unmount.
    }

    try {
        shellExecSync(`umount -l "${mountPath}"`, { stdio: 'ignore', timeout: 5000 });
    } catch {
        // Not already mounted, or the platform does not support lazy unmount.
    }
}

function isSymlink(targetPath) {
    try {
        return fs.lstatSync(targetPath).isSymbolicLink();
    } catch {
        return false;
    }
}

function unmountWorkspaceFilesExposure() {
    if (!isSymlink(WORKSPACE_FILES_DIR)) {
        unmountPath(WORKSPACE_FILES_DIR);
    }
}

function exposeBlobFiles() {
    unmountWorkspaceFilesExposure();

    try {
        fs.rmSync(WORKSPACE_FILES_DIR, { recursive: true, force: true });
    } catch (e) {
        if (e.code !== 'EBUSY') throw e;
        return { mode: 'existing', warning: `${WORKSPACE_FILES_DIR} is busy; leaving existing exposure in place` };
    }

    try {
        fs.symlinkSync(BLOB_FILES_DIR, WORKSPACE_FILES_DIR, 'dir');
        return { mode: 'symlink' };
    } catch (e) {
        return { mode: 'existing', warning: `failed to symlink ${WORKSPACE_FILES_DIR} to ${BLOB_FILES_DIR}: ${e.message}` };
    }
}

// --- Unauthenticated ---

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version });
});

// --- Authenticated routes ---

app.use(requireAuth);

// Shell execution
app.post('/shell', wrap(async (req, res) => {
    const { command, cwd, timeout, background, processId } = req.body;

    if (processId) {
        return res.json(getResult(processId));
    }

    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'command is required' });
    }

    if (background) {
        return res.json(execBackground(command, { cwd, timeout }));
    }

    const result = await execSync(command, { cwd, timeout });
    res.json(result);
}));

// Poll background process result
app.get('/shell/result/:processId', (req, res) => {
    res.json(getResult(req.params.processId));
});

// List all background processes
app.get('/shell/jobs', (_req, res) => {
    res.json(listBackgroundJobs());
});

// Read file
app.post('/read', wrap(async (req, res) => {
    const { path, startLine, endLine, encoding } = req.body;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    res.json(await readFile(path, { startLine, endLine, encoding }));
}));

// Write file
app.post('/write', wrap(async (req, res) => {
    const { path, content, encoding, createDirs } = req.body;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    if (content === undefined || content === null) {
        return res.status(400).json({ error: 'content is required' });
    }
    res.json(await writeFile(path, content, { encoding, createDirs }));
}));

// Edit file (search-and-replace)
app.post('/edit', wrap(async (req, res) => {
    const { path, oldString, newString, replaceAll } = req.body;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    if (!oldString || typeof oldString !== 'string') {
        return res.status(400).json({ error: 'oldString is required' });
    }
    if (newString === undefined || newString === null) {
        return res.status(400).json({ error: 'newString is required' });
    }
    res.json(await editFile(path, oldString, newString, { replaceAll }));
}));

// Browse directory
app.post('/browse', wrap(async (req, res) => {
    const { path: dirPath, recursive, maxDepth } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    res.json(await browseDir(dirPath, { recursive, maxDepth }));
}));

// System status
app.get('/status', wrap(async (_req, res) => {
    res.json(await getStatus());
}));

// Create backup tarball of /workspace
app.post('/backup', wrap(async (_req, res) => {
    res.json(await createBackup());
}));

// Restore workspace from a tarball
app.post('/restore', wrap(async (req, res) => {
    const { archivePath } = req.body;
    if (!archivePath || typeof archivePath !== 'string') {
        return res.status(400).json({ error: 'archivePath is required' });
    }
    res.json(await restoreBackup(archivePath));
}));

// Download and restore a workspace tarball directly from Blob/SAS URL.
app.post('/restore-url', wrap(async (req, res) => {
    const { archiveUrl, archivePath, encryption } = req.body;
    if (encryption) {
        res.json(await restoreBackupFromUrlEncrypted(archiveUrl, encryption));
        return;
    }
    res.json(await restoreBackupFromUrl(archiveUrl, archivePath));
}));

// Upload a workspace tarball directly to Blob/SAS URL.
app.post('/upload-url', wrap(async (req, res) => {
    const { archiveUrl, archivePath, metadata } = req.body;
    res.json(await uploadBackupToUrl(archiveUrl, archivePath, metadata));
}));

// Stream tar/gzip output through encryption directly to Blob blocks.
app.post('/backup-upload-url', wrap(async (req, res) => {
    const { archiveUrl, metadata, encryption } = req.body;
    res.json(await uploadStreamingBackupToUrl(archiveUrl, metadata, encryption));
}));

// Reset workspace
app.post('/reset', wrap(async (req, res) => {
    res.json(await resetWorkspace(req.body.preservePaths));
}));

// Stream-download a file from the container
app.get('/download', wrap(async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path query parameter is required' });
    }

    let stat;
    try {
        stat = await fs.promises.stat(filePath);
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: `File not found: ${filePath}` });
        if (err.code === 'EACCES') return res.status(403).json({ error: `Permission denied: ${filePath}` });
        throw err;
    }

    if (!stat.isFile()) {
        return res.status(400).json({ error: `Not a file: ${filePath}` });
    }

    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    await pipeline(stream, res);
}));

// Stream-upload a file into the container
app.post('/upload', wrap(async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path query parameter is required' });
    }

    // Ensure parent directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    const ws = fs.createWriteStream(filePath);
    await pipeline(req, ws);

    const stat = await fs.promises.stat(filePath);
    res.json({ path: filePath, bytesWritten: stat.size });
}));

// Reconfigure — rotates secret, injects env vars, mounts blob storage at runtime.
// Used by the warm pool: a pool container starts "clean" and gets reconfigured
// when claimed by a specific entity.
app.post('/reconfigure', wrap(async (req, res) => {
    const { secret, blobMount, env } = req.body;

    // 1. Mount blob storage via blobfuse2 (optional)
    if (blobMount) {
        const { accountName, sasToken, containerName } = blobMount;
        if (!accountName || !sasToken || !containerName) {
            return res.status(400).json({ error: 'blobMount requires accountName, sasToken, and containerName' });
        }

        const configYaml = [
            'logging:',
            '  type: syslog',
            '  level: log_warning',
            'components:',
            '  - libfuse',
            '  - file_cache',
            '  - attr_cache',
            '  - azstorage',
            'libfuse:',
            '  attribute-expiration-sec: 120',
            '  entry-expiration-sec: 120',
            '  negative-entry-expiration-sec: 240',
            'file_cache:',
            '  path: /tmp/blobfuse2-cache',
            '  timeout-sec: 120',
            '  max-size-mb: 512',
            'attr_cache:',
            '  timeout-sec: 7200',
            'azstorage:',
            '  type: block',
            `  account-name: ${accountName}`,
            `  sas: ${sasToken}`,
            `  container: ${containerName}`,
            '  endpoint: https://' + accountName + '.blob.core.windows.net',
        ].join('\n') + '\n';

        fs.writeFileSync('/tmp/blobfuse2-reconfig.yaml', configYaml);
        fs.mkdirSync('/tmp/blobfuse2-cache', { recursive: true });
        fs.mkdirSync(BLOB_FILES_DIR, { recursive: true });

        try {
            // The image starts without blob credentials for warm-pool/fresh
            // containers, so detach any old compatibility mount before
            // mounting blobfuse on the cloud files directory.
            unmountWorkspaceFilesExposure();
            unmountPath(BLOB_FILES_DIR);
            shellExecSync(
                `blobfuse2 mount "${BLOB_FILES_DIR}" --config-file=/tmp/blobfuse2-reconfig.yaml --allow-other --set-content-type=true -o nonempty`,
                { stdio: 'pipe', timeout: 30000 },
            );
            const exposeResult = exposeBlobFiles();
            if (exposeResult.warning) {
                console.warn(`WARNING: ${WORKSPACE_FILES_DIR} exposure warning: ${exposeResult.warning}`);
            }
        } catch (e) {
            return res.status(500).json({ error: `blobfuse2 mount failed: ${e.stderr?.toString() || e.message}` });
        }
    }

    // 2. Inject environment variables (optional)
    if (env && typeof env === 'object') {
        const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const envContent = Object.entries(env)
            .filter(([k]) => SAFE_KEY.test(k))
            .map(([k, v]) => {
                const escaped = String(v).replace(/'/g, "'\\''");
                return `export ${k}='${escaped}'`;
            })
            .join('\n') + '\n';

        fs.writeFileSync('/workspace/.env', envContent);

        // Ensure .bashrc sources .env
        const sourceLine = '[ -f /workspace/.env ] && . /workspace/.env';
        const bashrcPath = path.join(process.env.HOME || '/root', '.bashrc');
        try {
            const bashrc = fs.existsSync(bashrcPath) ? fs.readFileSync(bashrcPath, 'utf8') : '';
            if (!bashrc.includes(sourceLine)) {
                fs.appendFileSync(bashrcPath, '\n' + sourceLine + '\n');
            }
        } catch {
            // Best-effort
        }
    }

    // 3. Rotate secret (done LAST so caller can retry with old secret if 1-2 fail)
    if (secret && typeof secret === 'string') {
        setSecret(secret);
    }

    res.json({ success: true });
}));

// Global error handler — async rejections now route here via wrap()
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Workspace client listening on port ${PORT}`);
});
