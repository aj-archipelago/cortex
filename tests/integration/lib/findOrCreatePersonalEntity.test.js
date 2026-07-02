import test from "ava";
import { MongoClient } from "mongodb";
import { v4 as uuidv4 } from "uuid";

const MONGO_URI = process.env.CORTEX_ENTITY_STORE_TEST_MONGO_URI;
const TEST_DATABASE = `cortex_test_${Date.now()}`;
const TEST_COLLECTION = "entities";
const mongoTest = MONGO_URI ? test.serial : test.serial.skip;

let client;
let db;
let collection;
let MongoEntityStore;
let previousMongoUri;

test.before(async () => {
  const mod = await import("../../../lib/MongoEntityStore.js");
  MongoEntityStore = mod.MongoEntityStore;

  if (!MONGO_URI) {
    return;
  }

  previousMongoUri = process.env.MONGO_URI;
  process.env.MONGO_URI = MONGO_URI;

  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(TEST_DATABASE);
  collection = db.collection(TEST_COLLECTION);
});

test.after.always(async () => {
  if (db) {
    await db.dropDatabase().catch(() => {});
  }
  if (client) {
    await client.close();
  }
  if (previousMongoUri === undefined) {
    delete process.env.MONGO_URI;
  } else {
    process.env.MONGO_URI = previousMongoUri;
  }
});

function createStore() {
  return new MongoEntityStore({
    databaseName: TEST_DATABASE,
    collectionName: TEST_COLLECTION,
  });
}

test("MongoEntityStore personal entity tests are opt-in", (t) => {
  if (MONGO_URI) {
    t.pass("CORTEX_ENTITY_STORE_TEST_MONGO_URI is configured");
  } else {
    t.pass("Set CORTEX_ENTITY_STORE_TEST_MONGO_URI to run live Mongo entity store coverage");
  }
});

mongoTest("findOrCreatePersonalEntity creates a new entity for a user", async (t) => {
  const store = createStore();
  const userId = `user-${uuidv4()}`;

  const result = await store.findOrCreatePersonalEntity(userId, {
    name: "TestBot",
    tools: ["*"],
    useMemory: true,
    assocUserIds: [userId],
  });

  t.truthy(result);
  t.is(result.name, "TestBot");
  t.true(result.created);
  t.truthy(result.id);

  const doc = await collection.findOne({ createdBy: userId });
  t.truthy(doc);
  t.is(doc.name, "TestBot");
  t.is(doc.createdBy, userId);

  await store.close();
});

mongoTest("syncConfigEntities persists and updates required env vars", async (t) => {
  const store = createStore();
  const entityId = `config-${uuidv4()}`;

  await store.syncConfigEntities({
    [entityId]: {
      name: "ConfigBot",
      tools: ["SearchInternet"],
      requiredEnvVars: ["SECRET_ONE", "SECRET_TWO"],
    },
  });

  let doc = await collection.findOne({ id: entityId });
  t.truthy(doc);
  t.deepEqual(doc.requiredEnvVars, ["SECRET_ONE", "SECRET_TWO"]);

  await store.syncConfigEntities({
    [entityId]: {
      name: "ConfigBot",
      tools: ["SearchInternet"],
    },
  });

  doc = await collection.findOne({ id: entityId });
  t.deepEqual(doc.requiredEnvVars, []);

  await store.close();
});

mongoTest("findOrCreatePersonalEntity returns existing entity on second call", async (t) => {
  const store = createStore();
  const userId = `user-${uuidv4()}`;

  const first = await store.findOrCreatePersonalEntity(userId, {
    name: "FirstName",
    tools: ["*"],
  });

  const second = await store.findOrCreatePersonalEntity(userId, {
    name: "DifferentName",
    tools: ["SearchInternet"],
  });

  t.is(first.id, second.id);
  t.is(second.name, "FirstName");
  t.false(second.created);

  const count = await collection.countDocuments({ createdBy: userId });
  t.is(count, 1);

  await store.close();
});

