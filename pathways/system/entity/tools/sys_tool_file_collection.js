// sys_tool_file_collection.js
// Tool pathway that manages user file collections (list, search, remove files)
// Files are listed from cloud storage via CFH listFolder API
import path from 'node:path';
import { createHash } from 'node:crypto';
import logger from '../../../../lib/logger.js';
import {
    createContextFileRef,
    deleteFilesInFileAccessPlan,
    findFileInFileAccessPlanDirect,
    findFileInCollection,
    getWorkspacePathForFile,
    listFileNamesForFileAccessPlan,
    listFilesForFileAccessPlan,
} from '../../../../lib/fileUtils.js';

function decodeUtf8Page(buffer, hasMore) {
    if (!hasMore || buffer.length === 0) {
        return { text: buffer.toString('utf8'), bytesRead: buffer.length };
    }
    for (let trim = 0; trim < 4 && trim < buffer.length; trim += 1) {
        const bytesRead = buffer.length - trim;
        try {
            const text = new TextDecoder('utf-8', { fatal: true })
                .decode(buffer.subarray(0, bytesRead));
            return { text, bytesRead };
        } catch { /* The page ended inside a UTF-8 character. */ }
    }
    return { text: buffer.toString('utf8'), bytesRead: buffer.length };
}

export async function readBytePage(response, offset, maxBytes) {
    const reader = response?.body?.getReader?.();
    if (!reader) throw new Error('File response is not stream-readable.');
    const chunks = [];
    let bytes = 0;
    let bytesToSkip = response.status === 206 ? 0 : offset;
    let reachedEnd = false;
    let sawExtra = false;
    let done = false;
    while (!done) {
        const result = await reader.read();
        done = result.done;
        if (done) {
            reachedEnd = true;
            break;
        }
        const { value } = result;
        let chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (bytesToSkip > 0) {
            const skipped = Math.min(bytesToSkip, chunk.byteLength);
            bytesToSkip -= skipped;
            chunk = chunk.subarray(skipped);
            if (chunk.byteLength === 0) continue;
        }
        const remaining = maxBytes - bytes;
        if (remaining <= 0) {
            sawExtra = true;
            break;
        }
        const selected = chunk.subarray(0, remaining);
        chunks.push(Buffer.from(selected));
        bytes += selected.byteLength;
        if (chunk.byteLength > remaining) {
            sawExtra = true;
            break;
        }
    }
    if (!reachedEnd) await reader.cancel().catch(() => {});

    const contentRange = response.headers?.get?.('content-range') || '';
    const totalMatch = contentRange.match(/\/([0-9]+)$/);
    const totalBytes = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;
    const hasMore = Number.isFinite(totalBytes)
        ? offset + bytes < totalBytes
        : sawExtra || !reachedEnd;
    const decoded = decodeUtf8Page(Buffer.concat(chunks), hasMore);
    return {
        text: decoded.text,
        bytesRead: decoded.bytesRead,
        hasMore,
        totalBytes,
    };
}

function assertReadableAsText(file, response) {
    const filename = file?.filename || file?.displayFilename || file?.blobPath || file?.name || '';
    const extension = path.posix.extname(filename).toLowerCase();
    const contentType = response.headers?.get?.('content-type')?.toLowerCase() || '';
    if (
        ['.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx'].includes(extension)
        || contentType.includes('application/pdf')
        || contentType.includes('officedocument')
        || contentType.includes('msword')
    ) {
        throw new Error(`READ supports text files only. Use AnalyzeFile for ${extension || contentType}.`);
    }
}

