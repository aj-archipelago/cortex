// sys_entity_tools.js
// Shared tool definitions that can be used by any entity
import { config } from '../../../../../config.js';
import logger from '../../../../../lib/logger.js';

export const CUSTOM_TOOLS = {
    plan: {
        definition: {
            type: "function",
            function: {
                name: "Plan",
                description: "Use specifically to create a thorough, well thought out plan to accomplish a task. You should always use this tool when you're planning to do something complex or something that might require multiple steps.",
                parameters: {
                    type: "object",
                    properties: {
                        detailedInstructions: {
                            type: "string",
                            description: "Detailed instructions about what you need the tool to do"
                        }
                    },
                    required: ["detailedInstructions"]
                }
            }
        },
        pathwayName: "sys_generator_reasoning"
    },
    document: {
        definition: {
            type: "function",
            function: {
                name: "Document",
                description: "Access user's personal document index. Use for user-specific uploaded information.",
                parameters: {
                    type: "object",
                    properties: {
                        detailedInstructions: {
                            type: "string",
                            description: "Detailed instructions about what you need the tool to do"
                        }
                    },
                    required: ["detailedInstructions"]
                }
            }
        },
        pathwayName: "sys_generator_results"
    },
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
                        }
                    },
                    required: ["detailedInstructions"]
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
                        }
                    },
                    required: ["detailedInstructions"]
                }
            }
        },
        pathwayName: "sys_entity_code_execution"
    },
    reason: {
        definition: {
            type: "function",
            function: {
                name: "Reason",
                description: "Employ for reasoning, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices.",
                parameters: {
                    type: "object",
                    properties: {
                        detailedInstructions: {
                            type: "string",
                            description: "Detailed instructions about what you need the tool to do"
                        }
                    },
                    required: ["detailedInstructions"]
                }
            }
        },
        pathwayName: "sys_generator_reasoning"
    }
};

// Helper function to get tools for a specific entity
export const getToolsForEntity = (entityId) => {
    // Get system tools from config
    const systemTools = config.get('entityTools') || {};
    
    // Merge system tools with custom tools (custom tools override system tools)
    const allTools = { ...systemTools, ...CUSTOM_TOOLS };

    // Get entity config from config
    const entityConfig = config.get('entityConfig');
    
    // If no tools specified or empty array, return all tools
    if (!entityConfig?.tools || entityConfig.tools.length === 0) {
        return {
            tools: allTools,
            openAiTools: Object.values(allTools).map(tool => tool.definition)
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
        tools: filteredTools,
        openAiTools: Object.values(filteredTools).map(tool => tool.definition)
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

        // If entityId is provided, look for that specific entity
        if (entityId) {
            const entity = entityConfig.find(e => e.id === entityId);
            if (entity) {
                return entity;
            }
            logger.warn(`Entity ${entityId} not found in config`);
        }

        // If no entityId or entity not found, look for default entity
        const defaultEntity = entityConfig.find(e => e.isDefault === true);
        if (defaultEntity) {
            return defaultEntity;
        }

        // If no default entity found, return the first entity
        if (entityConfig.length > 0) {
            return entityConfig[0];
        }

        return null;
    } catch (error) {
        logger.error(`Error loading entity config: ${error.message}`);
        return null;
    }
};