mongoTest("findOrCreatePersonalEntity handles concurrent calls without duplicates", async (t) => {
  const userId = `user-${uuidv4()}`;
  const stores = Array.from({ length: 5 }, () => createStore());

  const results = await Promise.all(
    stores.map((store) =>
      store.findOrCreatePersonalEntity(userId, {
        name: "RaceBot",
        tools: ["*"],
      }),
    ),
  );

  const ids = results.map((result) => result.id);
  const uniqueIds = [...new Set(ids)];
  t.is(uniqueIds.length, 1, `Expected 1 unique entity ID but got ${uniqueIds.length}: ${JSON.stringify(ids)}`);

  const count = await collection.countDocuments({ createdBy: userId });
  t.is(count, 1);

  const createdCount = results.filter((result) => result.created).length;
  t.is(createdCount, 1, `Expected exactly 1 created=true but got ${createdCount}`);

  await Promise.all(stores.map((store) => store.close()));
});

mongoTest("findOrCreatePersonalEntity reuses and repairs a personalOwnerId entity", async (t) => {
  const store = createStore();
  const userId = `user-${uuidv4()}`;
  const entityId = uuidv4();

  await collection.insertOne({
    id: entityId,
    name: "RecoveredBot",
    isSystem: false,
    personalOwnerId: userId,
    assocUserIds: [],
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const result = await store.findOrCreatePersonalEntity(userId, {
    id: entityId,
    name: "RecoveredBot",
  });

  t.truthy(result);
  t.is(result.id, entityId);
  t.is(result.name, "RecoveredBot");
  t.false(result.created);

  const repaired = await collection.findOne({ id: entityId });
  t.is(repaired.personalOwnerId, userId);
  t.is(repaired.createdBy, userId);
  t.true(repaired.assocUserIds.includes(userId));

  await store.close();
});

mongoTest("findOrCreatePersonalEntity upgrades a legacy createdBy-owned entity to personalOwnerId", async (t) => {
  const store = createStore();
  const userId = `user-${uuidv4()}`;
  const legacyId = uuidv4();

  await collection.insertOne({
    id: legacyId,
    name: "LegacyBot",
    isSystem: false,
    assocUserIds: [userId],
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const result = await store.findOrCreatePersonalEntity(userId, {
    name: "LegacyBot",
  });

  t.truthy(result);
  t.is(result.id, legacyId);
  t.false(result.created);

  const repaired = await collection.findOne({ id: legacyId });
  t.is(repaired.personalOwnerId, userId);

  await store.close();
});

mongoTest("findOrCreatePersonalEntity refuses ambiguous duplicate personal candidates", async (t) => {
  const store = createStore();
  const userId = `user-${uuidv4()}`;

  await collection.insertMany([
    {
      id: uuidv4(),
      name: "OwnerBotA",
      isSystem: false,
      assocUserIds: [userId],
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: uuidv4(),
      name: "OwnerBotB",
      isSystem: false,
      assocUserIds: [userId],
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const result = await store.findOrCreatePersonalEntity(userId, {
    name: "OwnerBot",
  });

  t.is(result, null);

  await store.close();
});

mongoTest("findOrCreatePersonalEntity does not match system entities", async (t) => {
  const store = createStore();
  const userId = `user-${uuidv4()}`;

  await collection.insertOne({
    id: uuidv4(),
    name: "SystemBot",
    isSystem: true,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const result = await store.findOrCreatePersonalEntity(userId, {
    name: "PersonalBot",
  });

  t.truthy(result);
  t.is(result.name, "PersonalBot");
  t.true(result.created);

  await store.close();
});

mongoTest("findOrCreatePersonalEntity returns null for missing userId", async (t) => {
  const store = createStore();

  const result = await store.findOrCreatePersonalEntity(null, { name: "NoUser" });
  t.is(result, null);

  const result2 = await store.findOrCreatePersonalEntity("", { name: "NoUser" });
  t.is(result2, null);

  await store.close();
});
