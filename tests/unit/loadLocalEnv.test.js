import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadLocalEnvFiles } from '../../lib/loadLocalEnv.js';

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-env-test-'));
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('loadLocalEnvFiles loads .env values', (t) => {
    const cwd = tempDir(t);
    fs.writeFileSync(path.join(cwd, '.env'), 'OPENAI_API_KEY=from-env\nCORTEX_ENABLE_REST=true\n');

    const env = {};
    const loaded = loadLocalEnvFiles({ cwd, env });

    t.deepEqual(loaded, [path.join(cwd, '.env')]);
    t.is(env.OPENAI_API_KEY, 'from-env');
    t.is(env.CORTEX_ENABLE_REST, 'true');
});

test('loadLocalEnvFiles lets .env.local override .env', (t) => {
    const cwd = tempDir(t);
    fs.writeFileSync(path.join(cwd, '.env'), 'OPENAI_API_KEY=from-env\nMODEL=base\n');
    fs.writeFileSync(path.join(cwd, '.env.local'), 'OPENAI_API_KEY=from-local\nLOCAL_ONLY=yes\n');

    const env = {};
    loadLocalEnvFiles({ cwd, env });

    t.is(env.OPENAI_API_KEY, 'from-local');
    t.is(env.MODEL, 'base');
    t.is(env.LOCAL_ONLY, 'yes');
});

test('loadLocalEnvFiles does not override explicit environment values', (t) => {
    const cwd = tempDir(t);
    fs.writeFileSync(path.join(cwd, '.env'), 'OPENAI_API_KEY=from-env\n');
    fs.writeFileSync(path.join(cwd, '.env.local'), 'OPENAI_API_KEY=from-local\n');

    const env = { OPENAI_API_KEY: 'from-shell' };
    loadLocalEnvFiles({ cwd, env });

    t.is(env.OPENAI_API_KEY, 'from-shell');
});
