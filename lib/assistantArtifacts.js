import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canAccessEntity } from './entityPreferences.js';
import { withAssistantExecutionUser } from './assistantExecution.js';

export const MAX_TEAM_ARTIFACT_BYTES = 32 * 1024 * 1024;
export async function readAssistantArtifact(store, args, download) {
    const entity = await store.getEntity(args.entityId, { fresh: true, throwOnError: true });
    if (!canAccessEntity(entity, args.userId) || entity.colleagueStatus === 'archived')
        throw new Error('Artifact workspace is not owned by this user');
    if (typeof args.path !== 'string' || !args.path.startsWith('/workspace/') || args.path.length > 512 || path.posix.normalize(args.path) !== args.path || [...args.path].some(c => c.charCodeAt(0) < 32 || c === '\\'))
        throw new Error('Invalid artifact path');
    if (!/^[a-f0-9]{64}$/.test(args.sha256 || '')) throw new Error('Invalid artifact hash');
    const dir = await mkdtemp(path.join(tmpdir(), 'assistant-artifact-'));
    const local = path.join(dir, 'artifact');
    try {
        const result = await withAssistantExecutionUser(args.userId, () => download(entity.id, args.path, local, { maxBytes: MAX_TEAM_ARTIFACT_BYTES }));
        if (!result.success) throw new Error('The reviewed artifact is currently unavailable');
        const bytes = await readFile(local);
        if (bytes.length > MAX_TEAM_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 32 MB download limit');
        if (createHash('sha256').update(bytes).digest('hex') !== args.sha256)
            throw new Error('Artifact changed since review; request a newly reviewed version');
        return { filename: path.posix.basename(args.path), base64: bytes.toString('base64') };
    } finally { await rm(dir, { recursive: true, force: true }); }
}
