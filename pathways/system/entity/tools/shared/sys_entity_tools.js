// sys_entity_tools.js
// Shared tool definitions that can be used by any entity
import { config } from '../../../../../config.js';
import logger from '../../../../../lib/logger.js';
import { getEntityStore } from '../../../../../lib/MongoEntityStore.js';

export const CUSTOM_TOOLS = {};
const ALWAYS_VISIBLE_LOCAL_TOOL_KEYS = new Set(['workspacessh']);
const WORKSPACE_SSH_TOOL_KEY = 'workspacessh';

export const toOpenAiToolDefinition = (tool) => {
    const {
        icon,
        pathwayParams,
        silent,
        defaultUserMessage,
        allowResultCompaction,
        ...definitionWithoutExtras
    } = tool.definition;
    return definitionWithoutExtras;
};

const isWorkspaceSshTool = ([toolName, tool]) => {
    const functionName = tool?.definition?.function?.name;
    return toolName.toLowerCase() === WORKSPACE_SSH_TOOL_KEY ||
        (typeof functionName === 'string' && functionName.toLowerCase() === WORKSPACE_SSH_TOOL_KEY);
};

const removeDefaultEntityTools = (tools, entityConfig) => {
    if (!entityConfig?.isDefault) return tools;
    return Object.fromEntries(
        Object.entries(tools).filter((entry) => !isWorkspaceSshTool(entry))
    );
};

// Helper function to get tools for a specific entity
export const getToolsForEntity = (entityConfig) => {
    // Get system tools from config
    const systemTools = config.get('entityTools') || {};

    // Convert all tool names to lowercase in system tools
    const normalizedSystemTools = Object.fromEntries(
        Object.entries(systemTools).map(([key, value]) => [key.toLowerCase(), value])
    );

    // Convert custom tools to lowercase if they exist
    const normalizedCustomTools = entityConfig?.customTools ?
        Object.fromEntries(
            Object.entries(entityConfig.customTools).map(([key, value]) => [key.toLowerCase(), value])
        ) : {};

    // Convert CUSTOM_TOOLS to lowercase
    const normalizedCUSTOM_TOOLS = Object.fromEntries(
        Object.entries(CUSTOM_TOOLS).map(([key, value]) => [key.toLowerCase(), value])
    );

    // Merge system tools with custom tools (custom tools override system tools)
    const allTools = { ...normalizedSystemTools, ...normalizedCustomTools, ...normalizedCUSTOM_TOOLS };

    // If no tools property specified or array contains *, return all tools
    if (!entityConfig?.tools || entityConfig.tools.includes('*')) {
        const entityTools = removeDefaultEntityTools(allTools, entityConfig);
        return {
            entityTools,
            entityToolsOpenAiFormat: Object.values(entityTools).map(toOpenAiToolDefinition)
        };
    }

    // Get the list of tool names for this entity and convert to lowercase for case-insensitive comparison
    const entityToolNames = entityConfig.tools.map(name => name.toLowerCase());

    // Add custom tools to the list of allowed tools if they exist
    if (entityConfig.customTools) {
        Object.keys(entityConfig.customTools).forEach(toolName => {
            if (!entityToolNames.includes(toolName.toLowerCase())) {
                entityToolNames.push(toolName.toLowerCase());
            }
        });
    }

    // Filter the tools to only include those specified for this entity
    const filteredTools = removeDefaultEntityTools(Object.fromEntries(
        Object.entries(allTools).filter(([toolName]) =>
            entityToolNames.includes(toolName.toLowerCase())
        )
    ), entityConfig);

    return {
        entityTools: filteredTools,
        entityToolsOpenAiFormat: Object.values(filteredTools).map(toOpenAiToolDefinition)
    };
};

export const buildLocalToolCatalog = (entityTools = {}) => {
    return Object.fromEntries(
        Object.entries(entityTools).map(([toolKey, tool]) => {
            const toolFunction = tool.definition?.function || {};
            const parameters = Object.keys(toolFunction.parameters?.properties || {});
            return [toolKey, {
                name: toolKey,
                displayName: toolFunction.name || toolKey,
                originalName: toolFunction.name || toolKey,
                server: 'cortex',
                description: toolFunction.description || '',
                parameters,
                source: 'local',
            }];
        })
    );
};

export const getAlwaysVisibleLocalToolDefinitions = (entityTools = {}) => {
    return Object.entries(entityTools)
        .filter(([toolName]) => ALWAYS_VISIBLE_LOCAL_TOOL_KEYS.has(toolName.toLowerCase()))
        .map(([, tool]) => toOpenAiToolDefinition(tool));
};

// Check if an entity has all required environment variables set
const hasRequiredEnvVars = (entity) => {
    if (!entity.requiredEnvVars || entity.requiredEnvVars.length === 0) {
        return true;
    }
    return entity.requiredEnvVars.every(varName => !!process.env[varName]);
};

const buildPersonalEntityDefaults = (userId, defaultEntity = null, personalEntityName = null) => ({
    name: personalEntityName || defaultEntity?.name || 'Jarvis',
    tools: defaultEntity?.tools || ['*'],
    useMemory: defaultEntity?.useMemory ?? true,
    description: defaultEntity?.description || '',
    identity: defaultEntity?.identity || '',
    avatar: defaultEntity?.avatar || null,
    voice: defaultEntity?.voice || null,
    resources: defaultEntity?.resources || [],
    customTools: defaultEntity?.customTools || {},
    assocUserIds: [userId],
    baseModel: defaultEntity?.baseModel || null,
    preferredModel: defaultEntity?.preferredModel || null,
    modelOverride: defaultEntity?.modelOverride || null,
    reasoningEffort: defaultEntity?.reasoningEffort || null,
});

