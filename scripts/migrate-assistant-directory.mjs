import 'dotenv/config';
import { getEntityStore } from '../lib/MongoEntityStore.js';
import { migrateAssistantDirectory } from '../lib/assistantDirectoryMigration.js';
const store = getEntityStore();
try {
    if (!store.isConfigured()) throw new Error('Configure MONGO_URI for the target environment');
    console.log(JSON.stringify(await migrateAssistantDirectory(await store._getCollection())));
} finally { await store.close(); }
