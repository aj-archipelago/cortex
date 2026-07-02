// sys_tool_workspace_ssh.js
// Consolidated workspace tool — one shell interface replaces 14 individual tools.
// Built-in pseudo-commands: bg, poll, reset.
import path from 'node:path';
import logger from '../../../../lib/logger.js';
import { sendToolStart, sendToolFinish } from '../../../../lib/pathwayTools.js';
import { workspaceRequest, destroyWorkspace } from './shared/workspace_client.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 300000;
const RESET_DESTROY_TIMEOUT_MS = 900000;
const WORKSPACE_ROOT = '/workspace';
const CLOUD_FILES_ROOT = '/cloud-files';
const WORKSPACE_FILES_ROOT = '/workspace/files';

function timeoutSecondsToMs(timeoutSeconds, defaultMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return timeoutSeconds ? timeoutSeconds * 1000 : defaultMs;
}

export function resetDestroyTimeoutMs(timeoutSeconds) {
    return Math.max(timeoutSecondsToMs(timeoutSeconds, RESET_DESTROY_TIMEOUT_MS), RESET_DESTROY_TIMEOUT_MS);
}

/**
 * Simple quoted-string-aware tokenizer.
 * Splits on whitespace, but respects single and double quotes.
 * Returns array of tokens with quotes stripped.
 */
export function tokenize(input) {
    const tokens = [];
    let current = '';
    let inQuote = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === ' ' || ch === '\t') {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }

    if (current) tokens.push(current);
    return tokens;
}

/** Normalize a path so relative paths resolve under /workspace/ (matching shell cwd). */
export function toAbsWorkspacePath(p) {
    return p.startsWith('/') ? p : `${WORKSPACE_ROOT}/${p}`;
}

function normalizeShellPath(value) {
    if (!value || typeof value !== 'string') return '';
    let normalized = value.trim().replace(/\\/g, '/');
    normalized = normalized.replace(/\/+$/g, '');
    if (normalized === '') return '/';
    if (normalized.startsWith('./')) normalized = normalized.slice(2);
    return normalized;
}

function resolveShellPath(value, cwd = WORKSPACE_ROOT) {
    const normalized = normalizeShellPath(value);
    if (!normalized) return '';
    if (normalized.startsWith('/')) return path.posix.normalize(normalized);
    return path.posix.normalize(path.posix.join(cwd || WORKSPACE_ROOT, normalized));
}

function isPathAncestorOrSelf(candidate, target) {
    const normalizedCandidate = path.posix.normalize(candidate || '');
    const normalizedTarget = path.posix.normalize(target || '');
    return normalizedCandidate === normalizedTarget
        || normalizedTarget.startsWith(`${normalizedCandidate.replace(/\/+$/g, '')}/`);
}

function pathMayIncludeCloudFiles(value, cwd = WORKSPACE_ROOT) {
    const resolved = resolveShellPath(value, cwd);
    return resolved === CLOUD_FILES_ROOT
        || resolved.startsWith(`${CLOUD_FILES_ROOT}/`)
        || isPathAncestorOrSelf(resolved, CLOUD_FILES_ROOT);
}

function isWorkspaceFilesPath(value, cwd = WORKSPACE_ROOT) {
    const resolved = resolveShellPath(value, cwd);
    return resolved === WORKSPACE_FILES_ROOT
        || resolved.startsWith(`${WORKSPACE_FILES_ROOT}/`);
}

function pathMayIncludeWorkspaceFilesSymlink(value, cwd = WORKSPACE_ROOT) {
    const resolved = resolveShellPath(value, cwd);
    return isWorkspaceFilesPath(value, cwd)
        || isPathAncestorOrSelf(resolved, WORKSPACE_FILES_ROOT);
}

function shellSegments(command) {
    return command
        .split(/(?:&&|\|\||[;\n|])/)
        .map(segment => tokenize(segment.trim()))
        .filter(tokens => tokens.length > 0);
}

function commandStartIndex(tokens) {
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
        index++;
    }
    if (tokens[index] === 'command') index++;
    return index;
}

function positionalArgs(tokens, startIndex, optionsWithValues = new Set()) {
    const positionals = [];
    let afterDoubleDash = false;

    for (let i = startIndex; i < tokens.length; i++) {
        const token = tokens[i];
        if (!afterDoubleDash && token === '--') {
            afterDoubleDash = true;
            continue;
        }

        if (!afterDoubleDash && token.startsWith('-')) {
            const [optionName] = token.split('=', 1);
            if (!token.includes('=') && optionsWithValues.has(optionName)) {
                i++;
            }
            continue;
        }

        positionals.push(token);
    }

    return positionals;
}

