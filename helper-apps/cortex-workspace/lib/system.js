import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { listBackgroundJobs } from './shell.js';

const startedAt = Date.now();
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const PERSIST_DIR = process.env.WORKSPACE_PERSIST_DIR || '/persist';
const BLOB_FILES_DIR = process.env.WORKSPACE_BLOB_FILES_DIR || '/blob-files';
const CHECKPOINT_NAME = 'workspace.tar.gz';
const CHECKPOINT_PATH = process.env.WORKSPACE_CHECKPOINT_PATH || path.join(PERSIST_DIR, CHECKPOINT_NAME);
const CHECKPOINT_PREV_PATH = path.join(path.dirname(CHECKPOINT_PATH), 'workspace.prev.tar.gz');
const CHECKPOINT_TIMEOUT_MS = parseInt(process.env.WORKSPACE_CHECKPOINT_TIMEOUT_MS || '900000', 10);
const CHECKPOINT_BLOCK_SIZE = Math.max(
    1024 * 1024,
    parseInt(process.env.WORKSPACE_CHECKPOINT_BLOCK_SIZE_BYTES || String(8 * 1024 * 1024), 10),
);
const CHECKPOINT_GZIP_LEVEL = Math.min(
    9,
    Math.max(1, parseInt(process.env.WORKSPACE_CHECKPOINT_GZIP_LEVEL || '1', 10) || 1),
);
const CHECKPOINT_COMPRESSION = (process.env.WORKSPACE_CHECKPOINT_COMPRESSION || 'auto').toLowerCase();
const WORKSPACE_FILES_DIR = path.join(WORKSPACE_DIR, 'files');
const CHECKPOINT_EXCLUDES = [
    './files',
    './.env',
    './.env.*',
    './node_modules',
    './*/node_modules',
    './*/*/node_modules',
    './*/*/*/node_modules',
    './.npm',
    './*/.npm',
    './*/*/.npm',
    './.pnpm-store',
    './*/.pnpm-store',
    './*/*/.pnpm-store',
    './.yarn/cache',
    './*/.yarn/cache',
    './*/*/.yarn/cache',
    './.bun/install/cache',
    './*/.bun/install/cache',
    './*/*/.bun/install/cache',
    './__pycache__',
    './*/__pycache__',
    './*/*/__pycache__',
    './*/*/*/__pycache__',
    './.pytest_cache',
    './*/.pytest_cache',
    './*/*/.pytest_cache',
    './.mypy_cache',
    './*/.mypy_cache',
    './*/*/.mypy_cache',
    './.ruff_cache',
    './*/.ruff_cache',
    './*/*/.ruff_cache',
    './.tox',
    './*/.tox',
    './*/*/.tox',
    './.venv',
    './*/.venv',
    './*/*/.venv',
    './venv',
    './*/venv',
    './*/*/venv',
    './.next',
    './*/.next',
    './*/*/.next',
    './dist',
    './*/dist',
    './*/*/dist',
    './build',
    './*/build',
    './*/*/build',
    './out',
    './*/out',
    './*/*/out',
    './.turbo',
    './*/.turbo',
    './*/*/.turbo',
    './.vite',
    './*/.vite',
    './*/*/.vite',
    './.parcel-cache',
    './*/.parcel-cache',
    './*/*/.parcel-cache',
    './coverage',
    './*/coverage',
    './*/*/coverage',
    './.expo',
    './*/.expo',
    './*/*/.expo',
    './.metro',
    './*/.metro',
    './*/*/.metro',
];
let _curlUploadRunnerOverride = null;
let _blockUploadRunnerOverride = null;
const _commandAvailability = new Map();

