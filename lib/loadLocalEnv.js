import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export function loadLocalEnvFiles({
    cwd = process.cwd(),
    env = process.env,
    files = ['.env', '.env.local'],
} = {}) {
    const explicitKeys = new Set(Object.keys(env));
    const loaded = [];

    for (const file of files) {
        const envPath = path.resolve(cwd, file);
        if (!fs.existsSync(envPath)) continue;

        const parsed = dotenv.parse(fs.readFileSync(envPath));
        for (const [key, value] of Object.entries(parsed)) {
            if (explicitKeys.has(key)) continue;
            env[key] = value;
        }
        loaded.push(envPath);
    }

    return loaded;
}
