#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function workspaceRetentionRules(container) {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(container) || container.includes('--')) throw new Error('An explicit valid Azure container name is required');
    const filters = { blobTypes: ['blockBlob'], prefixMatch: [`${container}/workspace-checkpoints/`] };
    return [
        { name: `${container}-workspace-history-14-days`, enabled: true, type: 'Lifecycle', definition: { filters,
            actions: { version: { delete: { daysAfterCreationGreaterThan: 14 } }, snapshot: { delete: { daysAfterCreationGreaterThan: 14 } } } } },
        { name: `${container}-workspace-candidates-14-days`, enabled: true, type: 'Lifecycle', definition: {
            filters: { ...filters, blobIndexMatch: [{ name: 'workspaceCheckpoint', op: '==', value: 'candidate' }] },
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 14 } } } } },
    ];
}

export function withWorkspaceRetention(policy, container) {
    const required = workspaceRetentionRules(container);
    const names = new Set(required.map(rule => rule.name));
    return { ...policy, rules: [...(policy.rules || []).filter(rule => !names.has(rule.name)), ...required] };
}

function canonical(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== null).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function retentionMatches(policy, container) {
    return workspaceRetentionRules(container).every(rule => canonical(policy.rules?.find(existing => existing.name === rule.name)) === canonical(rule));
}

function main() {
    const args = process.argv.slice(2);
    const get = flag => args[args.indexOf(flag) + 1];
    if (!['--account', '--resource-group', '--container'].every(flag => args.includes(flag))) {
        throw new Error('Usage: node scripts/workspace-checkpoint-retention.mjs --account <account> --resource-group <group> --container <container> [--check|--apply]');
    }
    const container = get('--container');
    workspaceRetentionRules(container);
    const common = ['--account-name', get('--account'), '--resource-group', get('--resource-group')];
    const az = command => JSON.parse(execFileSync('az', [...command, '-o', 'json'], { encoding: 'utf8' }));
    let original;
    try { original = az(['storage', 'account', 'management-policy', 'show', ...common]); }
    catch { throw new Error('Could not read existing lifecycle policy; no changes made'); }
    if (args.includes('--check')) {
        if (!retentionMatches(original.policy, container)) throw new Error(`Workspace retention is missing or incorrect for ${container}`);
        console.log(`Workspace retention verified for ${container}`);
        return;
    }
    const policy = withWorkspaceRetention(original.policy, container);
    if (!args.includes('--apply')) { console.log(JSON.stringify({ container, rules: workspaceRetentionRules(container) }, null, 2)); return; }
    const latest = az(['storage', 'account', 'management-policy', 'show', ...common]);
    if (canonical(latest) !== canonical(original)) throw new Error('Lifecycle policy changed; rerun from fresh state');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-retention-'));
    try {
        const file = path.join(directory, 'policy.json');
        fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
        az(['storage', 'account', 'management-policy', 'create', ...common, '--policy', `@${file}`]);
        const verified = az(['storage', 'account', 'management-policy', 'show', ...common]);
        if (!retentionMatches(verified.policy, container)) throw new Error('Workspace retention readback failed');
        console.log(`Workspace retention applied and verified for ${container}; other rules preserved`);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