function hasRipgrepFilesExclude(tokens) {
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const value = token === '-g' || token === '--glob'
            ? tokens[i + 1]
            : token.startsWith('-g!')
              ? token.slice(2)
              : token.startsWith('--glob=')
                ? token.slice('--glob='.length)
                : null;

        if (value && (
            value === '!files/**'
            || value === '!/workspace/files/**'
            || value === '!cloud-files/**'
            || value === '!/cloud-files/**'
        )) {
            return true;
        }
    }

    return false;
}

function hasRipgrepSymlinkFollow(tokens) {
    return tokens.some((token) => token === '-L' || token === '--follow');
}

function hasGrepFilesExclude(tokens) {
    return tokens.some((token, index) => (
        token === '--exclude-dir=files'
        || token === '--exclude-dir=/workspace/files'
        || (token === '--exclude-dir' && (tokens[index + 1] === 'files' || tokens[index + 1] === '/workspace/files'))
    ));
}

function findHasFilesPrune(tokens) {
    const hasPrune = tokens.includes('-prune');
    if (!hasPrune) return false;

    return tokens.some((token, index) => (
        token === '-path'
        && (
            isCloudFilesPath(tokens[index + 1])
            || normalizeShellPath(tokens[index + 1]) === './files'
        )
    ));
}

function findSymlinkFollowMode(tokens, commandIndex) {
    for (let i = commandIndex + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '-L') return 'all';
        if (token === '-H') return 'command-line';
        if (token !== '-P' && !token.startsWith('-D') && !token.startsWith('-O')) {
            break;
        }
    }
    return 'none';
}

function classifyFindScan(tokens, commandIndex, cwd = WORKSPACE_ROOT) {
    const paths = [];
    let startIndex = commandIndex + 1;
    while (startIndex < tokens.length) {
        const token = tokens[startIndex];
        if (token === '-H' || token === '-L' || token === '-P') {
            startIndex++;
        } else if (token === '-D' || token === '-O') {
            startIndex += 2;
        } else {
            break;
        }
    }

    for (let i = startIndex; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--') continue;
        if (token.startsWith('-') || token === '(' || token === ')' || token === '!') break;
        paths.push(token);
    }

    const scanPaths = paths.length > 0 ? paths : ['.'];
    if (scanPaths.some((scanPath) => pathMayIncludeCloudFiles(scanPath, cwd))) {
        return 'recursive find over cloud files';
    }

    if (scanPaths.some((scanPath) => isWorkspaceFilesPath(scanPath, cwd))) {
        return 'recursive find over /workspace/files';
    }

    const followMode = findSymlinkFollowMode(tokens, commandIndex);
    if (
        followMode === 'all'
        && scanPaths.some((scanPath) => pathMayIncludeWorkspaceFilesSymlink(scanPath, cwd))
        && !findHasFilesPrune(tokens)
    ) {
        return 'symlink-following find that may enter /workspace/files';
    }

    if (
        followMode === 'command-line'
        && scanPaths.some((scanPath) => isWorkspaceFilesPath(scanPath, cwd))
    ) {
        return 'symlink-following find over /workspace/files';
    }

    return null;
}

function classifyRipgrepScan(tokens, commandIndex, cwd = WORKSPACE_ROOT) {
    const optionsWithValues = new Set([
        '-A', '-B', '-C', '-e', '--regexp', '-g', '--glob', '-m', '--max-count',
        '--max-depth', '--type', '-t', '--type-not', '-T', '--sort', '--sortr',
        '--colors', '--context', '--ignore-file', '--path-separator', '--engine',
        '--pre', '--encoding',
    ]);
    const positionals = positionalArgs(tokens, commandIndex + 1, optionsWithValues);
    const filesMode = tokens.includes('--files');
    const explicitPattern = tokens.includes('-e')
        || tokens.includes('--regexp')
        || tokens.some(token => token.startsWith('--regexp='));
    const scanPaths = filesMode
        ? positionals
        : explicitPattern
          ? positionals
          : positionals.slice(1);
    const effectivePaths = scanPaths.length > 0 ? scanPaths : ['.'];

    if (effectivePaths.some((scanPath) => pathMayIncludeCloudFiles(scanPath, cwd))) {
        return 'ripgrep over cloud files';
    }

    if (effectivePaths.some((scanPath) => isWorkspaceFilesPath(scanPath, cwd))) {
        return 'ripgrep over /workspace/files';
    }

    if (
        hasRipgrepSymlinkFollow(tokens)
        && effectivePaths.some((scanPath) => pathMayIncludeWorkspaceFilesSymlink(scanPath, cwd))
        && !hasRipgrepFilesExclude(tokens)
    ) {
        return 'symlink-following ripgrep that may enter /workspace/files';
    }

    return null;
}

