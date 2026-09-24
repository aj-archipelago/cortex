import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const CHECKPOINT_EXCLUDES = [
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

const excluded = CHECKPOINT_EXCLUDES.map(pattern => new RegExp(`^${pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));

// Use the same exclusions as tar. Never follow links into mounted cloud files.
// These hashes describe file metadata, not file contents; they are a cheap
// change hint and a restore inventory, never a substitute for periodic backups.
export async function collectCheckpointInventory(root) {
    const shape = crypto.createHash('sha256');
    const changes = crypto.createHash('sha256');
    let fileCount = 0, fileBytes = 0, entryCount = 0;
    const topLevelPaths = [];
    async function walk(relative = '') {
        const names = (await fs.readdir(path.join(root, relative))).sort();
        for (const name of names) {
            const relativePath = relative ? `${relative}/${name}` : name;
            if (excluded.some(pattern => pattern.test(`./${relativePath}`))) continue;
            const absolute = path.join(root, relativePath);
            const stat = await fs.lstat(absolute);
            const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
            if (!type) throw new Error('Workspace contains an unsupported checkpoint file type');
            const target = type === 'link' ? await fs.readlink(absolute) : null;
            const bytes = type === 'file' ? stat.size : 0;
            const record = [relativePath, type, bytes, stat.mode & 0o777, target];
            shape.update(JSON.stringify(record) + '\n');
            // Directory mtimes change on extraction. File ctime catches writes
            // that preserve size and mtime, without reading file contents.
            changes.update(JSON.stringify([...record, type === 'directory' ? 0 : stat.mtimeMs, type === 'directory' ? 0 : stat.ctimeMs]) + '\n');
            entryCount++;
            if (type !== 'directory') { fileCount++; fileBytes += bytes; }
            const displayName = name.slice(0, 100);
            if (!relative && topLevelPaths.length < 20 && Buffer.byteLength(JSON.stringify([...topLevelPaths, displayName])) <= 1536) topLevelPaths.push(displayName);
            if (type === 'directory') await walk(relativePath);
        }
    }
    await walk();
    return { version: 1, fileCount, fileBytes, entryCount, topLevelPaths, structureHash: shape.digest('hex'), fingerprint: changes.digest('hex') };
}

export function validCheckpointInventory(value) {
    return value?.version === 1
        && ['fileCount', 'fileBytes', 'entryCount'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
        && value.entryCount >= value.fileCount
        && ['structureHash', 'fingerprint'].every(key => /^[a-f0-9]{64}$/.test(value[key]))
        && Array.isArray(value.topLevelPaths) && value.topLevelPaths.length <= 20
        && value.topLevelPaths.every(name => typeof name === 'string' && name.length <= 100);
}

export function encodeCheckpointInventory(value) {
    if (!validCheckpointInventory(value)) throw new Error('Invalid workspace checkpoint inventory');
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 4096) throw new Error('Workspace checkpoint inventory metadata is too large');
    return Buffer.from(json).toString('base64');
}

export function inventoryFromMetadata(metadata = {}) {
    const raw = Object.entries(metadata).find(([key]) => key.toLowerCase() === 'checkpointinventory')?.[1];
    if (!raw) return null; // Older checkpoints remain readable.
    let value;
    try { value = JSON.parse(Buffer.from(raw, 'base64').toString()); } catch { /* rejected below */ }
    if (!validCheckpointInventory(value)) throw new Error('Invalid workspace checkpoint inventory metadata');
    return value;
}

export function assertCheckpointInventory(expected, actual) {
    if (!validCheckpointInventory(expected) || !validCheckpointInventory(actual)
        || expected.structureHash !== actual.structureHash) {
        throw new Error('Restored workspace inventory does not match its checkpoint');
    }
}
