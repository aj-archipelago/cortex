// sys_tool_file_collection.js
// Tool pathway that manages user file collections (list, search, remove files)
// Files are listed from cloud storage via CFH listFolder API
import logger from '../../../../lib/logger.js';
import {
    deleteFileByHash,
    findFileInCollection,
    getWorkspacePathForFile,
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
                description: "View and manage your files in cloud storage.\nOperations are inferred from parameters:\n- RESOLVE: Provide fileRef to look up a single file's complete details (blobPath, contentType, etc.)\n- SEARCH: Provide query to search by filename\n- LIST: No specific params → lists all files\n- REMOVE: Provide fileIds array to delete files",
                parameters: {
                    type: "object",
                    properties: {
                        fileRef: {
                            type: "string",
                            description: "RESOLVE: Any file reference (blobPath, workspace path, URL, name, or legacy hash) to look up a single file's complete details"
                        },
                        query: {
                            type: "string",
                            description: "SEARCH: Search by filename (case-insensitive substring match)"
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

        const isResolve = typeof args.fileRef === 'string' && args.fileRef.length > 0;
        const isSearch = typeof args.query === 'string' && args.query.length > 0;
        const isRemove = (Array.isArray(args.fileIds) && args.fileIds.length > 0) || (typeof args.fileId === 'string' && args.fileId.length > 0);

        try {
            if (isResolve) {
                // Resolve a file reference to its complete details
                const { fileRef } = args;
                if (!fileRef || typeof fileRef !== 'string') {
                    throw new Error("fileRef is required and must be a string");
                }

                const files = await listFilesForFileAccessPlan(fileAccessPlan);
                const found = findFileInCollection(fileRef, files);

                resolver.tool = JSON.stringify({ toolUsed: "ResolveFile" });

                if (!found) {
                    return JSON.stringify({
                        success: false,
                        message: `No file found matching "${fileRef}". Use FileCollection LIST to see available files.`
                    });
                }

                return JSON.stringify({
                    success: true,
                    message: `Resolved file: ${found.displayFilename || found.filename}`,
                    file: {
                        hash: found.hash || null,
                        displayFilename: found.displayFilename || found.filename || null,
                        url: found.url,
                        workspacePath: getWorkspacePathForFile(
                            found,
                            found._contextId || null,
                        ),
                        blobPath: found.name || null,
                        contentType: found.contentType || null,
                        folderPath: found.folderPath || null,
                        size: found.size || null,
                        lastModified: found.lastModified || null,
                    }
                });

            } else if (isSearch) {
                // Search files in cloud storage
                const { query, limit = 20 } = args;

                if (!query || typeof query !== 'string') {
                    throw new Error("query is required and must be a string");
                }

                const normalizeForSearch = (str) => str.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
                const queryNormalized = normalizeForSearch(query);

                const files = await listFilesForFileAccessPlan(fileAccessPlan);

                let results = files.filter(file => {
                    const displayFilename = file.displayFilename || file.filename || '';
                    const filename = file.filename || '';
                    const displayNorm = normalizeForSearch(displayFilename);
                    const filenameNorm = normalizeForSearch(filename);
                    return displayNorm.includes(queryNormalized) ||
                           (filename && filename !== displayFilename && filenameNorm.includes(queryNormalized));
                });

                // Sort by relevance (filename matches first, then by date)
                results.sort((a, b) => {
                    const aN = normalizeForSearch(a.displayFilename || a.filename || '');
                    const bN = normalizeForSearch(b.displayFilename || b.filename || '');
                    const aMatch = aN.includes(queryNormalized);
                    const bMatch = bN.includes(queryNormalized);
                    if (aMatch && !bMatch) return -1;
                    if (!aMatch && bMatch) return 1;
                    return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
                });

                results = results.slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "SearchFileCollection" });

                const message = results.length === 0
                    ? `No files found matching "${query}". Count: 0.`
                    : `Found ${results.length} file(s) matching "${query}". Prefer blobPath or workspacePath to reference files; displayFilename and legacy hash are also supported.`;

                return JSON.stringify({
                    success: true,
                    count: results.length,
                    message,
                    files: results.map(f => ({
                        hash: f.hash || null,
                        displayFilename: f.displayFilename || f.filename || null,
                        url: f.url,
                        workspacePath: getWorkspacePathForFile(
                            f,
                            f._contextId || null,
                        ),
                        size: f.size || null,
                        lastModified: f.lastModified || null,
                    }))
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
                const { sortBy = 'date', limit = 50 } = args;

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
                    count: results.length,
                    totalFiles: files.length,
                    message,
                    files: results.map(f => ({
                        hash: f.hash || null,
                        displayFilename: f.displayFilename || f.filename || null,
                        url: f.url,
                        workspacePath: getWorkspacePathForFile(
                            f,
                            f._contextId || null,
                        ),
                        size: f.size || null,
                        lastModified: f.lastModified || null,
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