async function exposeBlobFiles() {
    try {
        execSync(`umount "${WORKSPACE_FILES_DIR}"`, { stdio: 'ignore', timeout: 5000 });
    } catch {
        try {
            execSync(`umount -l "${WORKSPACE_FILES_DIR}"`, { stdio: 'ignore', timeout: 5000 });
        } catch {
            // Not already mounted, or the platform does not support lazy unmount.
        }
    }

    try {
        await fs.rm(WORKSPACE_FILES_DIR, { recursive: true, force: true });
    } catch (e) {
        if (e.code !== 'EBUSY') throw e;
        return { mode: 'existing', warning: `${WORKSPACE_FILES_DIR} is busy; leaving existing exposure in place` };
    }
    await fs.mkdir(WORKSPACE_FILES_DIR, { recursive: true });

    try {
        execSync(`mount --bind "${BLOB_FILES_DIR}" "${WORKSPACE_FILES_DIR}"`, { stdio: 'ignore', timeout: 5000 });
        return { mode: 'bind' };
    } catch (e) {
        try {
            await fs.rm(WORKSPACE_FILES_DIR, { recursive: true, force: true });
        } catch (rmErr) {
            if (rmErr.code !== 'EBUSY') throw rmErr;
            return { mode: 'existing', warning: `${WORKSPACE_FILES_DIR} is busy after bind mount failure: ${e.message}` };
        }
        await fs.symlink(BLOB_FILES_DIR, WORKSPACE_FILES_DIR, 'dir');
        return { mode: 'symlink', warning: e.message };
    }
}

/**
 * Get system status: disk, memory, CPU, uptime, processes, background jobs.
 */
