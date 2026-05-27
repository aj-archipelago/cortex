import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_READ_BYTES = 100 * 1024; // 100KB
const MAX_LINES = 1000;

/**
 * Read file contents with optional line range.
 */
export async function readFile(filePath, options = {}) {
    const { startLine, endLine, encoding } = options;

    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            return { error: `Not a file: ${filePath}` };
        }

        if (encoding === 'base64') {
            const buf = await fs.readFile(filePath);
            return {
                content: buf.toString('base64'),
                totalBytes: stat.size,
                encoding: 'base64',
                truncated: false,
            };
        }

        const raw = await fs.readFile(filePath, 'utf8');
        const lines = raw.split(/\r?\n/);
        const totalLines = lines.length;
        const totalBytes = stat.size;

        let selected = lines;
        let actualStart = 1;
        let actualEnd = totalLines;
        let truncated = false;

        if (startLine !== undefined || endLine !== undefined) {
            const start = Math.max(1, startLine || 1) - 1; // to 0-indexed
            const end = endLine !== undefined ? Math.min(totalLines, endLine) : Math.min(totalLines, start + MAX_LINES);
            selected = lines.slice(start, end);
            actualStart = start + 1;
            actualEnd = Math.min(end, totalLines);
            truncated = actualEnd < totalLines || actualStart > 1;
        } else if (lines.length > MAX_LINES) {
            selected = lines.slice(0, MAX_LINES);
            actualEnd = MAX_LINES;
            truncated = true;
        }

        let content = selected.join('\n');
        if (content.length > MAX_READ_BYTES) {
            content = content.slice(0, MAX_READ_BYTES);
            truncated = true;
        }

        return {
            content,
            totalLines,
            totalBytes,
            startLine: actualStart,
            endLine: actualEnd,
            returnedLines: selected.length,
            truncated,
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { error: `File not found: ${filePath}` };
        if (e.code === 'EACCES') return { error: `Permission denied: ${filePath}` };
        return { error: e.message };
    }
}

/**
 * Write content to a file. Creates parent directories by default.
 */
export async function writeFile(filePath, content, options = {}) {
    const { encoding, createDirs = true } = options;

    try {
        if (createDirs) {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
        }

        let buf;
        if (encoding === 'base64') {
            buf = Buffer.from(content, 'base64');
        } else {
            buf = Buffer.from(content, 'utf8');
        }

        await fs.writeFile(filePath, buf);

        return {
            path: filePath,
            bytesWritten: buf.length,
        };
    } catch (e) {
        if (e.code === 'EACCES') return { error: `Permission denied: ${filePath}` };
        return { error: e.message };
    }
}

/**
 * Search-and-replace in a file (exact string match).
 */
export async function editFile(filePath, oldString, newString, options = {}) {
    const { replaceAll = false } = options;

    try {
        const content = await fs.readFile(filePath, 'utf8');

        if (!content.includes(oldString)) {
            return { error: `String not found in ${filePath}` };
        }

        let updated;
        let replacements;
        if (replaceAll) {
            replacements = content.split(oldString).length - 1;
            updated = content.split(oldString).join(newString);
        } else {
            replacements = 1;
            updated = content.replace(oldString, newString);
        }

        await fs.writeFile(filePath, updated, 'utf8');

        return {
            path: filePath,
            replacements,
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { error: `File not found: ${filePath}` };
        if (e.code === 'EACCES') return { error: `Permission denied: ${filePath}` };
        return { error: e.message };
    }
}

/**
 * Browse directory contents.
 */
export async function browseDir(dirPath, options = {}) {
    const { recursive = false, maxDepth = 3 } = options;

    async function listEntries(dir, depth) {
        const entries = [];
        try {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                const entry = { name: item.name };

                if (item.isDirectory()) {
                    entry.type = 'directory';
                    try {
                        const stat = await fs.stat(fullPath);
                        entry.modified = stat.mtime.toISOString();
                    } catch { /* ignore stat errors */ }
                    if (recursive && depth < maxDepth) {
                        entry.children = await listEntries(fullPath, depth + 1);
                    }
                } else if (item.isFile()) {
                    entry.type = 'file';
                    try {
                        const stat = await fs.stat(fullPath);
                        entry.size = stat.size;
                        entry.modified = stat.mtime.toISOString();
                    } catch { /* ignore stat errors */ }
                } else if (item.isSymbolicLink()) {
                    entry.type = 'symlink';
                } else {
                    entry.type = 'other';
                }

                entries.push(entry);
            }
        } catch (e) {
            if (e.code === 'EACCES') return [{ error: `Permission denied: ${dir}` }];
            throw e;
        }
        return entries;
    }

    try {
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) {
            return { error: `Not a directory: ${dirPath}` };
        }

        const entries = await listEntries(dirPath, 0);
        return {
            path: dirPath,
            entries,
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { error: `Directory not found: ${dirPath}` };
        if (e.code === 'EACCES') return { error: `Permission denied: ${dirPath}` };
        return { error: e.message };
    }
}
