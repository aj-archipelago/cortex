// Exercise the actual Lua scripts when redis-server is installed. The ordinary
// unit suite remains portable; this suite explicitly reports a skip otherwise.
import test from 'ava';
import Redis from 'ioredis';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WeeklyCostLimits, WEEK_MS } from '../../../lib/WeeklyCostLimits.js';
const binary = process.env.REDIS_SERVER_BINARY || 'redis-server';
const available = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0;
const integration = available ? test.serial : test.skip;

integration('real Redis: concurrent cold starts, atomic spend, snapshots, recovery and resets', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-redis-'));
    const socket = join(dir, 'redis.sock');
    const child = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const probe = new Redis({ path: socket, retryStrategy: () => 20 });
    probe.on('error', () => {});
    const redisErrors = [];
    const workers = []; const docs = new Map(); let mongoCalls = 0, now = new Date();
    const db = { collection(name) {
        if (!docs.has(name)) docs.set(name, new Map());
        const table = docs.get(name);
        return {
            async findOne(filter) { mongoCalls++; return table.get(filter._id) || null; },
            async updateOne(filter, update) { mongoCalls++; if (!table.has(filter._id)) table.set(filter._id, { _id: filter._id, ...update.$setOnInsert }); Object.assign(table.get(filter._id), update.$set); },
            async bulkWrite(operations) {
                mongoCalls++;
                for (const { updateOne: op } of operations) {
                    if (!table.has(op.filter._id)) table.set(op.filter._id, { _id: op.filter._id, ...op.update.$setOnInsert });
                    const value = table.get(op.filter._id);
                    for (const [key, amount] of Object.entries(op.update.$max)) value[key] = Math.max(value[key] || 0, amount);
                }
            },
        };
    } };
    try {
        if (probe.status !== 'ready') await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Test Redis startup timed out')), 5000);
            probe.once('ready', () => { clearTimeout(timeout); resolve(); });
        });
        for (let i = 0; i < 20; i++) workers.push(new WeeklyCostLimits({ defaultWeeklyUsd: 500,
            // Exercise shared counters here; dedicated unit tests cover short outage deadlines.
            admissionTimeoutMs: 5000, onError: error => redisErrors.push(error.code || error.message),
            getUri: () => 'mongodb://test/redis-integration', getRedisUri: () => 'isolated', autoFlush: false, now: () => now,
            createRedis: () => new Redis({ path: socket, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 5000 }),
            createClient: () => ({ connect: async () => {}, close: async () => {}, db: () => db }),
            getModels: () => ({ model: { metadata: { pricing: { input: 5 } } } }),
        }));
        const key = '000000000001';
        const cold = await Promise.all(Array.from({ length: 10 }, (_, i) => workers[0].admit(String(i + 1).padStart(12, '0'))));
        t.true(cold.every(b => !b.degraded));
        const warm = await Promise.all(workers.map(worker => worker.admit(key)));
        t.true(warm.every(budget => !budget.degraded));
        const before = mongoCalls;
        await Promise.all(workers.map(async worker => {
            for (let i = 0; i < 50; i++) await worker.record({ weeklyCostBudget: await worker.admit(key) }, { model: 'model', input_tokens: 100_000 });
        }));
        t.is(mongoCalls, before);
        t.deepEqual(redisErrors, [], "Shared-counter checks must not silently use outage fallback");
        await t.throwsAsync(() => workers[0].admit(key), { code: 'weekly_cost_limit_exceeded' });
        await Promise.all(workers.map(worker => worker.flush()));
        const saved = [...docs.get('api_key_cost_periods').values()][0];
        t.is(saved.spentMicros, 500_000_000); t.is(saved.requests, 1000);
        await probe.flushdb(); // Only this test's private Redis instance.
        await t.throwsAsync(() => workers[1].admit(key), { code: 'weekly_cost_limit_exceeded' });
        now = new Date(+now + WEEK_MS);
        t.is((await workers[1].admit(key)).spentMicros, 0);
    } finally {
        await Promise.allSettled(workers.map(worker => worker.close())); probe.disconnect();
        if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(dir, { recursive: true, force: true });
    }
});