function grepFollowsSymlinks(tokens, commandIndex) {
    return tokens.some((token, index) => {
        if (index <= commandIndex) return false;
        return token === '-R'
            || token === '--dereference-recursive'
            || /^-[A-Za-z]*R[A-Za-z]*$/.test(token);
    });
}

function classifyGrepScan(tokens, commandIndex, cwd = WORKSPACE_ROOT) {
    const recursive = tokens.some((token, index) => {
        if (index <= commandIndex) return false;
        return token === '-R'
            || token === '-r'
            || token === '--recursive'
            || token === '--dereference-recursive'
            || /^-[A-Za-z]*[Rr][A-Za-z]*$/.test(token);
    });
    if (!recursive) return null;

    const optionsWithValues = new Set(['-A', '-B', '-C', '-e', '-f', '--regexp', '--file', '--include', '--exclude', '--exclude-dir']);
    const positionals = positionalArgs(tokens, commandIndex + 1, optionsWithValues);
    const scanPaths = positionals.slice(1);
    const effectivePaths = scanPaths.length > 0 ? scanPaths : ['.'];

    if (effectivePaths.some((scanPath) => pathMayIncludeCloudFiles(scanPath, cwd))) {
        return 'recursive grep over cloud files';
    }

    if (
        effectivePaths.some((scanPath) => isWorkspaceFilesPath(scanPath, cwd))
        && !hasGrepFilesExclude(tokens)
    ) {
        return 'recursive grep over /workspace/files';
    }

    if (
        grepFollowsSymlinks(tokens, commandIndex)
        && effectivePaths.some((scanPath) => pathMayIncludeWorkspaceFilesSymlink(scanPath, cwd))
        && !hasGrepFilesExclude(tokens)
    ) {
        return 'symlink-following recursive grep that may enter /workspace/files';
    }

    return null;
}

function hasLsSymlinkFollow(tokens, commandIndex) {
    return tokens.some((token, index) => (
        index > commandIndex
        && /^-[A-Za-z]*L[A-Za-z]*$/.test(token)
    ));
}

function hasTreeSymlinkFollow(tokens, commandIndex) {
    return tokens.some((token, index) => (
        index > commandIndex
        && /^-[A-Za-z]*l[A-Za-z]*$/.test(token)
    ));
}

function classifyLsOrTreeScan(tokens, commandIndex, cwd = WORKSPACE_ROOT) {
    const command = tokens[commandIndex];
    if (command === 'ls') {
        const recursive = tokens.some((token, index) => index > commandIndex && /^-[A-Za-z]*R[A-Za-z]*$/.test(token));
        if (!recursive) return null;
        const paths = positionalArgs(tokens, commandIndex + 1);
        const effectivePaths = paths.length > 0 ? paths : ['.'];
        if (effectivePaths.some((scanPath) => pathMayIncludeCloudFiles(scanPath, cwd))) return 'recursive ls over cloud files';
        if (effectivePaths.some((scanPath) => isWorkspaceFilesPath(scanPath, cwd))) return 'recursive ls over /workspace/files';
        if (
            hasLsSymlinkFollow(tokens, commandIndex)
            && effectivePaths.some((scanPath) => pathMayIncludeWorkspaceFilesSymlink(scanPath, cwd))
        ) {
            return 'symlink-following recursive ls that may enter /workspace/files';
        }
        return null;
    }

    if (command === 'tree') {
        const paths = positionalArgs(tokens, commandIndex + 1, new Set(['-L', '-P', '-I', '-o']));
        const effectivePaths = paths.length > 0 ? paths : ['.'];
        if (effectivePaths.some((scanPath) => pathMayIncludeCloudFiles(scanPath, cwd))) return 'tree over cloud files';
        if (effectivePaths.some((scanPath) => isWorkspaceFilesPath(scanPath, cwd))) return 'tree over /workspace/files';
        if (
            hasTreeSymlinkFollow(tokens, commandIndex)
            && effectivePaths.some((scanPath) => pathMayIncludeWorkspaceFilesSymlink(scanPath, cwd))
        ) {
            return 'symlink-following tree that may enter /workspace/files';
        }
    }

    return null;
}

