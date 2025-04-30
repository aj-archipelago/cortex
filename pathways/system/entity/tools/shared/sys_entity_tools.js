// sys_entity_tools.js
// Shared tool definitions that can be used by any entity
import { config } from '../../../../../config.js';
import logger from '../../../../../lib/logger.js';

export const CUSTOM_TOOLS = {
    code: {
        definition: {
            type: "function",
            function: {
                name: "Code",
                description: "Engage for any programming-related tasks, including creating, modifying, reviewing, or explaining code.",
                parameters: {
                    type: "object",
                    properties: {
                        detailedInstructions: {
                            type: "string",
                            description: "Detailed instructions about what you need the tool to do"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["detailedInstructions", "userMessage"]
                }
            }
        },
        pathwayName: "sys_generator_expert"
    },
    codeExecution: {
        definition: {
            type: "function",
            function: {
                name: "CodeExecution",
                description: "Use when explicitly asked to run or execute code, or when a coding agent is needed to perform specific tasks.",
                parameters: {
                    type: "object",
                    properties: {
                        detailedInstructions: {
                            type: "string",
                            description: "Detailed instructions about what you need the tool to do"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["detailedInstructions", "userMessage"]
                }
            }
        },
        pathwayName: "sys_entity_code_execution"
    }
};

// Helper function to get tools for a specific entity
export const getToolsForEntity = (entityConfig) => {
    // Get system tools from config
    const systemTools = config.get('entityTools') || {};
    
    // Merge system tools with custom tools (custom tools override system tools)
    const allTools = { ...systemTools, ...CUSTOM_TOOLS };
    
    // If no tools specified or empty array, return all tools
    if (!entityConfig?.tools || entityConfig.tools.length === 0) {
        return {
            entityTools: allTools,
            entityToolsOpenAiFormat: Object.values(allTools).map(tool => {
                const { icon, ...definitionWithoutIcon } = tool.definition;
                return definitionWithoutIcon;
            })
        };
    }

    // Get the list of tool names for this entity and convert to lowercase for case-insensitive comparison
    const entityToolNames = entityConfig.tools.map(name => name.toLowerCase());
    
    // Filter the tools to only include those specified for this entity
    const filteredTools = Object.fromEntries(
        Object.entries(allTools).filter(([toolName]) => 
            entityToolNames.includes(toolName.toLowerCase())
        )
    );

    return {
        entityTools: filteredTools,
        entityToolsOpenAiFormat: Object.values(filteredTools).map(tool => {
            const { icon, ...definitionWithoutIcon } = tool.definition;
            return definitionWithoutIcon;
        })
    };
};

// Load entity configurations
export const loadEntityConfig = (entityId) => {
    try {
        const entityConfig = config.get('entityConfig');
        if (!entityConfig) {
            logger.warn('No entity config found in config');
            return null;
        }

        // Handle both array and object formats
        const configArray = Array.isArray(entityConfig) ? entityConfig : Object.values(entityConfig);

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