export async function getStatus() {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);

    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memory = {
        totalMB: Math.round(totalMem / 1024 / 1024),
        freeMB: Math.round(freeMem / 1024 / 1024),
        usedMB: Math.round((totalMem - freeMem) / 1024 / 1024),
        usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    };

    // CPU load
    const loadAvg = os.loadavg();
    const cpu = {
        cores: os.cpus().length,
        loadAvg1m: loadAvg[0],
        loadAvg5m: loadAvg[1],
        loadAvg15m: loadAvg[2],
    };

    // Disk usage for /workspace
    let disk = {};
    try {
        const dfOutput = execSync(`df -B1 "${WORKSPACE_DIR}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5000 });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
            const total = parseInt(parts[1], 10);
            const used = parseInt(parts[2], 10);
            const available = parseInt(parts[3], 10);
            disk = {
                totalMB: Math.round(total / 1024 / 1024),
                usedMB: Math.round(used / 1024 / 1024),
                availableMB: Math.round(available / 1024 / 1024),
                usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
            };
        }
    } catch {
        disk = { error: 'Unable to read disk info' };
    }

    // Running processes
    let processes = [];
    try {
        const psOutput = execSync('ps aux --sort=-%mem 2>/dev/null | head -11', { encoding: 'utf8', timeout: 5000 });
        const lines = psOutput.trim().split('\n');
        // Skip header, parse top 10
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            if (parts.length >= 11) {
                processes.push({
                    user: parts[0],
                    pid: parseInt(parts[1], 10),
                    cpu: parseFloat(parts[2]),
                    mem: parseFloat(parts[3]),
                    command: parts.slice(10).join(' ').slice(0, 100),
                });
            }
        }
    } catch {
        // ps not available
    }

    return {
        uptime,
        memory,
        cpu,
        disk,
        processes,
        backgroundJobs: listBackgroundJobs(),
    };
}

/**
 * Create a durable tarball checkpoint of /workspace.
 * Returns the path and size of the created archive.
 */
export async function createBackup() {
    const timestamp = new Date().toISOString();
    const started = Date.now();
    const tmpPath = buildCheckpointTmpPath(CHECKPOINT_PATH, process.pid, started);

    try {
        await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
        await fs.rm(tmpPath, { force: true });

        const compression = resolveCheckpointCompression();
        execFileSync('tar', buildCheckpointTarArgs(tmpPath, WORKSPACE_DIR, compression), {
            encoding: 'utf8',
            timeout: CHECKPOINT_TIMEOUT_MS,
        });

        let previousPath = null;
        try {
            await fs.copyFile(CHECKPOINT_PATH, CHECKPOINT_PREV_PATH);
            previousPath = CHECKPOINT_PREV_PATH;
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        await fs.rename(tmpPath, CHECKPOINT_PATH);

        const stat = await fs.stat(CHECKPOINT_PATH);
        return {
            path: CHECKPOINT_PATH,
            previousPath,
            sizeBytes: stat.size,
            sizeMB: Math.round(stat.size / 1024 / 1024 * 100) / 100,
            timestamp,
            durationMs: Date.now() - started,
            compression: compression.id,
        };
    } catch (e) {
        try {
            await fs.rm(tmpPath, { force: true });
        } catch {
            // Best effort cleanup only.
        }
        return { error: `Backup failed: ${e.message}` };
    }
}

function normalizeCheckpointCompressionId(value) {
    const id = String(value || '').toLowerCase();
    if (id === 'zstd' || id === 'zst') return 'zstd';
    if (id === 'pigz') return 'pigz';
    if (id === 'gzip' || id === 'gz') return 'gzip';
    if (id === 'auto' || id === '') return 'auto';
    throw new Error(`Unsupported checkpoint compression: ${value}`);
}

function commandAvailable(command) {
    if (_commandAvailability.has(command)) return _commandAvailability.get(command);
    let available = false;
    try {
        execFileSync('sh', ['-lc', `command -v ${command}`], {
            stdio: 'ignore',
            timeout: 1000,
        });
        available = true;
    } catch {
        available = false;
    }
    _commandAvailability.set(command, available);
    return available;
}

function checkpointCompressionDefinition(id) {
    if (id === 'zstd') {
        return {
            id: 'zstd',
            createProgram: 'zstd -T0 -1',
            extractProgram: 'zstd',
        };
    }
    if (id === 'pigz') {
        return {
            id: 'pigz',
            createProgram: `pigz -${CHECKPOINT_GZIP_LEVEL}`,
            extractProgram: 'pigz',
        };
    }
    return {
        id: 'gzip',
        createProgram: `gzip -${CHECKPOINT_GZIP_LEVEL}`,
        extractProgram: 'gzip',
    };
}

function resolveCheckpointCompression(requested = CHECKPOINT_COMPRESSION, isCommandAvailable = commandAvailable) {
    const id = normalizeCheckpointCompressionId(requested);
    if (id === 'auto') {
        if (isCommandAvailable('zstd')) return checkpointCompressionDefinition('zstd');
        if (isCommandAvailable('pigz')) return checkpointCompressionDefinition('pigz');
        return checkpointCompressionDefinition('gzip');
    }
    if ((id === 'zstd' || id === 'pigz') && !isCommandAvailable(id)) {
        throw new Error(`Checkpoint compression ${id} requested but ${id} is not installed`);
    }
    return checkpointCompressionDefinition(id);
}

async function detectCheckpointCompressionFromFile(archivePath) {
    let handle;
    try {
        handle = await fs.open(archivePath, 'r');
        const buffer = Buffer.alloc(4);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd) {
            return 'zstd';
        }
        if (bytesRead >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
            return 'gzip';
        }
    } finally {
        if (handle) await handle.close();
    }
    return 'gzip';
}

function buildCheckpointTarArgs(targetPath, workspaceDir, compression = resolveCheckpointCompression()) {
    const resolved = typeof compression === 'string'
        ? resolveCheckpointCompression(compression)
        : compression;
    return [
        `--use-compress-program=${resolved.createProgram}`,
        '-cf',
        targetPath,
        ...CHECKPOINT_EXCLUDES.map(exclude => `--exclude=${exclude}`),
        '-C',
        workspaceDir,
        '.',
    ];
}

function buildCheckpointExtractArgs(sourcePath, workspaceDir, compression = 'gzip') {
    const resolved = typeof compression === 'string'
        ? checkpointCompressionDefinition(normalizeCheckpointCompressionId(compression))
        : compression;
    return [
        `--use-compress-program=${resolved.extractProgram}`,
        '-xf',
        sourcePath,
        '--no-same-owner',
        '-C',
        workspaceDir,
    ];
}

function buildCheckpointTmpPath(checkpointPath, pid = process.pid, started = Date.now()) {
    return `${checkpointPath}.${pid}.${started}.tmp`;
}

/**
 * Restore workspace from a tarball at the given path.
 */
export async function restoreBackup(archivePath) {
    try {
        const stat = await fs.stat(archivePath);
        if (!stat.isFile()) {
            return { error: `Not a file: ${archivePath}` };
        }

        const compression = await detectCheckpointCompressionFromFile(archivePath);
        // Extract to /workspace (overwrites existing files)
        execFileSync(
            'tar',
            buildCheckpointExtractArgs(archivePath, WORKSPACE_DIR, compression),
            { encoding: 'utf8', timeout: CHECKPOINT_TIMEOUT_MS }
        );

        const exposeResult = await exposeBlobFiles();

        return {
            message: 'Workspace restored from backup',
            archivePath,
            sizeBytes: stat.size,
            compression,
            filesPathMode: exposeResult.mode,
            warning: exposeResult.warning,
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { error: `Archive not found: ${archivePath}` };
        return { error: `Restore failed: ${e.message}` };
    }
}

export async function restoreBackupFromUrl(archiveUrl, archivePath = CHECKPOINT_PATH) {
    try {
        if (!archiveUrl || typeof archiveUrl !== 'string') {
            return { error: 'archiveUrl is required' };
        }
        if (!archiveUrl.startsWith('https://')) {
            return { error: 'archiveUrl must be an HTTPS URL' };
        }

        const targetPath = archivePath || CHECKPOINT_PATH;
        const tempPath = `${targetPath}.download`;
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rm(tempPath, { force: true });

        const response = await fetch(archiveUrl);
        if (!response.ok || !response.body) {
            return { error: `Download failed: ${response.status} ${response.statusText}` };
        }

        await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
        await fs.rename(tempPath, targetPath);
        return await restoreBackup(targetPath);
    } catch (e) {
        try {
            const targetPath = archivePath || CHECKPOINT_PATH;
            await fs.rm(`${targetPath}.download`, { force: true });
        } catch {
            // Best effort cleanup only.
        }
        return { error: `Restore from URL failed: ${e.message}` };
    }
}

function parseCheckpointEncryption(encryption) {
    if (!encryption) return null;
    if (encryption.algorithm !== 'aes-256-gcm') {
        throw new Error(`Unsupported checkpoint encryption algorithm: ${encryption.algorithm || 'unknown'}`);
    }
    if (!encryption.keyBase64 || typeof encryption.keyBase64 !== 'string') {
        throw new Error('checkpoint encryption key is required');
    }
    const key = Buffer.from(encryption.keyBase64, 'base64');
    if (key.length !== 32) {
        throw new Error('checkpoint encryption key must be 32 bytes');
    }
    const iv = encryption.ivBase64
        ? Buffer.from(encryption.ivBase64, 'base64')
        : crypto.randomBytes(12);
    if (iv.length !== 12) {
        throw new Error('checkpoint encryption iv must be 12 bytes');
    }
    const tag = encryption.tagBase64 ? Buffer.from(encryption.tagBase64, 'base64') : null;
    if (tag && tag.length !== 16) {
        throw new Error('checkpoint encryption tag must be 16 bytes');
    }
    return {
        algorithm: 'aes-256-gcm',
        key,
        keyId: encryption.keyId || null,
        iv,
        tag,
        compression: normalizeCheckpointCompressionId(encryption.compression || encryption.checkpointCompression || 'gzip'),
    };
}

async function restoreEncryptedBackupFromUrl(archiveUrl, encryption, timeoutMs = CHECKPOINT_TIMEOUT_MS) {
    const parsed = parseCheckpointEncryption(encryption);
    if (!parsed.tag) {
        return { error: 'checkpoint encryption tag is required' };
    }

    const response = await fetch(archiveUrl);
    if (!response.ok || !response.body) {
        return { error: `Download failed: ${response.status} ${response.statusText}` };
    }

    const decipher = crypto.createDecipheriv(parsed.algorithm, parsed.key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    const tar = spawn('tar', buildCheckpointExtractArgs('-', WORKSPACE_DIR, parsed.compression), {
        stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    tar.stderr.setEncoding('utf8');
    tar.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8192); });
    const timeout = setTimeout(() => {
        tar.kill('SIGTERM');
    }, timeoutMs);
    if (timeout.unref) timeout.unref();
    const tarExit = waitForChildClose(tar);

    try {
        await pipeline(Readable.fromWeb(response.body), decipher, tar.stdin);
        const exitCode = await tarExit;
        if (exitCode !== 0) {
            return { error: `tar restore failed: ${stderr || `exit ${exitCode}`}` };
        }
        return {
            message: 'Workspace restored from encrypted backup',
            encrypted: true,
            compression: parsed.compression,
        };
    } catch (e) {
        tar.kill('SIGTERM');
        return { error: `Encrypted restore failed: ${e.message}` };
    } finally {
        clearTimeout(timeout);
    }
}

export async function restoreBackupFromUrlEncrypted(archiveUrl, encryption) {
    try {
        if (!archiveUrl || typeof archiveUrl !== 'string') {
            return { error: 'archiveUrl is required' };
        }
        if (!archiveUrl.startsWith('https://')) {
            return { error: 'archiveUrl must be an HTTPS URL' };
        }
        return await restoreEncryptedBackupFromUrl(archiveUrl, encryption);
    } catch (e) {
        return { error: `Restore from encrypted URL failed: ${e.message}` };
    }
}

function curlConfigValue(value) {
    return `"${String(value)
        .replace(/[\r\n]/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')}"`;
}

function buildCurlUploadConfig(archiveUrl, sourcePath, headers) {
    return [
        'fail',
        'silent',
        'show-error',
        'request = "PUT"',
        `url = ${curlConfigValue(archiveUrl)}`,
        `upload-file = ${curlConfigValue(sourcePath)}`,
        'output = "/dev/null"',
        'write-out = "http_code=%{http_code} time_total=%{time_total} size_upload=%{size_upload} speed_upload=%{speed_upload}\\n"',
        ...Object.entries(headers).map(([key, value]) => (
            `header = ${curlConfigValue(`${key}: ${value}`)}`
        )),
    ].join('\n') + '\n';
}

function runCurlUpload(configText, timeoutMs = CHECKPOINT_TIMEOUT_MS) {
    if (_curlUploadRunnerOverride) {
        return _curlUploadRunnerOverride(configText, timeoutMs);
    }

    return new Promise((resolve) => {
        const child = spawn('curl', ['--config', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        const limitOutput = (current, chunk) => `${current}${chunk}`.slice(-8192);
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
        }, timeoutMs);
        if (timeout.unref) timeout.unref();

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout = limitOutput(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = limitOutput(stderr, chunk); });
        child.on('error', error => {
            clearTimeout(timeout);
            resolve({ success: false, error: error.message, stdout, stderr });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve({ success: true, stdout, stderr });
                return;
            }
            const status = signal ? `signal ${signal}` : `exit ${code}`;
            resolve({ success: false, error: `curl ${status}`, stdout, stderr });
        });

        child.stdin.end(configText);
    });
}