/**
 * Resolve a stale explicit entityId to a canonical entity for the current user.
 * Used by sys_entity_agent to repair replayed entity ids before tools/workspaces run.
 *
 * @param {string} entityId - Explicit entity UUID from the caller
 * @param {Object} [options]
 * @param {string} [options.userId] - User context id for personal entity repair
 * @param {string} [options.personalEntityName] - Preferred personal entity name
 * @returns {Promise<{entityId: string|null, entityConfig: Object|null, repaired: boolean, disabled?: boolean}>}
 */
export const resolveExplicitEntityConfig = async (entityId, options = {}) => {
    const { userId = null, personalEntityName = null } = options;

    try {
        const entityStore = getEntityStore();
        if (!entityStore.isConfigured() || !entityId) {
            return { entityId, entityConfig: null, repaired: false };
        }

        const explicitEntity = await entityStore.getEntity(entityId, { fresh: true });
        if (explicitEntity) {
            if (!hasRequiredEnvVars(explicitEntity)) {
                logger.warn(
                    `Explicit entityId ${entityId} is disabled - preserving disabled entity failure`,
                );
                return { entityId, entityConfig: null, repaired: false, disabled: true };
            }
            return { entityId, entityConfig: explicitEntity, repaired: false };
        }

        if (userId) {
            const defaultEntity = await entityStore.getDefaultEntity();
            const personalEntity = await entityStore.findOrCreatePersonalEntity(
                userId,
                buildPersonalEntityDefaults(userId, defaultEntity, personalEntityName),
            );

            if (personalEntity?.id) {
                const canonicalEntity = await entityStore.getEntity(personalEntity.id, {
                    fresh: true,
                });
                if (canonicalEntity && hasRequiredEnvVars(canonicalEntity)) {
                    logger.warn(
                        `Repairing stale entityId ${entityId} to canonical personal entity ${personalEntity.id} for user ${userId}`,
                    );
                    return {
                        entityId: personalEntity.id,
                        entityConfig: canonicalEntity,
                        repaired: personalEntity.id !== entityId,
                    };
                }
            }
        }

        const defaultEntity = await entityStore.getDefaultEntity();
        if (defaultEntity && hasRequiredEnvVars(defaultEntity)) {
            logger.warn(
                `Falling back from stale entityId ${entityId} to default entity config without binding entityId`,
            );
            return {
                entityId: '',
                entityConfig: defaultEntity,
                repaired: true,
            };
        }

        return { entityId, entityConfig: null, repaired: false };
    } catch (error) {
        logger.error(`Error resolving explicit entity config: ${error.message}`);
        return { entityId, entityConfig: null, repaired: false };
    }
};

/**
 * Load entity configuration from MongoDB (source of truth after boot sync).
 *
 * @param {string} entityId - Entity UUID or name
 * @param {Object} [options]
 * @param {boolean} [options.fresh=false] - Bypass local cache and read fresh from MongoDB
 * @returns {Promise<Object|null>} Entity config or null
 */
export const loadEntityConfig = async (entityId, options = {}) => {
    try {
        const entityStore = getEntityStore();
        if (!entityStore.isConfigured()) {
            logger.warn('MongoDB not configured — cannot load entity');
            return null;
        }

        if (entityId) {
            const entity = await entityStore.getEntity(entityId, options);
            if (entity) {
                if (!hasRequiredEnvVars(entity)) {
                    logger.warn(`Entity ${entityId} is disabled - missing required environment variables`);
                    return null;
                }
                return entity;
            }
        }

        // No specific entity requested (or not found) — return the default
        const defaultEntity = await entityStore.getDefaultEntity();
        return defaultEntity || null;
    } catch (error) {
        logger.error(`Error loading entity config: ${error.message}`);
        return null;
    }
};

/**
 * Fetches the list of available entities with their descriptions and active tools.
 * Reads from MongoDB only (source of truth after boot sync).
 *
 * @param {Object} [options]
 * @param {string} [options.userId] - Filter to entities for this user
 * @param {boolean} [options.fresh=false] - Bypass local cache and read fresh from MongoDB
 * @returns {Promise<Array>} Array of objects containing entity information and their active tools
 */
export const getAvailableEntities = async (options = {}) => {
    try {
        const entityStore = getEntityStore();
        if (!entityStore.isConfigured()) {
            logger.warn('MongoDB not configured — cannot list entities');
            return [];
        }

        const mongoEntities = await entityStore.getAllEntities(options);
        return mongoEntities
            .filter(entity => hasRequiredEnvVars(entity))
            .map(entity => {
                const { entityTools } = getToolsForEntity(entity);
                return {
                    id: entity.id,
                    name: entity.name || entity.id,
                    description: entity.description || '',
                    isDefault: entity.isDefault || false,
                    activeTools: Object.keys(entityTools).map(toolName => ({
                        name: toolName,
                        description: entityTools[toolName].definition?.function?.description || ''
                    })),
                    secretKeys: entity.secrets ? Object.keys(entity.secrets) : [],
                    reasoningEffort: entity.reasoningEffort || null,
                };
            });
    } catch (error) {
        logger.error(`Error fetching available entities: ${error.message}`);
        return [];
    }
};
