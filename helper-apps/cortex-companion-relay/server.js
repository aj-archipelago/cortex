import Redis from 'ioredis';
import { createRelay } from './relay.js';

if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
const relay = await createRelay({ redis, adminKey: process.env.COMPANION_ADMIN_KEY, namespace: process.env.COMPANION_NAMESPACE || 'companion' });
relay.server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await relay.close(); await redis.quit();
});