export async function uploadBackupToUrl(archiveUrl, archivePath = CHECKPOINT_PATH, metadata = {}) {
    try {
        if (!archiveUrl || typeof archiveUrl !== 'string') {
            return { error: 'archiveUrl is required' };
        }
        if (!archiveUrl.startsWith('https://')) {
            return { error: 'archiveUrl must be an HTTPS URL' };
        }

        const sourcePath = archivePath || CHECKPOINT_PATH;
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) {
            return { error: `Not a file: ${sourcePath}` };
        }

        const headers = {
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': 'application/gzip',
            'Content-Length': String(stat.size),
            Expect: '',
        };
        for (const [key, value] of Object.entries(metadata || {})) {
            if (value == null) continue;
            const safeKey = String(key).replace(/[^A-Za-z0-9_]/g, '');
            if (!safeKey) continue;
            headers[`x-ms-meta-${safeKey}`] = String(value);
        }

        const started = Date.now();
        const upload = await runCurlUpload(buildCurlUploadConfig(archiveUrl, sourcePath, headers));
        if (!upload.success) {
            const detail = [upload.error, upload.stderr, upload.stdout]
                .filter(Boolean)
                .join(': ');
            return { error: `Upload failed: ${detail || 'curl failed'}` };
        }

        return {
            message: 'Workspace backup uploaded',
            archivePath: sourcePath,
            sizeBytes: stat.size,
            durationMs: Date.now() - started,
            uploadMethod: 'curl',
            uploadStats: upload.stdout.trim() || undefined,
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { error: `Archive not found: ${archivePath || CHECKPOINT_PATH}` };
        return { error: `Upload to URL failed: ${e.message}` };
    }
}

