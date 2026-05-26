/**
 * MongoDB Entity Store
 *
 * Manages entity configurations in MongoDB with UUID-based identifiers.
 * Entities define AI personas with their identity, tools, and resources.
 *
 * Schema:
 * - id: UUID (primary identifier)
 * - name: String (human-readable name, e.g., "Jarvis")
 * - isDefault: Boolean (default entity for this deployment)
 * - isSystem: Boolean (system entity - hidden from normal entity lists)
 * - useMemory: Boolean (enable memory)
 * - description: String (entity description for display)
 * - identity: String (core identity/persona - renamed from "instructions")
 * - avatar: Object (optional visual representation)
 *   - text: String (optional - text/emoji representation)
 *   - image: Object (optional - { url, gcs, name })
 *   - video: Object (optional - { url, gcs, name })
 * - tools: [String] (tool names - explicit list preferred, ["*"] for all supported for backward compat)
 * - resources: [{ url, gcs, name, type }] (attached media/documents)
 * - customTools: Object (entity-specific tool definitions)
 * - requiredEnvVars: [String] (environment variables required for this entity to be available)
 * - personalOwnerId: String (authoritative owner for personal entities only)
 * - assocUserIds: [String] (user IDs associated with this entity - for private entities)
 * - createdBy: String (userId who created this entity)
 * - baseModel: String (optional - base model for the entity, e.g., "gemini-flash-3-vision")
 * - reasoningEffort: String (optional - reasoning effort level, e.g., "high", "low")
 * - createdAt: Date
 * - updatedAt: Date
 */

import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';
import logger from './logger.js';

// Tool migration is optional - will be added later if needed
let migrateToolList = (tools) => tools;
let needsMigration = () => false;

// Try to import tool migrations (may not exist yet)
try {
    const migrations = await import('../pathways/system/entity/tools/shared/tool_migrations.js');
    migrateToolList = migrations.migrateToolList;
    needsMigration = migrations.needsMigration;
} catch {
    // Tool migrations not available yet - use pass-through
}

// Default collection name
const DEFAULT_COLLECTION = 'entities';

/**
 * Singleton instance
 * @type {MongoEntityStore|null}
 */
let instance = null;

function hasMeaningfulPersonalEntityState(entity) {
    if (!entity || typeof entity !== 'object') {
        return false;
    }

    return Boolean(
        entity.workspace ||
        (Array.isArray(entity.resources) && entity.resources.length > 0) ||
        (entity.customTools && Object.keys(entity.customTools).length > 0) ||
        (entity.secrets && Object.keys(entity.secrets).length > 0)
    );
}

function rankPersonalEntityCandidate(entity, userId) {
    let score = 0;

    if (entity?.personalOwnerId === userId) score += 1000;
    if (entity?.createdBy === userId) score += 500;
    if (Array.isArray(entity?.assocUserIds) && entity.assocUserIds.includes(userId)) score += 100;
    if (hasMeaningfulPersonalEntityState(entity)) score += 50;

    return score;
}

export class MongoEntityStore {
    /**
     * @param {Object} [mongoConfig]
     * @param {string} [mongoConfig.collectionName] - Custom collection name
     * @param {string} [mongoConfig.databaseName] - Database name (defaults to URI database)
     */
    constructor(mongoConfig = {}) {
        this.collectionName = mongoConfig.collectionName || DEFAULT_COLLECTION;
        this.databaseName = mongoConfig.databaseName || null;

        // Get connection string from environment
        this.connectionString = process.env.MONGO_URI || '';

        // Connection state
        this._client = null;
        this._db = null;
        this._collection = null;
        this._connected = false;

        // Cache for entities (loaded on startup)
        this._entityCache = new Map();
        this._cacheTimestamps = new Map(); // Track when each entity was last fetched
        this._cacheTTL = 10000; // 10 seconds TTL
        this._cacheLoaded = false;
    }

    /**
     * Get or create singleton instance
     * @param {Object} [options]
     * @returns {MongoEntityStore}
     */
    static getInstance(options = {}) {
        if (!instance) {
            instance = new MongoEntityStore(options);
        }
        return instance;
    }

