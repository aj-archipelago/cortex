import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const MAX_OUTPUT = 100 * 1024; // 100KB per stream
const MAX_BACKGROUND = 20;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_TIMEOUT_MS = 110_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_CWD = '/workspace';

// Background process store: processId -> { proc, stdout, stderr, exitCode, startedAt, completedAt }
const backgroundProcesses = new Map();

// Periodic cleanup of expired results
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of backgroundProcesses) {
        if (entry.completedAt && (now - entry.completedAt) > RESULT_TTL_MS) {
            backgroundProcesses.delete(id);
        }
    }
}, 60_000);
cleanupTimer.unref();

function truncate(str, max) {
    if (str.length <= max) return { text: str, truncated: false };
    return { text: str.slice(0, max), truncated: true };
}

function normalizeTimeout(timeout) {
    return Math.min(timeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function execCommand(command, options = {}) {
    const cwd = options.cwd || DEFAULT_CWD;
    const timeoutMs = normalizeTimeout(options.timeout);

    return new Promise((resolve) => {
        const startTime = Date.now();
        let stdout = '';
        let stderr = '';
        let killed = false;

        // Source /workspace/.env (injected by /reconfigure) so env vars
        // are available in all shell commands, not just interactive shells.
        const wrappedCommand = '[ -f /workspace/.env ] && . /workspace/.env; ' + command;
        const proc = spawn('/bin/bash', ['-c', wrappedCommand], {
            cwd,
            env: { ...process.env, HOME: '/root' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGKILL');
        }, timeoutMs);

        proc.stdout.on('data', (chunk) => {
            if (stdout.length < MAX_OUTPUT) {
                stdout += chunk.toString();
            }
        });

        proc.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_OUTPUT) {
                stderr += chunk.toString();
            }
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            const durationMs = Date.now() - startTime;
            const out = truncate(stdout, MAX_OUTPUT);
            const err = truncate(stderr, MAX_OUTPUT);

            resolve({
                success: code === 0 && !killed,
                stdout: out.text,
                stderr: err.text,
                exitCode: killed ? -1 : (code ?? -1),
                durationMs,
                killed,
                truncated: out.truncated || err.truncated,
            });
        });

        proc.on('error', (e) => {
            clearTimeout(timer);
            resolve({
                success: false,
                stdout: '',
                stderr: e.message,
                exitCode: -1,
                durationMs: Date.now() - startTime,
                killed: false,
                truncated: false,
            });
        });
    });
}

/**
 * Execute a shell command synchronously (blocks until done or timeout).
 */
export function execSync(command, options = {}) {
    return execCommand(command, options);
}

/**
 * Start a background process. Returns processId immediately.
 */
export function execBackground(command, options = {}) {
    if (backgroundProcesses.size >= MAX_BACKGROUND) {
        // Count running only
        let running = 0;
        for (const entry of backgroundProcesses.values()) {
            if (!entry.completedAt) running++;
        }
        if (running >= MAX_BACKGROUND) {
            return { error: `Maximum concurrent background processes (${MAX_BACKGROUND}) reached` };
        }
    }

    const processId = crypto.randomBytes(8).toString('hex');
    const cwd = options.cwd || DEFAULT_CWD;

    const entry = {
        stdout: '',
        stderr: '',
        exitCode: null,
        startedAt: Date.now(),
        completedAt: null,
        command: command.slice(0, 200), // store truncated command for display
    };

    const proc = spawn('/bin/bash', ['-c', command], {
        cwd,
        env: { ...process.env, HOME: '/root' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
        if (entry.stdout.length < MAX_OUTPUT) {
            entry.stdout += chunk.toString();
        }
    });

    proc.stderr.on('data', (chunk) => {
        if (entry.stderr.length < MAX_OUTPUT) {
            entry.stderr += chunk.toString();
        }
    });

    proc.on('close', (code) => {
        if (entry.exitCode === null) {
            entry.exitCode = code ?? -1;
        }
        entry.completedAt = Date.now();
    });

    proc.on('error', (e) => {
        entry.stderr += e.message;
        entry.exitCode = -1;
        entry.completedAt = Date.now();
    });

    entry.proc = proc;
    backgroundProcesses.set(processId, entry);

    return { processId };
}

/**
 * Get the result/status of a background process.
 */
export function getResult(processId) {
    const entry = backgroundProcesses.get(processId);
    if (!entry) {
        return { error: `Process ${processId} not found` };
    }

    const out = truncate(entry.stdout, MAX_OUTPUT);
    const err = truncate(entry.stderr, MAX_OUTPUT);
    const status = entry.completedAt ? (entry.exitCode === 0 ? 'completed' : 'failed') : 'running';

    return {
        processId,
        status,
        stdout: out.text,
        stderr: err.text,
        exitCode: entry.exitCode,
        durationMs: (entry.completedAt || Date.now()) - entry.startedAt,
        truncated: out.truncated || err.truncated,
    };
}

/**
 * List all background processes with summary info.
 */
export function listBackgroundJobs() {
    const jobs = [];
    for (const [id, entry] of backgroundProcesses) {
        const status = entry.completedAt ? (entry.exitCode === 0 ? 'completed' : 'failed') : 'running';
        jobs.push({
            processId: id,
            status,
            command: entry.command,
            startedAt: new Date(entry.startedAt).toISOString(),
            durationMs: (entry.completedAt || Date.now()) - entry.startedAt,
            exitCode: entry.exitCode,
        });
    }
    return jobs;
}