export function extractRelevantPassages(content, query, isHtml) {
    const text = (isHtml
        ? content.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
        : content).replace(/\s+/g, ' ');
    const terms = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])]
        .filter(term => !['about', 'and', 'can', 'find', 'from', 'how', 'should', 'this', 'what', 'when', 'where', 'which', 'with', 'your'].includes(term));
    if (terms.length === 0) return text.slice(0, 5600);
    return (text.match(/.{1,1400}(?:\s|$)/g) || [])
        .map((content, index) => ({ content, index, score: terms.filter(term => content.toLowerCase().includes(term)).length }))
        .filter(chunk => chunk.score)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 6)
        .sort((a, b) => a.index - b.index)
        .map(chunk => chunk.content.trim())
        .join('\n\n---\n\n');
}

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: [
        {
            type: "function",
            icon: "📁",
            toolCost: 1,
            function: {
                name: "FileCollection",
                description: "Canonical tool for user cloud files and `/workspace/files` discovery. Use this before WorkspaceSSH whenever you need to find a user file by name; do not recursively scan `/workspace/files` or `/cloud-files` with shell commands.\nRecommended flow:\n- SEARCH: `operation: \"search\"` plus `query` to find filenames quickly. Results may include `workspacePath`; pass that path to WorkspaceSSH only when it is present.\n- READ: `operation: \"read\"` plus a returned `fileRef` to read a selected text file. For a large text or HTML file, also pass `query` to retrieve relevant passages in one call.\n- RESOLVE: `operation: \"resolve\"` plus `fileRef` for one selected file when you need full metadata or a URL.\n- LIST: `operation: \"list\"` for recent/top-level browsing, not broad searching.\n- REMOVE: `operation: \"remove\"` plus `fileIds` to delete files.\nIf `operation` is omitted, it is inferred from `fileRef`, `query`, or `fileIds` for backward compatibility.",
                parameters: {
                    type: "object",
                    properties: {
                        operation: {
                            type: "string",
                            enum: ["search", "read", "resolve", "list", "remove"],
                            description: "Explicit operation. Use search for filename discovery, read for a selected text file, resolve for one selected file, list for browsing, or remove for deletion."
                        },
                        fileRef: {
                            type: "string",
                            description: "READ/RESOLVE: A fileRef returned by LIST/SEARCH (legacy blob paths, workspace paths, URLs, names, and hashes remain supported for RESOLVE)."
                        },
                        query: {
                            type: "string",
                            description: "SEARCH: Filename terms. READ: terms from the user's question used to retrieve relevant passages from a large text or HTML file."
                        },
                        prefix: {
                            type: "string",
                            description: "SEARCH: Optional blob/workspace prefix such as media, global, chats/<id>, or /workspace/files/media."
                        },
                        type: {
                            type: "string",
                            enum: ["any", "image", "video", "audio", "pdf", "csv", "doc", "document", "html", "text", "data"],
                            description: "SEARCH: Optional file type filter."
                        },
                        extension: {
                            type: "string",
                            description: "SEARCH: Optional extension filter such as .csv, csv, .png, or pdf."
                        },
                        includeUrls: {
                            type: "boolean",
                            description: "SEARCH: Set true only when URLs/full metadata are needed for returned matches. Default false keeps search fast and compact."
                        },
                        fileIds: {
                            type: "array",
                            items: { type: "string" },
                            description: "REMOVE: Array of files to remove (prefer blobPath; legacy hash or filename also supported)"
                        },
                        sortBy: {
                            type: "string",
                            enum: ["date", "filename"],
                            description: "LIST: Sort by date (newest first) or filename. Default: date"
                        },
                        limit: {
                            type: "number",
                            description: "SEARCH/LIST: Maximum results to return"
                        },
                        maxChars: {
                            type: "number",
                            description: "READ: approximate maximum returned characters/bytes, up to 30000."
                        },
                        offset: {
                            type: "number",
                            description: "READ: byte offset returned as nextOffset by a previous page. Starts at 0."
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["userMessage"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const fileAccessPlan = Array.isArray(args.fileAccessPlan)
            ? args.fileAccessPlan
            : [];
        if (fileAccessPlan.length === 0) {
            throw new Error("fileAccessPlan is required.");
        }

        const requestedOperation = typeof args.operation === 'string'
            ? args.operation.trim().toLowerCase()
            : '';
        const validOperations = new Set(['search', 'read', 'resolve', 'list', 'remove']);
        if (requestedOperation && !validOperations.has(requestedOperation)) {
            throw new Error(`Unsupported FileCollection operation "${args.operation}". Use search, read, resolve, list, or remove.`);
        }

        const hasFileRef = typeof args.fileRef === 'string' && args.fileRef.length > 0;
        const hasQuery = typeof args.query === 'string' && args.query.length > 0;
        const hasRemoveTargets = (Array.isArray(args.fileIds) && args.fileIds.length > 0) || (typeof args.fileId === 'string' && args.fileId.length > 0);
        const operation = requestedOperation
            || (hasFileRef ? 'resolve' : hasQuery ? 'search' : hasRemoveTargets ? 'remove' : 'list');

        const isResolve = operation === 'resolve';
        const isRead = operation === 'read';
        const isSearch = operation === 'search';
        const isRemove = operation === 'remove';

        const parseLimit = (value, defaultValue, maxValue = 200) => {
            const parsed = parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
            return Math.min(parsed, maxValue);
        };
        const normalizeCloudFileRef = (value) => {
            if (!value || typeof value !== 'string') return '';
            let normalized = value.trim().replace(/\\/g, '/');
            normalized = normalized.replace(/^file:\/\//i, '');
            normalized = normalized.replace(/^\/+/, '');
            if (normalized === 'cloud-files') return '';
            if (normalized.startsWith('cloud-files/')) {
                normalized = normalized.slice('cloud-files/'.length);
            } else if (normalized === 'workspace/files') {
                normalized = '';
            } else if (normalized.startsWith('workspace/files/')) {
                normalized = normalized.slice('workspace/files/'.length);
            } else if (normalized === 'files') {
                normalized = '';
            } else if (normalized.startsWith('files/')) {
                normalized = normalized.slice('files/'.length);
            }
            return normalized.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
        };
        const normalizeExtension = (value) => {
            if (!value || typeof value !== 'string') return '';
            const ext = value.trim().toLowerCase().replace(/^\*+/, '');
            if (!ext) return '';
            return ext.startsWith('.') ? ext : `.${ext}`;
        };
        const fileTypeExtensions = {
            image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff', '.heic', '.avif'],
            video: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'],
            audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
            pdf: ['.pdf'],
            csv: ['.csv'],
            doc: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.tsv', '.txt', '.md', '.rtf'],
            document: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.tsv', '.txt', '.md', '.rtf'],
            html: ['.html', '.htm'],
            text: ['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm'],
            data: ['.csv', '.tsv', '.json', '.xlsx', '.xls'],
        };
        const normalizeForSearch = (str) => String(str || '')
            .toLowerCase()
            .replace(/[-_\s]+/g, ' ')
            .trim();
        const searchTerms = (str) => normalizeForSearch(str)
            .split(/[^\p{L}\p{N}]+/u)
            .map(term => term.trim())
            .filter(Boolean);
        const matchesQuery = (file, query) => {
            const queryNormalized = normalizeForSearch(query);
            const haystack = normalizeForSearch([
                file.displayFilename,
                file.filename,
                file.blobPath,
                file.name,
            ].filter(Boolean).join(' '));
            if (!queryNormalized) return true;
            if (haystack.includes(queryNormalized)) return true;
            const terms = searchTerms(query);
            return terms.length > 0 && terms.every(term => haystack.includes(term));
        };
        const fileExtension = (file) => path.posix.extname(
            file?.filename || file?.displayFilename || file?.blobPath || file?.name || '',
        ).toLowerCase();
        const matchesType = (file, type, extension) => {
            const ext = fileExtension(file);
            if (extension && ext !== extension) return false;
            if (!type || type === 'any') return true;
            const extensions = fileTypeExtensions[type];
            if (!extensions) return true;
            return extensions.includes(ext);
        };
        const matchesPrefix = (file, prefix) => {
            if (!prefix) return true;
            const blobPath = normalizeCloudFileRef(file.blobPath || file.name || '');
            return blobPath === prefix || blobPath.startsWith(`${prefix}/`);
        };
        const formatFileResult = (file, { includeUrl = true } = {}) => {
            const workspacePath = file._fileAccessKind === 'app-shared'
                ? null
                : getWorkspacePathForFile(file, file._contextId || null);
            const blobPath = file.name || file.blobPath || null;
            const contextId = file._contextId || null;
            return {
                hash: file.hash || null,
                displayFilename: file.displayFilename || file.filename || null,
                filename: file.filename || file.displayFilename || (blobPath ? path.posix.basename(blobPath) : null),
                url: includeUrl ? (file.url || file.shortLivedUrl || null) : null,
                workspacePath,
                blobPath,
                fileRef: createContextFileRef(contextId, blobPath),
                contentType: file.contentType || null,
                folderPath: file.folderPath || null,
                size: file.size || null,
                lastModified: file.lastModified || null
            };
        };

        const resolveSelectedFiles = async files => {
            const resolved = new Array(files.length);
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
                while (next < files.length) {
                    const index = next++;
                    const file = files[index];
                    const found = await findFileInFileAccessPlanDirect(
                        createContextFileRef(file._contextId, file.blobPath || file.name),
                        fileAccessPlan,
                        { ensureBackup: false, includeMetadata: false, allowDirectUrl: false },
                    );
                    resolved[index] = found ? { ...file, ...found,
                        displayFilename: file.displayFilename || found.displayFilename } : file;
                }
            }));
            return resolved;
        };

        try {
            if (isRead) {
                const maxChars = Math.max(
                    4,
                    parseLimit(args.maxChars, 12000, 30000),
                );
                const offset = Math.max(
                    0,
                    Number.parseInt(args.offset, 10) || 0,
                );
                const found = await findFileInFileAccessPlanDirect(
                    args.fileRef,
                    fileAccessPlan,
                    { allowDirectUrl: false },
                );
                if (!found) {
                    return JSON.stringify({ success: false, message: 'File not found.' });
                }
                const query = String(args.query || '').trim();
                const readOffset = query ? 0 : offset;
                const readLimit = query ? 5000000 : maxChars;
                const response = await fetch(found.shortLivedUrl || found.url, {
                    headers: { Range: `bytes=${readOffset}-${readOffset + readLimit - 1}` },
                    signal: AbortSignal.timeout(15000),
                });
                if (!response.ok) {
                    throw new Error(`File read failed (${response.status}).`);
                }
                assertReadableAsText(found, response);
                const page = await readBytePage(response, readOffset, readLimit);
                const filename = found.displayFilename || found.filename || '';
                const content = query
                    ? extractRelevantPassages(page.text, query, /\.html?$/i.test(filename))
                    : page.text;
                const file = formatFileResult(found, { includeUrl: false });
                const searchResultId = createHash('sha256')
                    .update(`${found._contextId || ''}|${file.blobPath || file.filename || found.hash || 'file'}`)
                    .digest('hex')
                    .slice(0, 16);
                const citation = {
                    ...file,
                    searchResultId,
                    citationMarker: `:cd_source[${searchResultId}]`,
                    title: file.displayFilename || file.filename || 'File',
                    source: file.blobPath,
                    content,
                };
                resolver.tool = JSON.stringify({ toolUsed: 'ReadFileCollection' });
                logger.info(JSON.stringify({
                    event: 'file_collection_read',
                    filename: file.displayFilename || file.filename,
                    query: Boolean(query),
                    returnedChars: content.length,
                }));
                return JSON.stringify({
                    _type: 'SearchResponse',
                    value: content ? [citation] : [],
                    success: true,
                    operation: 'read',
                    offset: readOffset,
                    bytesRead: page.bytesRead,
                    nextOffset: query ? null : page.hasMore ? offset + page.bytesRead : null,
                    totalBytes: page.totalBytes,
                    truncated: query ? false : offset > 0 || page.hasMore,
                });
            } else if (isResolve) {
                // Resolve a file reference to its complete details
                const { fileRef } = args;
                if (!fileRef || typeof fileRef !== 'string') {
                    throw new Error("fileRef is required and must be a string");
                }

                const found = await findFileInFileAccessPlanDirect(fileRef, fileAccessPlan);

                resolver.tool = JSON.stringify({ toolUsed: "ResolveFile" });

                if (!found) {
                    return JSON.stringify({
                        success: false,
                        message: `No file found matching "${fileRef}". Use FileCollection search for fast filename discovery, then resolve the selected workspacePath or blobPath.`
                    });
                }

                return JSON.stringify({
                    success: true,
                    operation: 'resolve',
                    message: `Resolved file: ${found.displayFilename || found.filename}`,
                    file: formatFileResult(found)
                });

            } else if (isSearch) {
                // Search files in cloud storage
                const {
                    query,
                    prefix = '',
                    type = 'any',
                    extension = '',
                    includeUrls = false,
                } = args;
                const limit = parseLimit(args.limit, 20);
                const normalizedPrefix = normalizeCloudFileRef(prefix);
                const normalizedType = String(type || 'any').toLowerCase();
                const normalizedExtension = normalizeExtension(extension);

                if (!query || typeof query !== 'string') {
                    throw new Error("query is required for FileCollection search. Search broadly by filename terms, then use workspacePath with WorkspaceSSH for selected files.");
                }
                if (normalizedType !== 'any' && !fileTypeExtensions[normalizedType]) {
                    throw new Error(`Unsupported FileCollection type "${type}". Use any, image, video, audio, pdf, csv, doc, document, html, text, or data.`);
                }

                const queryNormalized = normalizeForSearch(query);

                let nameResult = await listFileNamesForFileAccessPlan(fileAccessPlan, {
                    maxResultsPerTarget: Math.max(limit, 20000),
                    subPath: normalizedPrefix || null,
                });
                let files = nameResult.files;

                const filterMatches = candidates => candidates
                    .filter(file => matchesPrefix(file, normalizedPrefix))
                    .filter(file => matchesType(file, normalizedType, normalizedExtension))
                    .filter(file => matchesQuery(file, query));
                let results = filterMatches(files);
                if (results.length === 0 && nameResult.cacheHit) {
                    nameResult = await listFileNamesForFileAccessPlan(fileAccessPlan, {
                        maxResultsPerTarget: Math.max(limit, 20000), subPath: normalizedPrefix || null, fresh: true,
                    });
                    files = nameResult.files;
                    results = filterMatches(files);
                }
                if (results.length === 0 && !nameResult.metadataIncluded) {
                    files.splice(
                        0,
                        files.length,
                        ...await listFilesForFileAccessPlan(fileAccessPlan),
                    );
                    results = filterMatches(files);
                }

                // Sort by relevance (filename matches first, then by date)
                results.sort((a, b) => {
                    const aN = normalizeForSearch(a.displayFilename || a.filename || a.blobPath || '');
                    const bN = normalizeForSearch(b.displayFilename || b.filename || b.blobPath || '');
                    const aMatch = aN.includes(queryNormalized);
                    const bMatch = bN.includes(queryNormalized);
                    if (aMatch && !bMatch) return -1;
                    if (!aMatch && bMatch) return 1;
                    return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
                });

                const totalMatches = results.length;
                results = results.slice(0, limit);
                const returnedResults = includeUrls ? await resolveSelectedFiles(results) : results;

                resolver.tool = JSON.stringify({ toolUsed: "SearchFileCollection" });

                const message = results.length === 0
                    ? `No files found matching "${query}". Count: 0.`
                    : `Found ${results.length} file(s) matching "${query}". Use the returned fileRef with FileCollection READ, or workspacePath with WorkspaceSSH, to read/process selected files; do not recursively scan /workspace/files. Use resolve only when URL/full metadata is needed.`;

                return JSON.stringify({
                    success: true,
                    operation: 'search',
                    count: returnedResults.length,
                    totalMatches,
                    totalFiles: files.length,
                    truncated: nameResult.truncated === true,
                    prefix: normalizedPrefix || null,
                    type: normalizedType,
                    extension: normalizedExtension || null,
                    includeUrls: includeUrls === true,
                    message,
                    files: returnedResults.map(file => formatFileResult(file, { includeUrl: includeUrls === true }))
                });

            } else if (isRemove) {
                // Remove file(s) from cloud storage
                const { fileIds, fileId } = args;

                let targetFiles = [];
                if (Array.isArray(fileIds)) {
                    targetFiles = fileIds;
                } else if (fileId) {
                    targetFiles = [fileId];
                }

                if (!targetFiles || targetFiles.length === 0) {
                    throw new Error("fileIds array is required and must not be empty");
                }

                const notFoundFiles = [];
                const notWritableFiles = [];
                const filesToProcess = [];
                const seenLocations = new Set();
                for (const target of targetFiles) {
                    if (target === '*') continue;
                    const foundFile = await findFileInFileAccessPlanDirect(target, fileAccessPlan, {
                        allowDirectUrl: false, includeMetadata: false, ensureBackup: false,
                    });
                    if (!foundFile) { notFoundFiles.push(target); continue; }
                    if (foundFile._writeTarget !== true) {
                        notWritableFiles.push(foundFile.displayFilename || foundFile.filename || target);
                        continue;
                    }
                    const key = `${foundFile._contextId}|${foundFile.blobPath || foundFile.name}`;
                    if (!seenLocations.has(key)) {
                        seenLocations.add(key);
                        filesToProcess.push(foundFile);
                    }
                }

                if (filesToProcess.length === 0) {
                    const reasons = [];
                    if (notFoundFiles.length > 0) {
                        reasons.push(`No files found matching: ${notFoundFiles.join(', ')}`);
                    }
                    if (notWritableFiles.length > 0) {
                        reasons.push(`Cannot remove read-only files: ${notWritableFiles.join(', ')}`);
                    }
                    if (reasons.length > 0) {
                        throw new Error(`${reasons.join('. ')}. Use blobPath, workspacePath, legacy hash, or filename from a search or list.`);
                    }
                }

                const removedFiles = [];
                const failedFiles = [];
                const outcomes = await deleteFilesInFileAccessPlan(filesToProcess, fileAccessPlan);
                filesToProcess.forEach((file, index) => {
                    if (outcomes[index]) removedFiles.push(file);
                    else failedFiles.push(file.displayFilename || file.filename || file.blobPath);
                });
                const removedCount = removedFiles.length;
                let message = `${removedCount} file(s) removed`;
                if (notFoundFiles.length > 0) {
                    message += `. Could not find: ${notFoundFiles.join(', ')}`;
                }
                if (notWritableFiles.length > 0) {
                    message += `. Skipped read-only files: ${notWritableFiles.join(', ')}`;
                }

                resolver.tool = JSON.stringify({ toolUsed: "RemoveFileFromCollection" });
                return JSON.stringify({
                    success: failedFiles.length === 0,
                    operation: 'remove',
                    removedCount,
                    message,
                    removedFiles: removedFiles.map(f => ({
                        displayFilename: f.displayFilename || f.filename,
                        blobPath: f.blobPath || f.name,
                        fileRef: createContextFileRef(f._contextId, f.blobPath || f.name),
                    })),
                    failedFiles: failedFiles.length ? failedFiles : undefined,
                    notFoundFiles: notFoundFiles.length > 0 ? notFoundFiles : undefined,
                    notWritableFiles: notWritableFiles.length > 0 ? notWritableFiles : undefined,
                });

            } else {
                // List files from cloud storage
                const { sortBy = 'date' } = args;
                const limit = parseLimit(args.limit, 50);

                const names = await listFileNamesForFileAccessPlan(fileAccessPlan, {
                    maxResultsPerTarget: 50000,
                    subPath: args.prefix || null,
                    fresh: true,
                });
                // Old CFH versions remain readable during a rolling deployment.
                const files = names.metadataIncluded ? names.files : await listFilesForFileAccessPlan(fileAccessPlan);
                let results = [...files];

                // Sort results
                if (sortBy === 'filename') {
                    results.sort((a, b) => {
                        const aName = a.displayFilename || a.filename || '';
                        const bName = b.displayFilename || b.filename || '';
                        return aName.localeCompare(bName);
                    });
                } else {
                    results.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
                }

                results = results.slice(0, limit);
                if (names.metadataIncluded && args.includeUrls !== false) results = await resolveSelectedFiles(results);

                resolver.tool = JSON.stringify({ toolUsed: "ListFileCollection" });

                let message;
                if (results.length === 0) {
                    message = 'No files in storage.';
                } else {
                    message = results.length === files.length
                        ? `Showing all ${results.length} file(s).`
                        : `Showing ${results.length} of ${files.length} file(s).`;
                }

                if (names.truncated) message += ' Catalog scan is incomplete; ordering and counts cover only the scanned files. Narrow prefix to browse the remaining folders.';
                return JSON.stringify({
                    success: true,
                    operation: 'list',
                    truncated: names.truncated === true,
                    count: results.length,
                    totalFiles: files.length,
                    message,
                    files: results.map(f => ({
                        hash: f.hash || null,
                        displayFilename: f.displayFilename || f.filename || null,
                        filename: f.filename || f.displayFilename || null,
                        url: f.url,
                        workspacePath: f._fileAccessKind === 'app-shared'
                            ? null
                            : getWorkspacePathForFile(f, f._contextId || null),
                        blobPath: f.name || f.blobPath || null,
                        fileRef: createContextFileRef(
                            f._contextId || null,
                            f.name || f.blobPath || null,
                        ),
                        contentType: f.contentType || null,
                        size: f.size || null,
                        lastModified: f.lastModified || null
                    }))
                });
            }

        } catch (e) {
            logger.error(`Error in file collection operation: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "FileCollection" });
            return JSON.stringify({
                success: false,
                error: e.message || "Unknown error occurred"
            });
        }
    }
};
