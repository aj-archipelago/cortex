// sys_tool_workspace_ssh.js
// Consolidated workspace tool — one shell interface replaces 14 individual tools.
// Built-in pseudo-commands: bg, poll, reset.
import logger from '../../../../lib/logger.js';
import { sendToolStart, sendToolFinish } from '../../../../lib/pathwayTools.js';
import { workspaceRequest, destroyWorkspace } from './shared/workspace_client.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 300000;
const RESET_DESTROY_TIMEOUT_MS = 900000;

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
    return p.startsWith('/') ? p : `/workspace/${p}`;
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

User files: /workspace/files/ syncs to the user's cloud storage. Use /workspace/files only for files the user should receive or see in their file collection. If you need cloud URL or metadata for a created file, call FileCollection with fileRef set to the workspace path.

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

            // files and reset handlers receive tokens
            return route.handler(route.tokens, args, resolver);
        } catch (e) {
            logger.error(`WorkspaceSSH error: ${e.message}`);
            return JSON.stringify({ success: false, error: e.message });
        }
    },
};