    /**
     * Check if MongoDB is configured
     * @returns {boolean}
     */
    isConfigured() {
        return !!this.connectionString;
    }

    /**
     * Get or create MongoDB connection
     * @private
     * @returns {Promise<import('mongodb').Collection>}
     */
    async _getCollection() {
        if (this._collection && this._connected) {
            return this._collection;
        }

        if (!this.isConfigured()) {
            throw new Error('MongoDB not configured - MONGO_URI not set');
        }

        try {
            // Use default connection options - mongodb+srv:// automatically handles TLS
            // No explicit TLS options needed (same approach as concierge)
            this._client = new MongoClient(this.connectionString);
            await this._client.connect();

            // Get database - priority: explicit config > URI path > fallback
            if (this.databaseName) {
                this._db = this._client.db(this.databaseName);
            } else {
                this._db = this._client.db();
            }

            // Verify we have a database name
            if (!this._db.databaseName) {
                this._db = this._client.db('cortex');
            }

            this._collection = this._db.collection(this.collectionName);
            this._connected = true;

            // Ensure unique index on entity id for safe concurrent upserts
            try {
                await this._collection.createIndex({ id: 1 }, { unique: true, background: true });
            } catch (e) {
                // CosmosDB doesn't allow modifying unique indexes after collection creation.
                // If the index already exists, this is safe to ignore.
                logger.warn(`Could not create unique index on entities (may already exist): ${e.message}`);
            }

            // Enforce exactly one personal entity per user without encoding
            // semantics into entity ids. Non-personal entities simply omit this field.
            try {
                await this._collection.createIndex(
                    { personalOwnerId: 1 },
                    { unique: true, sparse: true, background: true },
                );
            } catch (e) {
                logger.warn(
                    `Could not create unique index on entities.personalOwnerId (may already exist or require cleanup first): ${e.message}`,
                );
            }

            // Reaper lookup path: one ACI container group name should map to
            // at most one runtime workspace record, but keep this non-unique
            // to avoid migration risk with old drifted data.
            try {
                await this._collection.createIndex(
                    { 'workspace.containerId': 1 },
                    { sparse: true, background: true },
                );
            } catch (e) {
                logger.warn(
                    `Could not create sparse index on entities.workspace.containerId (may already exist): ${e.message}`,
                );
            }

            logger.info(`Connected to MongoDB entities: ${this._db.databaseName}.${this.collectionName}`);
            return this._collection;
        } catch (error) {
            logger.error(`MongoDB entity store connection failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Close MongoDB connection
     */
    async close() {
        if (this._client) {
            await this._client.close();
            this._client = null;
            this._db = null;
            this._collection = null;
            this._connected = false;
        }
        this._entityCache.clear();
        this._cacheLoaded = false;
    }

    // ==================== ENTITY CRUD OPERATIONS ====================

    /**
     * Load all entities into cache (called on startup)
     * @returns {Promise<Object>} Entity config object keyed by UUID
     */
    async loadAllEntities() {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured - entities will not be available');
            return null;
        }

        try {
            const collection = await this._getCollection();
            const entities = await collection.find({}).toArray();

            // Build cache keyed by UUID
            const entityConfig = {};
            const now = Date.now();
            const entitiesToMigrate = [];

            for (const entity of entities) {
                const { _id, ...entityData } = entity;

                // Check if entity tools need migration
                if (needsMigration(entityData.tools)) {
                    const oldTools = [...entityData.tools];
                    entityData.tools = migrateToolList(entityData.tools);
                    entitiesToMigrate.push({ id: entity.id, tools: entityData.tools });
                    logger.info(`Migrating tools for entity ${entityData.name} (${entity.id}): [${oldTools.join(', ')}] -> [${entityData.tools.join(', ')}]`);
                }

                // Cache by UUID only with timestamp
                this._entityCache.set(entity.id, entityData);
                this._cacheTimestamps.set(entity.id, now);

                // Config object keyed by UUID
                entityConfig[entity.id] = entityData;
            }

            // Persist migrated entities to database
            if (entitiesToMigrate.length > 0) {
                for (const { id, tools } of entitiesToMigrate) {
                    try {
                        await collection.updateOne(
                            { id },
                            { $set: { tools, updatedAt: new Date() } }
                        );
                    } catch (err) {
                        logger.error(`Failed to persist tool migration for entity ${id}: ${err.message}`);
                    }
                }
                logger.info(`Persisted tool migrations for ${entitiesToMigrate.length} entity(ies)`);
            }

            this._cacheLoaded = true;
            logger.info(`Loaded ${entities.length} entities from MongoDB`);

            return entityConfig;
        } catch (error) {
            logger.error(`Failed to load entities from MongoDB: ${error.message}`);
            return null;
        }
    }

    /**
     * Sync config-defined entities to MongoDB.
     * For each config entity, upserts to MongoDB so config always wins.
     * Maps `instructions` to `identity` to match MongoDB schema.
     * Preserves `createdAt` via $setOnInsert for existing entities.
     *
     * @param {Object} configEntityMap - Entity config map from config.get('entityConfig')
     * @returns {Promise<void>}
     */
    async syncConfigEntities(configEntityMap) {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured — skipping config entity sync');
            return;
        }

        if (!configEntityMap || typeof configEntityMap !== 'object') {
            return;
        }

        const entries = Object.entries(configEntityMap);
        if (entries.length === 0) {
            return;
        }

        try {
            const collection = await this._getCollection();
            const now = new Date();
            let synced = 0;

            for (const [id, cfg] of entries) {
                const doc = {
                    id,
                    name: cfg.name || id,
                    isDefault: cfg.isDefault ?? false,
                    isSystem: cfg.isSystem ?? false,
                    useMemory: cfg.useMemory ?? true,
                    description: cfg.description || '',
                    identity: cfg.identity || cfg.instructions || '',
                    avatar: cfg.avatar || null,
                    voice: cfg.voice || null,
                    tools: cfg.tools || ['*'],
                    resources: cfg.resources || cfg.files || [],
                    customTools: cfg.customTools || {},
                    requiredEnvVars: cfg.requiredEnvVars || [],
                    baseModel: cfg.baseModel || null,
                    preferredModel: cfg.preferredModel || null,
                    modelOverride: cfg.modelOverride || null,
                    reasoningEffort: cfg.reasoningEffort || null,
                    updatedAt: now,
                };

                // Only overwrite workspace if the config explicitly defines it —
                // runtime workspace state must survive config syncs on deploy.
                if (Object.hasOwn(cfg, 'workspace')) {
                    doc.workspace = cfg.workspace || null;
                }

                await collection.updateOne(
                    { id },
                    {
                        $set: doc,
                        $setOnInsert: { createdAt: now },
                    },
                    { upsert: true },
                );
                synced++;
            }

            logger.info(`Synced ${synced} config entities to MongoDB: [${entries.map(([id]) => id).join(', ')}]`);
        } catch (error) {
            logger.error(`Failed to sync config entities to MongoDB: ${error.message}`);
        }
    }

    /**
     * Get entity by UUID
     * @param {string} entityId - Entity UUID
     * @param {Object} [options]
     * @param {boolean} [options.fresh=false] - Bypass cache and fetch fresh from MongoDB
     * @param {boolean} [options.throwOnError=false] - Throw instead of falling back to cache/null when MongoDB lookup fails
     * @returns {Promise<Object|null>}
     */
    async getEntity(entityId, options = {}) {
        if (!entityId) return null;

        const { fresh = false, throwOnError = false } = options;

        // Check if cache entry is stale (older than TTL)
        const cachedTimestamp = this._cacheTimestamps.get(entityId) || 0;
        const isStale = Date.now() - cachedTimestamp > this._cacheTTL;

        // Return from cache if: not fresh requested, cache is loaded, entity exists, and not stale
        if (!fresh && !isStale && this._cacheLoaded && this._entityCache.has(entityId)) {
            const cached = this._entityCache.get(entityId);
            return cached ? JSON.parse(JSON.stringify(cached)) : undefined;
        }

        if (!this.isConfigured()) {
            // Fall back to potentially stale cache if MongoDB not available
            if (this._entityCache.has(entityId)) {
                const cached = this._entityCache.get(entityId);
                return cached ? JSON.parse(JSON.stringify(cached)) : undefined;
            }
            return null;
        }

        try {
            const collection = await this._getCollection();

            // Find by UUID only
            const entity = await collection.findOne({ id: entityId });

            if (entity) {
                const { _id, ...entityData } = entity;

                // Check if entity tools need migration
                if (needsMigration(entityData.tools)) {
                    const oldTools = [...entityData.tools];
                    entityData.tools = migrateToolList(entityData.tools);
                    logger.info(`Migrating tools for entity ${entityData.name} (${entity.id}): [${oldTools.join(', ')}] -> [${entityData.tools.join(', ')}]`);

                    // Persist migration to database
                    try {
                        await collection.updateOne(
                            { id: entity.id },
                            { $set: { tools: entityData.tools, updatedAt: new Date() } }
                        );
                    } catch (err) {
                        logger.error(`Failed to persist tool migration for entity ${entity.id}: ${err.message}`);
                    }
                }

                // Update cache and timestamp
                this._entityCache.set(entity.id, entityData);
                this._cacheTimestamps.set(entity.id, Date.now());
                return entityData;
            }

            return null;
        } catch (error) {
            logger.error(`Failed to get entity ${entityId}: ${error.message}`);
            if (throwOnError) throw error;
            // Fall back to potentially stale cache on error
            if (this._entityCache.has(entityId)) {
                const cached = this._entityCache.get(entityId);
                return cached ? JSON.parse(JSON.stringify(cached)) : undefined;
            }
            return null;
        }
    }

    /**
     * Find the entity currently assigned to a workspace container group.
     * Used by the ACI reaper to avoid scanning every entity on each tick.
     * @param {string} containerId
     * @returns {Promise<Object|null>}
     */
    async getEntityByWorkspaceContainerId(containerId) {
        if (!containerId || typeof containerId !== 'string') {
            return null;
        }

        if (!this.isConfigured()) {
            for (const entity of this._entityCache.values()) {
                if (entity?.workspace?.containerId === containerId) {
                    return JSON.parse(JSON.stringify(entity));
                }
            }
            return null;
        }

        try {
            const collection = await this._getCollection();
            const matches = await collection
                .find({ 'workspace.containerId': containerId })
                .limit(2)
                .toArray();

            if (matches.length === 0) return null;
            if (matches.length > 1) {
                logger.warn(
                    `Multiple entities reference workspace.containerId=${containerId}; using the first match`,
                );
            }

            const { _id, ...entityData } = matches[0];
            this._entityCache.set(entityData.id, entityData);
            this._cacheTimestamps.set(entityData.id, Date.now());
            return entityData;
        } catch (error) {
            logger.error(`Failed to get entity by workspace container ${containerId}: ${error.message}`);
            for (const entity of this._entityCache.values()) {
                if (entity?.workspace?.containerId === containerId) {
                    return JSON.parse(JSON.stringify(entity));
                }
            }
            throw error;
        }
    }

    /**
     * Get the default entity
     * @returns {Promise<Object|null>}
     */
    async getDefaultEntity() {
        // Check cache first
        if (this._cacheLoaded) {
            for (const entity of this._entityCache.values()) {
                if (entity.isDefault) return JSON.parse(JSON.stringify(entity));
            }
        }

        if (!this.isConfigured()) {
            return null;
        }

        try {
            const collection = await this._getCollection();
            const entity = await collection.findOne({ isDefault: true });

            if (entity) {
                const { _id, ...entityData } = entity;
                return entityData;
            }

            // Fall back to first entity if no default
            const firstEntity = await collection.findOne({});
            if (firstEntity) {
                const { _id, ...entityData } = firstEntity;
                return entityData;
            }

            return null;
        } catch (error) {
            logger.error(`Failed to get default entity: ${error.message}`);
            return null;
        }
    }

    /**
     * Get all entities (for sys_get_entities)
     * @param {Object} [options]
     * @param {boolean} [options.includeSystem=false] - Include system entities
     * @param {string} [options.userId] - Filter to entities associated with this user
     * @param {boolean} [options.fresh=false] - Bypass cache and fetch fresh from MongoDB
     * @returns {Promise<Object[]>}
     */
    async getAllEntities(options = {}) {
        const { includeSystem = false, userId, fresh = false } = options;

        // Return from cache if loaded
        if (!fresh && this._cacheLoaded) {
            const entities = [];
            const seenIds = new Set();

            for (const entity of this._entityCache.values()) {
                if (entity.id && !seenIds.has(entity.id)) {
                    // Filter out system entities unless requested
                    if (!includeSystem && entity.isSystem) {
                        continue;
                    }
                    // Filter by userId if provided
                    if (userId) {
                        if (!entity.isSystem) {
                            const assocUserIds = Array.isArray(entity.assocUserIds)
                                ? entity.assocUserIds
                                : [];
                            const isPublicEntity = assocUserIds.length === 0;
                            if (!isPublicEntity && !assocUserIds.includes(userId)) {
                                continue;
                            }
                        }
                    }
                    seenIds.add(entity.id);
                    entities.push(entity);
                }
            }
            return entities;
        }

        if (!this.isConfigured()) {
            return [];
        }

        try {
            const collection = await this._getCollection();

            // Build query
            const query = {};
            if (!includeSystem) {
                query.isSystem = { $ne: true };
            }
            if (userId) {
                const userFilter = [
                    { assocUserIds: { $exists: false } },
                    { assocUserIds: { $size: 0 } },
                    { assocUserIds: userId }
                ];

                if (includeSystem) {
                    query.$or = [
                        { isSystem: true },
                        { isSystem: { $ne: true }, $or: userFilter }
                    ];
                } else {
                    query.$or = userFilter;
                }
            }

            const entities = await collection.find(query).toArray();
            const now = Date.now();
            return entities.map(e => {
                const { _id, ...entityData } = e;
                this._entityCache.set(entityData.id, entityData);
                this._cacheTimestamps.set(entityData.id, now);
                return entityData;
            });
        } catch (error) {
            logger.error(`Failed to get all entities: ${error.message}`);
            return [];
        }
    }

    /**
     * Get system entity by name
     * @param {string} name - System entity name
     * @returns {Promise<Object|null>}
     */
    async getSystemEntity(name) {
        // Check cache first
        if (this._cacheLoaded) {
            for (const entity of this._entityCache.values()) {
                if (entity.isSystem && entity.name?.toLowerCase() === name.toLowerCase()) {
                    return JSON.parse(JSON.stringify(entity));
                }
            }
        }

        if (!this.isConfigured()) {
            return null;
        }

        try {
            const collection = await this._getCollection();
            const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const entity = await collection.findOne({
                name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
                isSystem: true
            });

            if (entity) {
                const { _id, ...entityData } = entity;
                this._entityCache.set(entity.id, entityData);
                return entityData;
            }

            return null;
        } catch (error) {
            logger.error(`Failed to get system entity ${name}: ${error.message}`);
            return null;
        }
    }

    /**
     * Get entities for a specific user
     * @param {string} userId - User ID
     * @returns {Promise<Object[]>}
     */
    async getEntitiesForUser(userId) {
        return this.getAllEntities({ userId, includeSystem: false });
    }

    /**
     * Add a user association to an entity
     * @param {string} entityId - Entity UUID
     * @param {string} userId - User ID to associate
     * @returns {Promise<boolean>}
     */
    async addUserToEntity(entityId, userId) {
        if (!this.isConfigured() || !entityId || !userId) {
            return false;
        }

        try {
            const collection = await this._getCollection();

            await collection.updateOne(
                { id: entityId },
                {
                    $addToSet: { assocUserIds: userId },
                    $set: { updatedAt: new Date() }
                }
            );

            // Update local cache
            if (this._entityCache.has(entityId)) {
                const entity = this._entityCache.get(entityId);
                entity.assocUserIds = entity.assocUserIds || [];
                if (!entity.assocUserIds.includes(userId)) {
                    entity.assocUserIds.push(userId);
                }
            }

            logger.info(`Added user ${userId} to entity ${entityId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to add user to entity: ${error.message}`);
            return false;
        }
    }

    /**
     * Remove a user association from an entity
     * @param {string} entityId - Entity UUID
     * @param {string} userId - User ID to disassociate
     * @returns {Promise<boolean>}
     */
    async removeUserFromEntity(entityId, userId) {
        if (!this.isConfigured() || !entityId || !userId) {
            return false;
        }

        try {
            const collection = await this._getCollection();

            await collection.updateOne(
                { id: entityId },
                {
                    $pull: { assocUserIds: userId },
                    $set: { updatedAt: new Date() }
                }
            );

            // Update local cache
            if (this._entityCache.has(entityId)) {
                const entity = this._entityCache.get(entityId);
                if (entity.assocUserIds && Array.isArray(entity.assocUserIds)) {
                    entity.assocUserIds = entity.assocUserIds.filter(id => id !== userId);
                }
            }

            logger.info(`Removed user ${userId} from entity ${entityId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to remove user from entity: ${error.message}`);
            return false;
        }
    }

    /**
     * Create or update an entity.
     * For updates, fields not present in the input are preserved from the
     * existing document — callers can pass partial objects safely without
     * accidentally wiping workspace, secrets, or user associations.
     * @param {Object} entity - Entity data (partial for updates, full for creates)
     * @returns {Promise<string|null>} Entity ID
     */
    async upsertEntity(entity) {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured - cannot store entity');
            return null;
        }

        try {
            const collection = await this._getCollection();
            const now = new Date();

            // Generate UUID if not provided
            const id = entity.id || uuidv4();

            // Load existing entity so we can merge — prevents partial updates
            // from wiping fields the caller didn't intend to change.
            const existingEntity = this._entityCache.get(id) || await this.getEntity(id);
            const base = existingEntity || {};

            const pick = (key, fallback) =>
                Object.hasOwn(entity, key) ? entity[key] : (base[key] ?? fallback);

            const doc = {
                id,
                name: pick('name', 'Unnamed Entity') || 'Unnamed Entity',
                isDefault: pick('isDefault', false),
                isSystem: pick('isSystem', false),
                useMemory: pick('useMemory', true),
                description: pick('description', ''),
                identity: Object.hasOwn(entity, 'identity')
                    ? (entity.identity || '')
                    : Object.hasOwn(entity, 'instructions')
                        ? (entity.instructions || '')
                        : (base.identity ?? ''),
                avatar: pick('avatar', null),
                voice: pick('voice', null),
                tools: pick('tools', ['*']),
                resources: Object.hasOwn(entity, 'resources')
                    ? (entity.resources || [])
                    : Object.hasOwn(entity, 'files')
                        ? (entity.files || [])
                        : (base.resources ?? []),
                customTools: pick('customTools', {}),
                requiredEnvVars: pick('requiredEnvVars', []),
                personalOwnerId: pick('personalOwnerId', undefined),
                assocUserIds: pick('assocUserIds', []),
                createdBy: pick('createdBy', null),
                baseModel: pick('baseModel', null),
                preferredModel: pick('preferredModel', null),
                modelOverride: pick('modelOverride', null),
                reasoningEffort: pick('reasoningEffort', null),
                workspace: pick('workspace', null),
                secrets: pick('secrets', null),
                updatedAt: now
            };

            if (doc.personalOwnerId == null || doc.personalOwnerId === '') {
                delete doc.personalOwnerId;
            }

            // If setting as default, unset other defaults first
            if (doc.isDefault) {
                await collection.updateMany(
                    { isDefault: true, id: { $ne: id } },
                    { $set: { isDefault: false } }
                );
            }

            const createdAt = existingEntity?.createdAt || entity.createdAt || now;

            await collection.updateOne(
                { id },
                {
                    $set: doc,
                    $setOnInsert: { createdAt }
                },
                { upsert: true }
            );

            // Update cache
            const cachedDoc = {
                ...doc,
                createdAt
            };
            this._entityCache.set(id, cachedDoc);
            this._cacheTimestamps.set(id, Date.now());

            logger.info(`Upserted entity: ${doc.name} (${id})`);
            return id;
        } catch (error) {
            logger.error(`Failed to upsert entity: ${error.message}`);
            return null;
        }
    }

    /**
     * Atomically find or create a personal entity for a user.
     * Uses findOneAndUpdate with upsert to prevent race conditions
     * where concurrent requests both create an entity for the same user.
     * @param {string} userId - The user ID
     * @param {Object} entityDefaults - Fields to set only on insert
     * @returns {Promise<{id: string, name: string, created: boolean}|null>}
     */
    async findOrCreatePersonalEntity(userId, entityDefaults) {
        if (!this.isConfigured() || !userId) {
            return null;
        }

        try {
            const collection = await this._getCollection();
            const now = new Date();
            const id = uuidv4();
            const candidateQuery = {
                isSystem: { $ne: true },
                $or: [
                    { personalOwnerId: userId },
                    { createdBy: userId },
                ],
            };
            const existingCandidates = await collection.find(candidateQuery).toArray();
            const rankedExisting = [...existingCandidates].sort((left, right) => {
                const scoreDiff =
                    rankPersonalEntityCandidate(right, userId) -
                    rankPersonalEntityCandidate(left, userId);

                if (scoreDiff !== 0) {
                    return scoreDiff;
                }

                const updatedLeft = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
                const updatedRight = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
                return updatedRight - updatedLeft;
            });
            const topExisting = rankedExisting[0] || null;
            const secondExisting = rankedExisting[1] || null;

            if (topExisting && secondExisting) {
                const topScore = rankPersonalEntityCandidate(topExisting, userId);
                const secondScore = rankPersonalEntityCandidate(secondExisting, userId);
                const bothStateful =
                    hasMeaningfulPersonalEntityState(topExisting) &&
                    hasMeaningfulPersonalEntityState(secondExisting);

                if (bothStateful || topScore === secondScore) {
                    logger.error(
                        `Refusing to create or select a personal entity for ${userId}: ambiguous candidates [${rankedExisting.map(entity => entity.id).join(', ')}]`,
                    );
                    return null;
                }
            }

            if (topExisting) {
                let doc = topExisting;
                const ownershipUpdates = {};
                if (doc.personalOwnerId && doc.personalOwnerId !== userId) {
                    logger.error(
                        `Refusing to reassign personal entity ${doc.id} from ${doc.personalOwnerId} to ${userId}`,
                    );
                    return null;
                }
                if (doc.personalOwnerId !== userId) {
                    ownershipUpdates.personalOwnerId = userId;
                }
                if (doc.createdBy !== userId) {
                    ownershipUpdates.createdBy = userId;
                }
                const missingAssoc =
                    !Array.isArray(doc.assocUserIds) || !doc.assocUserIds.includes(userId);

                if (Object.keys(ownershipUpdates).length > 0 || missingAssoc) {
                    const update = {
                        $set: {
                            ...ownershipUpdates,
                            updatedAt: now,
                        },
                    };

                    if (missingAssoc) {
                        update.$addToSet = { assocUserIds: userId };
                    }

                    await collection.updateOne({ id: doc.id }, update);
                    doc = {
                        ...doc,
                        ...ownershipUpdates,
                        assocUserIds: missingAssoc
                            ? [...new Set([...(doc.assocUserIds || []), userId])]
                            : doc.assocUserIds,
                        updatedAt: now,
                    };
                }

                this._entityCache.set(doc.id, doc);
                this._cacheTimestamps.set(doc.id, Date.now());
                logger.info(`Found existing personal entity ${doc.id} for user ${userId}`);
                return { id: doc.id, name: doc.name, created: false };
            }

            const filter = {
                personalOwnerId: userId,
                isSystem: { $ne: true },
            };

            let result;
            try {
                result = await collection.findOneAndUpdate(
                    filter,
                    {
                        $setOnInsert: {
                            id,
                            name: entityDefaults.name || 'Unnamed Entity',
                            isDefault: false,
                            isSystem: false,
                            useMemory: entityDefaults.useMemory ?? true,
                            description: entityDefaults.description || '',
                            identity: entityDefaults.identity || '',
                            avatar: entityDefaults.avatar || null,
                            voice: entityDefaults.voice || null,
                            tools: entityDefaults.tools || ['*'],
                            resources: entityDefaults.resources || [],
                            customTools: entityDefaults.customTools || {},
                            personalOwnerId: userId,
                            assocUserIds: entityDefaults.assocUserIds || [userId],
                            createdBy: userId,
                            baseModel: entityDefaults.baseModel || null,
                            preferredModel: entityDefaults.preferredModel || null,
                            modelOverride: entityDefaults.modelOverride || null,
                            reasoningEffort: entityDefaults.reasoningEffort || null,
                            workspace: null,
                            secrets: null,
                            createdAt: now,
                            updatedAt: now,
                        },
                    },
                    {
                        upsert: true,
                        returnDocument: 'after',
                        includeResultMetadata: true,
                    },
                );
            } catch (error) {
                if (error?.code === 11000 || /duplicate key/i.test(error?.message || '')) {
                    const existing = await collection.findOne(filter);
                    if (!existing) {
                        throw error;
                    }
                    result = {
                        value: existing,
                        lastErrorObject: { updatedExisting: true },
                    };
                } else {
                    throw error;
                }
            }

            let doc = result?.value;
            if (!doc) {
                return null;
            }
            const created = Boolean(result?.lastErrorObject?.upserted);

            if (doc.personalOwnerId && doc.personalOwnerId !== userId) {
                logger.error(
                    `Refusing to reassign personal entity ${doc.id} from ${doc.personalOwnerId} to ${userId}`,
                );
                return null;
            }
            if (doc.isSystem) {
                logger.error(
                    `Refusing to use system entity ${doc.id} as a personal entity for ${userId}`,
                );
                return null;
            }

            const ownershipUpdates = {};
            if (doc.personalOwnerId !== userId) {
                ownershipUpdates.personalOwnerId = userId;
            }
            if (doc.createdBy !== userId) {
                ownershipUpdates.createdBy = userId;
            }
            if (doc.isSystem) {
                ownershipUpdates.isSystem = false;
            }
            const missingAssoc =
                !Array.isArray(doc.assocUserIds) || !doc.assocUserIds.includes(userId);

            if (Object.keys(ownershipUpdates).length > 0 || missingAssoc) {
                const update = {
                    $set: {
                        ...ownershipUpdates,
                        updatedAt: now,
                    },
                };

                if (missingAssoc) {
                    update.$addToSet = { assocUserIds: userId };
                }

                await collection.updateOne({ id: doc.id }, update);

                doc = {
                    ...doc,
                    ...ownershipUpdates,
                    assocUserIds: missingAssoc
                        ? [...new Set([...(doc.assocUserIds || []), userId])]
                        : doc.assocUserIds,
                    updatedAt: now,
                };
            }

            // Update cache
            this._entityCache.set(doc.id, doc);
            this._cacheTimestamps.set(doc.id, Date.now());

            if (created) {
                logger.info(`Created personal entity ${doc.id} for user ${userId}`);
            } else {
                logger.info(`Found existing personal entity ${doc.id} for user ${userId}`);
            }

            return { id: doc.id, name: doc.name, created };
        } catch (error) {
            logger.error(`Failed to find/create personal entity for user ${userId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Delete an entity by UUID
     * @param {string} entityId - Entity UUID
     * @returns {Promise<boolean>}
     */
    async deleteEntity(entityId) {
        if (!this.isConfigured() || !entityId) {
            return false;
        }

        try {
            const collection = await this._getCollection();

            const entity = await this.getEntity(entityId);
            if (!entity) {
                return false;
            }

            await collection.deleteOne({ id: entityId });

            this._entityCache.delete(entityId);
            this._cacheTimestamps.delete(entityId);

            logger.info(`Deleted entity: ${entity.name} (${entityId})`);
            return true;
        } catch (error) {
            logger.error(`Failed to delete entity: ${error.message}`);
            return false;
        }
    }

    /**
     * Invalidate cache (force reload on next access)
     */
    invalidateCache() {
        this._entityCache.clear();
        this._cacheTimestamps.clear();
        this._cacheLoaded = false;
    }

    /**
     * Check if entities exist in MongoDB
     * @returns {Promise<boolean>}
     */
    async hasEntities() {
        if (!this.isConfigured()) {
            return false;
        }

        try {
            const collection = await this._getCollection();
            const count = await collection.countDocuments({}, { limit: 1 });
            return count > 0;
        } catch (error) {
            return false;
        }
    }
}

/**
 * Get singleton instance
 * @param {Object} [options]
 * @returns {MongoEntityStore}
 */
export function getEntityStore(options = {}) {
    return MongoEntityStore.getInstance(options);
}

export default MongoEntityStore;
