// pathways/system/entity/utils.js
// Utility functions for handling entity configurations

import fs from 'fs';
import path from 'path';
import logger from '../../../lib/logger.js';
import { config as appConfig } from '../../../config.js'; // Import the main config object
import { entityConfig as defaultConfig } from './config.js'; // Import the default entity configuration

// --- Helper Function to Load Configuration ---

function loadActualEntityConfig() {
    const configPath = appConfig.get('entityConfigPath'); // Get path from main config

    if (configPath) {
        const resolvedPath = path.resolve(configPath);
        logger.info(`Attempting to load entity config from configured path: ${resolvedPath}`);
        try {
            if (fs.existsSync(resolvedPath)) {
                const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
                const customConfig = JSON.parse(fileContent);
                // Basic validation: Check if it's an object
                if (typeof customConfig === 'object' && customConfig !== null) {
                    logger.info(`Successfully loaded entity config from ${resolvedPath}`);
                    return customConfig;
                } else {
                    logger.error(`Invalid configuration format in ${resolvedPath}. Expected a JSON object. Falling back to default config.`);
                }
            } else {
                logger.warn(`Entity config file specified by config 'entityConfigPath' not found: ${resolvedPath}. Falling back to default config.`);
            }
        } catch (error) {
            if (error instanceof SyntaxError) {
                logger.error(`Failed to parse JSON from entity config file ${resolvedPath}: ${error.message}. Falling back to default config.`);
            } else {
                logger.error(`Failed to read entity config file ${resolvedPath}: ${error.message}. Falling back to default config.`);
            }
        }
    } else {
        logger.info(`'entityConfigPath' not set in config. Using default entity config from ./config.js`);
    }

    // Fallback to default config
    return defaultConfig;
}

// Load the configuration once when the module is loaded
const loadedEntityConfig = loadActualEntityConfig();

// --- Main Exported Function ---

/**
 * Retrieves the configuration for a given entity name from the loaded config.
 * Falls back to the entity marked as default if the specified name is not found
 * or if no name is provided.
 * @param {string} [entityName] - The name of the entity (case-insensitive).
 * @returns {object} The configuration object for the entity.
 * @throws {Error} If no entity configuration is found (including no default).
 */
export function getEntityConfig(entityName) {
    const lowerEntityName = entityName?.toLowerCase();

    // Ensure loadedEntityConfig is an object before proceeding
    if (typeof loadedEntityConfig !== 'object' || loadedEntityConfig === null) {
        throw new Error('Loaded entity configuration is invalid or null. Cannot retrieve entity config.');
    }

    // Use the loaded config (either default or from configured path)
    const config = loadedEntityConfig[lowerEntityName] || Object.values(loadedEntityConfig).find(e => e && e.default);

    if (!config) {
        // Find the default name from the loaded config for the error message
        const defaultEntry = Object.entries(loadedEntityConfig).find(([, e]) => e && e.default);
        const defaultName = defaultEntry ? defaultEntry[0] : null;

        const errorMsg = defaultName
            ? `No configuration found for entity "${entityName}" in the loaded config. Default entity "${defaultName}" exists but might be misconfigured or not found during fallback.`
            : `No configuration found for entity "${entityName}" in the loaded config and no default entity is defined.`
        throw new Error(errorMsg);
    }
    // Return a deep copy to prevent accidental modification of the original config
    return JSON.parse(JSON.stringify(config));
}
