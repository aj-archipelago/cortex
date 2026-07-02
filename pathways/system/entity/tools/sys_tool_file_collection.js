// sys_tool_file_collection.js
// Tool pathway that manages user file collections (list, search, remove files)
// Files are listed from cloud storage via CFH listFolder API
import path from 'node:path';
import logger from '../../../../lib/logger.js';
import {
    deleteFileByHash,
    findFileInFileAccessPlanDirect,
    findFileInCollection,
    getWorkspacePathForFile,
    listFileNamesForFileAccessPlan,
    listFilesForFileAccessPlan,
} from '../../../../lib/fileUtils.js';

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
                description: "Canonical tool for user cloud files and `/workspace/files` discovery. Use this before WorkspaceSSH whenever you need to find a user file by name; do not recursively scan `/workspace/files` or `/cloud-files` with shell commands.\nRecommended flow:\n- SEARCH: `operation: \"search\"` plus `query` to find filenames quickly. Results include `workspacePath`; pass that path to WorkspaceSSH only after selecting the file(s) you need to read or process.\n- RESOLVE: `operation: \"resolve\"` plus `fileRef` for one selected file when you need full metadata or a URL.\n- LIST: `operation: \"list\"` for recent/top-level browsing, not broad searching.\n- REMOVE: `operation: \"remove\"` plus `fileIds` to delete files.\nIf `operation` is omitted, it is inferred from `fileRef`, `query`, or `fileIds` for backward compatibility.",
                parameters: {
                    type: "object",
                    properties: {
                        operation: {
                            type: "string",
                            enum: ["search", "resolve", "list", "remove"],
                            description: "Explicit operation. Use search for filename discovery, resolve for one selected file, list for browsing, remove for deletion."
                        },
                        fileRef: {
                            type: "string",
                            description: "RESOLVE: Any file reference (blobPath, workspace path, URL, name, or legacy hash) to look up a single file's complete details"
                        },
                        query: {
                            type: "string",
                            description: "SEARCH: Filename search terms. Multi-word queries match separator variants such as spaces, dashes, and underscores."
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
        const validOperations = new Set(['search', 'resolve', 'list', 'remove']);
        if (requestedOperation && !validOperations.has(requestedOperation)) {
            throw new Error(`Unsupported FileCollection operation "${args.operation}". Use search, resolve, list, or remove.`);
        }

        const hasFileRef = typeof args.fileRef === 'string' && args.fileRef.length > 0;
        const hasQuery = typeof args.query === 'string' && args.query.length > 0;
        const hasRemoveTargets = (Array.isArray(args.fileIds) && args.fileIds.length > 0) || (typeof args.fileId === 'string' && args.fileId.length > 0);
        const operation = requestedOperation
            || (hasFileRef ? 'resolve' : hasQuery ? 'search' : hasRemoveTargets ? 'remove' : 'list');

        const isResolve = operation === 'resolve';
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
            const workspacePath = getWorkspacePathForFile(
                file,
                file._contextId || null,
            );
            const blobPath = file.name || file.blobPath || null;
            return {
                hash: file.hash || null,
                displayFilename: file.displayFilename || file.filename || null,
                filename: file.filename || file.displayFilename || (blobPath ? path.posix.basename(blobPath) : null),
                url: includeUrl ? (file.url || file.shortLivedUrl || null) : null,
                workspacePath,
                blobPath,
                contentType: file.contentType || null,
                folderPath: file.folderPath || null,
                size: file.size || null,
                lastModified: file.lastModified || null
            };
        };

        try {
            if (isResolve) {
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

                const nameResult = await listFileNamesForFileAccessPlan(fileAccessPlan, {
                    maxResultsPerTarget: Math.max(limit, 20000),
                    subPath: normalizedPrefix || null,
                });
                const files = nameResult.files;

                let results = files
                    .filter(file => matchesPrefix(file, normalizedPrefix))
                    .filter(file => matchesType(file, normalizedType, normalizedExtension))
                    .filter(file => matchesQuery(file, query));

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
                const returnedResults = includeUrls
                    ? await Promise.all(results.map(async (file) => {
                        if (!file.blobPath) {
                            return file;
                        }
                        return await findFileInFileAccessPlanDirect(file.blobPath, fileAccessPlan) || file;
                    }))
                    : results;

                resolver.tool = JSON.stringify({ toolUsed: "SearchFileCollection" });

                const message = results.length === 0
                    ? `No files found matching "${query}". Count: 0.`
                    : `Found ${results.length} file(s) matching "${query}". Use the returned workspacePath with WorkspaceSSH to read/process selected files; do not recursively scan /workspace/files. Use resolve only when URL/full metadata is needed.`;

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

                // List files to resolve targets
                const allFiles = await listFilesForFileAccessPlan(fileAccessPlan);

                let notFoundFiles = [];
                let notWritableFiles = [];
                let filesToProcess = [];

                for (const target of targetFiles) {
                    if (target === '*') continue;
                    const foundFile = findFileInCollection(target, allFiles);
                    if (foundFile) {
                        if (foundFile._writeTarget !== true) {
                            notWritableFiles.push(
                                foundFile.displayFilename || foundFile.filename || target,
                            );
                            continue;
                        }
                        if (!filesToProcess.some(f => f.hash === foundFile.hash)) {
                            filesToProcess.push({
                                displayFilename: foundFile.displayFilename || foundFile.filename || null,
                                hash: foundFile.hash || null,
                                contextId: foundFile._contextId || null,
                            });
                        }
                    } else {
                        notFoundFiles.push(target);
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

                // Delete from cloud storage
                for (const fileInfo of filesToProcess) {
                    if (!fileInfo.hash) {
                        continue;
                    }
                    try {
                        logger.info(`Deleting file from cloud: ${fileInfo.displayFilename} (hash: ${fileInfo.hash})`);
                        await deleteFileByHash(fileInfo.hash, resolver, fileInfo.contextId || null);
                    } catch (error) {
                        logger.warn(`Failed to delete file ${fileInfo.displayFilename} from cloud: ${error?.message || String(error)}`);
                    }
                }

                const removedCount = filesToProcess.length;
                let message = `${removedCount} file(s) removed`;
                if (notFoundFiles.length > 0) {
                    message += `. Could not find: ${notFoundFiles.join(', ')}`;
                }
                if (notWritableFiles.length > 0) {
                    message += `. Skipped read-only files: ${notWritableFiles.join(', ')}`;
                }

                resolver.tool = JSON.stringify({ toolUsed: "RemoveFileFromCollection" });
                return JSON.stringify({
                    success: true,
                    operation: 'remove',
                    removedCount,
                    message,
                    removedFiles: filesToProcess.map(f => ({
                        displayFilename: f.displayFilename,
                        hash: f.hash
                    })),
                    notFoundFiles: notFoundFiles.length > 0 ? notFoundFiles : undefined,
                    notWritableFiles: notWritableFiles.length > 0 ? notWritableFiles : undefined,
                });

            } else {
                // List files from cloud storage
                const { sortBy = 'date' } = args;
                const limit = parseLimit(args.limit, 50);

                const files = await listFilesForFileAccessPlan(fileAccessPlan);
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

                resolver.tool = JSON.stringify({ toolUsed: "ListFileCollection" });

                let message;
                if (results.length === 0) {
                    message = 'No files in storage.';
                } else {
                    message = results.length === files.length
                        ? `Showing all ${results.length} file(s).`
                        : `Showing ${results.length} of ${files.length} file(s).`;
                }

                return JSON.stringify({
                    success: true,
                    operation: 'list',
                    count: results.length,
                    totalFiles: files.length,
                    message,
                    files: results.map(f => ({
                        hash: f.hash || null,
                        displayFilename: f.displayFilename || f.filename || null,
                        filename: f.filename || f.displayFilename || null,
                        url: f.url,
                        workspacePath: getWorkspacePathForFile(
                            f,
                            f._contextId || null,
                        ),
                        blobPath: f.name || f.blobPath || null,
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