export function shouldBlockExpensiveCloudFileScan(command) {
    let cwd = WORKSPACE_ROOT;
    for (const tokens of shellSegments(command)) {
        const commandIndex = commandStartIndex(tokens);
        const executable = tokens[commandIndex];
        if (!executable) continue;

        if (executable === 'cd') {
            const nextCwd = tokens[commandIndex + 1] || WORKSPACE_ROOT;
            cwd = resolveShellPath(nextCwd, cwd);
            continue;
        }

        let reason = null;
        if (executable === 'find') {
            reason = classifyFindScan(tokens, commandIndex, cwd);
        } else if (executable === 'rg' || executable === 'ripgrep') {
            reason = classifyRipgrepScan(tokens, commandIndex, cwd);
        } else if (executable === 'grep' || executable === 'egrep' || executable === 'fgrep') {
            reason = classifyGrepScan(tokens, commandIndex, cwd);
        } else if (executable === 'ls' || executable === 'tree') {
            reason = classifyLsOrTreeScan(tokens, commandIndex, cwd);
        }

        if (reason) {
            return {
                success: false,
                blocked: true,
                error: `Blocked likely-expensive ${reason}. /workspace/files is a symlink to /cloud-files and may be backed by remote cloud storage.`,
                alternatives: [
                    'Use FileCollection with operation "search" to find user files by filename; it returns workspacePath values for selected files.',
                    'Then read/process selected workspacePath values with WorkspaceSSH, e.g. python/csv/head on that exact path.',
                    'Plain recursive scans of /workspace are allowed when symlinks are not followed.',
                    'If you need a broad cloud-file search, use FileCollection instead of shell recursion.',
                ],
            };
        }
    }

    return null;
}

/**
 * Extract the last non-empty, non-hint line from stderr — usually the actual
 * error message (e.g. "ModuleNotFoundError: No module named 'sympy'").
 */
function lastMeaningfulLine(stderr) {
    if (!stderr) return null;
    const lines = stderr.split('\n')
        .map(l => l.trim())
        .filter(l => l
            && !l.startsWith('hint:')
            && !l.startsWith('note:')
            && !/^Node\.js v\d/.test(l)
        );
    return lines[lines.length - 1] || null;
}

// --- Handlers ---

function workspaceRequestOptions(args, options = {}) {
    const requestId = args._toolRequestId;
    const parentCallId = args._parentToolCallId;
    const lifecycleMessages = {
        provision: { icon: '🏗️', message: 'Setting up workspace' },
        wake: { icon: '🚀', message: 'Starting workspace' },
        reprovision: { icon: '🔄', message: 'Updating workspace' },
        reconnect: { icon: '🔌', message: 'Reconnecting workspace' },
        checkpointBackup: { icon: '💾', message: 'Backing up workspace' },
        checkpointUpload: { icon: '☁️', message: 'Saving workspace backup' },
        restore: { icon: '📦', message: 'Restoring workspace backup' },
        destroy: { icon: '🧹', message: 'Destroying workspace container' },
    };

    if (!requestId || !parentCallId) return options;

    return {
        ...options,
        async onWorkspaceLifecycle(event) {
            const spec = lifecycleMessages[event.phase] || { icon: '💻', message: event.message || 'Preparing workspace' };
            const callId = `${parentCallId}:workspace-${event.phase}`;

            if (event.type === 'start') {
                await sendToolStart(requestId, callId, spec.icon, event.message || spec.message);
            } else if (event.type === 'finish') {
                await sendToolFinish(requestId, callId, event.success !== false, event.error || null);
            }
        },
    };
}

async function handleShell(command, args, resolver) {
    const { entityId, timeoutSeconds } = args;
    const timeoutMs = timeoutSecondsToMs(timeoutSeconds);
    const result = await workspaceRequest(entityId, '/shell', { command }, workspaceRequestOptions(args, { timeoutMs }));

    if (!result.success && !result.error) {
        result.error = lastMeaningfulLine(result.stderr)
            || `Command failed (exit code ${result.exitCode})`;
    }

    // Hint when a failed command looks like it tried to use bg/poll as bash commands
    if (!result.success && /\bbg\s+|poll\s+[0-9a-f]/i.test(command)) {
        result.hint = '`bg` and `poll` are built-in commands of this tool, not bash commands. They must be the entire command string — e.g. command: "bg python train.py", not inside scripts or chained with && or ;.';
    }

    return JSON.stringify(result);
}

