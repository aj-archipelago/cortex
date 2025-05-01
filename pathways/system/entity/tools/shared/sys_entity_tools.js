// sys_entity_tools.js
// Shared tool definitions that can be used by any entity
import { config } from '../../../../../config.js';
import logger from '../../../../../lib/logger.js';

export const CUSTOM_TOOLS = {};

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
        return {
            entityTools: allTools,
            entityToolsOpenAiFormat: Object.values(allTools).map(tool => {
                const { icon, pathwayParams, ...definitionWithoutExtras } = tool.definition;
                return definitionWithoutExtras;
            })
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
    const filteredTools = Object.fromEntries(
        Object.entries(allTools).filter(([toolName]) => 
            entityToolNames.includes(toolName.toLowerCase())
        )
    );

    return {
        entityTools: filteredTools,
        entityToolsOpenAiFormat: Object.values(filteredTools).map(tool => {
            const { icon, pathwayParams, ...definitionWithoutExtras } = tool.definition;
            return definitionWithoutExtras;
        })
    };
};

// Load entity configurations
export const loadEntityConfig = (entityId) => {
    try {
        entityId = entityId.toLowerCase();
        
        const entityConfig = config.get('entityConfig');
        if (!entityConfig) {
            logger.warn('No entity config found in config');
            return null;
        }

        // Handle both array and object formats
        const configArray = Array.isArray(entityConfig) ? entityConfig : Object.entries(entityConfig).map(([id, config]) => ({
            id,
            ...config
        }));

        // If entityId is provided, look for that specific entity
        if (entityId) {
            const entity = configArray.find(e => e.id === entityId);
            if (entity) {
                return entity;
            }
            logger.warn(`Entity ${entityId} not found in config`);
        }

        // If no entityId or entity not found, look for default entity
        const defaultEntity = configArray.find(e => e.isDefault === true);
        if (defaultEntity) {
            return defaultEntity;
        }

        // If no default entity found, return the first entity
        if (configArray.length > 0) {
            return configArray[0];
        }

        return null;
    } catch (error) {
        logger.error(`Error loading entity config: ${error.message}`);
        return null;
    }
};

/**
 * Fetches the list of available entities with their descriptions and active tools
 * @returns {Array} Array of objects containing entity information and their active tools
 */
export const getAvailableEntities = () => {
    try {
        const entityConfig = config.get('entityConfig');
        if (!entityConfig) {
            logger.warn('No entity config found in config');
            return [];
        }

        // Handle both array and object formats
        const configArray = Array.isArray(entityConfig) ? entityConfig : Object.entries(entityConfig).map(([id, config]) => ({
            id,
            ...config
        }));

        return configArray.map(entity => {
            const { entityTools } = getToolsForEntity(entity);
            return {
                id: entity.id,
                name: entity.name || entity.id,
                description: entity.description || '',
                isDefault: entity.isDefault || false,
                activeTools: Object.keys(entityTools).map(toolName => ({
                    name: toolName,
                    description: entityTools[toolName].definition?.function?.description || ''
                }))
            };
        });
    } catch (error) {
        logger.error(`Error fetching available entities: ${error.message}`);
        return [];
    }
};