function appendSasQuery(url, params) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${params}`;
}

function safeMetadataHeaders(metadata = {}) {
    const headers = {};
    for (const [key, value] of Object.entries(metadata || {})) {
        if (value == null) continue;
        const safeKey = String(key).replace(/[^A-Za-z0-9_]/g, '');
        if (!safeKey) continue;
        headers[`x-ms-meta-${safeKey}`] = String(value);
    }
    return headers;
}

async function uploadBlock(archiveUrl, blockId, chunk) {
    if (_blockUploadRunnerOverride) {
        return _blockUploadRunnerOverride({ type: 'block', archiveUrl, blockId, chunk });
    }
    const response = await fetch(appendSasQuery(archiveUrl, `comp=block&blockid=${encodeURIComponent(blockId)}`), {
        method: 'PUT',
        headers: {
            'Content-Length': String(chunk.length),
        },
        body: chunk,
    });
    if (!response.ok) {
        throw new Error(`block upload failed: ${response.status} ${response.statusText}`);
    }
}

async function commitBlockList(archiveUrl, blockIds, metadata) {
    const body = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<BlockList>',
        ...blockIds.map(blockId => `<Latest>${blockId}</Latest>`),
        '</BlockList>',
    ].join('');
    if (_blockUploadRunnerOverride) {
        return _blockUploadRunnerOverride({ type: 'commit', archiveUrl, blockIds, body, metadata });
    }
    const response = await fetch(appendSasQuery(archiveUrl, 'comp=blocklist'), {
        method: 'PUT',
        headers: {
            'Content-Length': String(Buffer.byteLength(body)),
            'Content-Type': 'application/xml',
            'x-ms-blob-content-type': 'application/octet-stream',
            ...safeMetadataHeaders(metadata),
        },
        body,
    });
    if (!response.ok) {
        throw new Error(`block list commit failed: ${response.status} ${response.statusText}`);
    }
}

function waitForChildClose(child) {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
}

function createAzureBlockUploadWritable(archiveUrl, options = {}) {
    const blockSize = options.blockSize || CHECKPOINT_BLOCK_SIZE;
    let pending = Buffer.alloc(0);
    let index = 0;
    let sizeBytes = 0;
    const blockIds = [];

    const uploadPendingBlocks = async (force = false) => {
        while (pending.length >= blockSize || (force && pending.length > 0)) {
            const chunk = pending.subarray(0, Math.min(blockSize, pending.length));
            pending = pending.subarray(chunk.length);
            const blockId = Buffer.from(String(index).padStart(8, '0')).toString('base64');
            index += 1;
            blockIds.push(blockId);
            sizeBytes += chunk.length;
            await uploadBlock(archiveUrl, blockId, chunk);
        }
    };

    const writable = new Writable({
        async write(chunk, _encoding, callback) {
            try {
                pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
                await uploadPendingBlocks(false);
                callback();
            } catch (e) {
                callback(e);
            }
        },
        async final(callback) {
            try {
                await uploadPendingBlocks(true);
                callback();
            } catch (e) {
                callback(e);
            }
        },
    });

    writable.getUploadState = () => ({ blockIds, sizeBytes });
    return writable;
}

export async function uploadStreamingBackupToUrl(archiveUrl, metadata = {}, encryption = {}) {
    const started = Date.now();
    try {
        if (!archiveUrl || typeof archiveUrl !== 'string') {
            return { error: 'archiveUrl is required' };
        }
        if (!archiveUrl.startsWith('https://')) {
            return { error: 'archiveUrl must be an HTTPS URL' };
        }

        const parsed = parseCheckpointEncryption(encryption);
        const cipher = crypto.createCipheriv(parsed.algorithm, parsed.key, parsed.iv);
        const uploader = createAzureBlockUploadWritable(archiveUrl);
        const compression = resolveCheckpointCompression();
        const tar = spawn('tar', buildCheckpointTarArgs('-', WORKSPACE_DIR, compression), {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const tarExit = waitForChildClose(tar);
        let stderr = '';
        tar.stderr.setEncoding('utf8');
        tar.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8192); });
        const timeout = setTimeout(() => {
            tar.kill('SIGTERM');
        }, CHECKPOINT_TIMEOUT_MS);
        if (timeout.unref) timeout.unref();

        try {
            await pipeline(tar.stdout, cipher, uploader);
            const exitCode = await tarExit;
            if (exitCode !== 0) {
                return { error: `tar backup failed: ${stderr || `exit ${exitCode}`}` };
            }
        } catch (e) {
            tar.kill('SIGTERM');
            return { error: `Encrypted backup stream failed: ${e.message}` };
        } finally {
            clearTimeout(timeout);
        }

        const tag = cipher.getAuthTag();
        const uploadState = uploader.getUploadState();
        const encryptionMetadata = {
            checkpointEncryptionAlgorithm: parsed.algorithm,
            checkpointEncryptionKeyId: parsed.keyId || '',
            checkpointEncryptionIv: parsed.iv.toString('base64'),
            checkpointEncryptionTag: tag.toString('base64'),
            checkpointCompression: compression.id,
        };
        await commitBlockList(archiveUrl, uploadState.blockIds, {
            ...metadata,
            ...encryptionMetadata,
        });

        return {
            message: 'Encrypted workspace backup uploaded',
            encrypted: true,
            sizeBytes: uploadState.sizeBytes,
            durationMs: Date.now() - started,
            uploadMethod: 'azure-block-stream',
            compression: compression.id,
            encryption: {
                algorithm: parsed.algorithm,
                keyId: parsed.keyId,
                ivBase64: parsed.iv.toString('base64'),
                tagBase64: tag.toString('base64'),
                compression: compression.id,
            },
        };
    } catch (e) {
        return { error: `Encrypted upload to URL failed: ${e.message}` };
    }
}

export const __testables = {
    buildCheckpointTarArgs,
    buildCheckpointExtractArgs,
    buildCheckpointTmpPath,
    buildCurlUploadConfig,
    createAzureBlockUploadWritable,
    detectCheckpointCompressionFromFile,
    parseCheckpointEncryption,
    resolveCheckpointCompression,
    waitForChildClose,
    CHECKPOINT_EXCLUDES,
    setBlockUploadRunnerForTest(fn) {
        _blockUploadRunnerOverride = fn;
    },
    setCurlUploadRunnerForTest(fn) {
        _curlUploadRunnerOverride = fn;
    },
};

/**
 * Reset workspace: wipe /workspace except preserved paths.
 */
export async function resetWorkspace(preservePaths = []) {
    const workspaceDir = WORKSPACE_DIR;

    const preserveSet = new Set(preservePaths.map((p) => {
        const normalized = p.startsWith(WORKSPACE_DIR)
            ? p.slice(WORKSPACE_DIR.length)
            : p;
        return normalized.replace(/^\//, '').replace(/\/$/, '');
    }));

    // Always preserve /workspace/files — it may be a FUSE mount (blobfuse2)
    preserveSet.add('files');

    try {
        const entries = await fs.readdir(workspaceDir);
        let removed = 0;

        for (const entry of entries) {
            if (preserveSet.has(entry)) continue;
            const fullPath = `${workspaceDir}/${entry}`;
            await fs.rm(fullPath, { recursive: true, force: true });
            removed++;
        }

        return {
            message: `Workspace reset. Removed ${removed} items.`,
            preservedPaths: [...preserveSet],
        };
    } catch (e) {
        return { error: `Failed to reset workspace: ${e.message}` };
    }
}