async function handleBg(rawBgCommand, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, '/shell', {
        command: rawBgCommand,
        background: true,
    }, workspaceRequestOptions(args, { timeoutMs: 15000 }));

    if (!result.success && !result.error) {
        result.error = lastMeaningfulLine(result.stderr)
            || `Command failed (exit code ${result.exitCode})`;
    }

    return JSON.stringify(result);
}

async function handlePoll(processId, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, `/shell/result/${encodeURIComponent(processId)}`, null, workspaceRequestOptions(args, {
        method: 'GET',
        timeoutMs: 10000,
    }));

    if (!result.success && !result.error) {
        result.error = lastMeaningfulLine(result.stderr)
            || `Command failed (exit code ${result.exitCode})`;
    }

    return JSON.stringify(result);
}

async function handleJobs(args) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, '/shell/jobs', null, workspaceRequestOptions(args, {
        method: 'GET',
        timeoutMs: 10000,
    }));

    return JSON.stringify(result);
}

async function handleReset(tokens, args, resolver) {
    // reset [--preserve <paths>] [--destroy] [--destroy-volume]
    const { entityId, timeoutSeconds } = args;
    let destroy = false;
    let destroyVolume = false;
    const preservePaths = [];

    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--destroy') {
            destroy = true;
        } else if (token === '--destroy-volume') {
            destroyVolume = true;
            destroy = true; // implies destroy
        } else if (token === '--preserve') {
            // Collect all following non-flag tokens as preserve paths
            i++;
            while (i < tokens.length && !tokens[i].startsWith('--')) {
                preservePaths.push(tokens[i]);
                i++;
            }
            i--; // back up so outer loop increments correctly
        }
    }

    // Full container destruction
    if (destroy) {
        const timeoutMs = resetDestroyTimeoutMs(timeoutSeconds);
        const entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig) {

            return JSON.stringify({ success: false, error: 'Entity not found' });
        }

        const result = await destroyWorkspace(entityId, entityConfig, workspaceRequestOptions(args, { destroyVolume, timeoutMs }));
        if (!result.success || destroyVolume) {
            return JSON.stringify(result);
        }

        const status = await workspaceRequest(
            entityId,
            '/status',
            null,
            workspaceRequestOptions(args, { method: 'GET', timeoutMs: 10000, recordActivity: false }),
        );

        return JSON.stringify({
            ...result,
            reprovisioned: Boolean(status.success),
            workspace: status.success ? status : undefined,
            error: status.success ? undefined : status.error,
            success: Boolean(status.success),
        });
    }

    // Soft reset: wipe /workspace contents
    const timeoutMs = timeoutSecondsToMs(timeoutSeconds);
    const body = {};
    if (preservePaths.length > 0) {
        body.preservePaths = preservePaths;
    }

    const result = await workspaceRequest(entityId, '/reset', body, workspaceRequestOptions(args, { timeoutMs: 60000 }));

    return JSON.stringify(result);
}

// --- Command routing ---

/**
 * Route a command string to the appropriate handler.
 * Returns [handler, ...handlerArgs] or null if it's a plain shell command.
 */
function routeCommand(command) {
    const tokens = tokenize(command);
    if (tokens.length === 0) return null;

    const first = tokens[0].toLowerCase();

    if (first === 'bg') {
        // Preserve raw command after "bg " to avoid re-tokenizing quoted args
        const rawBgCommand = command.replace(/^\s*bg\s+/, '');
        return { handler: handleBg, rawBgCommand };
    }

    if (first === 'poll') {
        const processId = tokens[1];
        if (!processId) return null; // let it fall to shell (will error naturally)
        return { handler: handlePoll, processId };
    }

    if (first === 'jobs') {
        return { handler: handleJobs };
    }

    if (first === 'reset') {
        return { handler: handleReset, tokens };
    }

    return null; // plain shell command
}

// --- Tool definition and entry point ---

export default {
    prompt: [],
    timeout: 900,
    inputParameters: {
        command: ``,
        userMessage: ``,
        icon: ``,
        timeoutSeconds: 0,
        entityId: ``,
        contextId: ``,
        fileAccessPlan: {
            type: 'array',
            items: { objType: 'FileAccessTargetInput' },
            default: [],
        },
        chatId: ``,
        userId: ``,
    },
    toolDefinition: {
        type: 'function',
        icon: '💻',
        defaultUserMessage: 'Working in the workspace',
        toolCost: 1,
        function: {
            name: 'WorkspaceSSH',
            description: `Execute commands in your persistent Linux workspace (Debian, cwd: /workspace). Use it for calculation, verification, data analysis, file processing, coding, and short-lived research notes. Don't guess when you can compute.

Batch related checks into one shell command or small script when practical, and return concise summaries instead of dumping large files. Write full intermediate outputs to /workspace when useful.

Pre-installed: Python 3 + pip, Node.js, bash, and common CLI tools (curl, jq, git, etc.). Install Python packages with: pip install <pkg> --break-system-packages

Persistence: files, packages, virtual environments, and project structures survive between sessions. Read /workspace/README.md if present. For multi-step research, use /workspace/research-notes.md as a concise scratchpad for facts synthesized from tool results so you do not repeat the same lookups.

User files: /cloud-files is the user's cloud storage mount. /workspace/files is a compatibility symlink to /cloud-files. Do not recursively scan /cloud-files or direct /workspace/files paths with find, rg, grep -R, ls -R, or tree. Plain recursive scans of /workspace are allowed when symlinks are not followed. For filename discovery under /workspace/files, use the FileCollection tool first with operation "search"; it returns workspacePath values that you can pass back to WorkspaceSSH for reading or processing selected files. Use FileCollection operation "resolve" only after selecting a specific result and needing URL/full metadata.

BUILT-IN COMMANDS — IMPORTANT: The commands below are special commands handled by this tool, NOT bash commands. They MUST be the ENTIRE command string passed to this tool. NEVER combine them with bash syntax — no "cd /workspace && bg ...", no "bg ... && echo done", no embedding them in scripts or subshells. Just pass the built-in command as the complete command string.

• bg <cmd> — run a command in the background (no timeout — suitable for servers, training, etc.). Returns a processId. The background process runs until it exits on its own or the workspace is destroyed.
  CORRECT: command: "bg python train.py"
  CORRECT: command: "bg node server.js"
  WRONG:   command: "cd /workspace && bg python train.py" (bg is not bash)
  WRONG:   command: "bg python train.py && echo started" (cannot chain with bg)

• poll <processId> — check the status and output of a background process. Returns status (running/completed/failed), stdout, stderr, and exit code.
  Example: command: "poll a1b2c3d4e5f6g7h8"

• jobs — list all background processes with their processId, status, command, and duration. Use this to find processIds you may have lost, or to check what's still running.
  Example: command: "jobs"

• reset [--preserve .env] — wipe workspace contents
• reset --destroy — destroy and re-provision the workspace container while preserving files. This can take up to 15 minutes because it checkpoints first.
• reset --destroy-volume — destroy the container and persisted workspace data

Everything else runs as a bash command. Relative and absolute paths both work.`,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Shell command or built-in (e.g. "ls -la", "python script.py")',
                    },
                    userMessage: {
                        type: 'string',
                        description: 'Required. A short user-facing progress string describing what this specific command is doing. Keep it specific to this call, not generic.',
                    },
                    icon: {
                        type: 'string',
                        description: 'Required. A single emoji that visually represents the specific action this command performs — pick whatever fits best (language, file type, intent, mood). Use the generic 💻 only when truly nothing more specific applies.',
                    },
                    timeoutSeconds: {
                        type: 'number',
                        description: 'Optional timeout in seconds for long-running commands. Defaults to 300 (5 min). reset --destroy has a 900s minimum because it checkpoints before destroying.',
                    },
                },
                required: ['command', 'userMessage', 'icon'],
            },
        },
    },

    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { command, entityId } = args;
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });

        try {
            if (!command || typeof command !== 'string') {
                return JSON.stringify({ success: false, error: 'command is required' });
            }

            const route = routeCommand(command);

            if (!route) {
                // Plain shell command
                const blockedScan = shouldBlockExpensiveCloudFileScan(command);
                if (blockedScan) {
                    return JSON.stringify(blockedScan);
                }
                return handleShell(command, args, resolver);
            }

            if (route.handler === handleBg) {
                return route.handler(route.rawBgCommand, args, resolver);
            }

            if (route.handler === handlePoll) {
                return route.handler(route.processId, args, resolver);
            }

            if (route.handler === handleJobs) {
                return route.handler(args);
            }

            // reset handler receives tokens
            return route.handler(route.tokens, args, resolver);
        } catch (e) {
            logger.error(`WorkspaceSSH error: ${e.message}`);

            return JSON.stringify({ success: false, error: e.message });
        }
    },
};
