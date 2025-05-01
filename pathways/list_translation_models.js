import basePathway from './basePathway.js';
import Bottleneck from 'bottleneck/es5.js';
import { callPathway } from '../lib/pathwayTools.js';
import logger from "../lib/logger.js";

// Create a circuit breaker using Bottleneck for the list_translation_models pathway
const circuitBreaker = new Bottleneck({
    maxConcurrent: 1,  // Allow only one execution at a time
    minTime: 100,      // Minimum time between operations
    reservoir: 50,     // Allow 50 operations per reservoirRefreshInterval
    reservoirRefreshInterval: 60 * 1000, // Refresh every minute
    penalty: 5000,     // Penalize failed jobs by adding 5s delay
    maxRetries: 2      // Maximum number of retries for a job
});

// Create a store for service health status
const serviceHealthStatus = new Map();

// Function to check health of a translation service
async function checkServiceHealth(serviceId) {
    try {
        if (!serviceHealthStatus.has(serviceId)) {
            serviceHealthStatus.set(serviceId, { isHealthy: true, lastChecked: 0, failures: 0 });
        }

        const status = serviceHealthStatus.get(serviceId);
        const now = Date.now();
        
        // Only check every 30 seconds to avoid excessive checks
        if (now - status.lastChecked < 30000 && status.lastChecked > 0) {
            return status.isHealthy;
        }
        
        // Sample text for translation health check
        const testText = "Hello, this is a health check for the translation service.";
        
        // Test if the pathway exists by calling its function with minimal text
        // The serviceId is the GraphQL API pathway name (e.g., translate_azure)
        const healthCheckPromise = new Promise(async (resolve, reject) => {
            try {
                // Each translation service expects specific parameters
                const result = await callPathway(serviceId, {
                    text: testText,
                    from: 'en',  // Source language 
                    to: 'es',    // Target language (Spanish is widely supported)
                    // Setting async to false to get immediate result
                    async: false,
                    // Add minimal instruction to reduce token usage
                    minimalResponse: true,
                });

                // if error in result string, reject
                if (result && typeof result === 'string' && result.includes('error')) {
                    reject(new Error(`Error in response from ${serviceId}`));
                }
                
                // Additional validation to ensure we got a valid response back
                if (result && typeof result === 'string' && result.length > 0) {
                    resolve(true);
                } else {
                    reject(new Error(`Invalid response from ${serviceId}`));
                }
            } catch (err) {
                reject(err);
            }
        });
        
        // Set a timeout to fail health check if it takes too long
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Health check timeout for ${serviceId}`)), 3000);
        });
        
        // Race between actual health check and timeout
        await Promise.race([healthCheckPromise, timeoutPromise]);
        
        // If we get here, it means the service responded successfully within the timeout
        status.isHealthy = true;
        status.failures = 0;
        status.lastChecked = now;
        logger.verbose(`Health check passed for ${serviceId}`);
        return true;
    } catch (error) {
        // Service is not healthy
        const status = serviceHealthStatus.get(serviceId);
        status.failures++;
        
        // If we've failed 3 or more times, mark as unhealthy
        if (status.failures >= 3) {
            status.isHealthy = false;
        }
        
        status.lastChecked = Date.now();
        logger.warn(`Health check failed for ${serviceId}: ${error.message}`);
        return false;
    }
};

// Add circuit breaker events for monitoring
circuitBreaker.on('failed', (error, jobInfo) => {
    logger.warn(`Circuit breaker: Job ${jobInfo.options.id} failed with error: ${error.message}`);
});

circuitBreaker.on('retry', (error, jobInfo) => {
    logger.info(`Circuit breaker: Retrying job ${jobInfo.options.id} after failure: ${error.message}`);
});

circuitBreaker.on('dropped', (dropped) => {
    logger.error(`Circuit breaker: Job was dropped because circuit is overwhelmed. Queue length: ${circuitBreaker.counts().QUEUED}`);
});

// Allow monitoring of the circuit state
setInterval(() => {
    const counts = circuitBreaker.counts();
    if (counts.QUEUED > 5 || counts.RUNNING > 0) {
        logger.debug(`Circuit breaker status: QUEUED=${counts.QUEUED}, RUNNING=${counts.RUNNING}, DONE=${counts.DONE}`);
    }
}, 30000); // Log status every 30 seconds if there's activity

export default {
    ...basePathway,
    name: 'list_translation_models',
    objName: 'TranslationModelList',
    list: true, // indicates this returns an array
    format: 'id name description supportedLanguages status', // defines the fields each model will have, added status field

    resolver: async (parent, args, contextValue, _info) => {
        // Use the circuit breaker to protect this resolver
        return circuitBreaker.schedule(
            { id: 'list_translation_models' }, // Job identifier
            async () => {
                const { config } = contextValue;
                const { _instance } = config;
                const { enabledTranslationModels } = _instance;

                // Map of pathway names to their descriptions
                const modelDescriptions = {
                    'translate': {
                        name: 'Default Translator',
                        description: 'Default translation service using GPT',
                        supportedLanguages: 'All languages supported'
                    },
                    'translate_azure': {
                        name: 'Azure Translator',
                        description: 'Microsoft Azure Translation service',
                        supportedLanguages: 'Over 100 languages supported'
                    },
                    'translate_apptek': {
                        name: 'AppTek Translator',
                        description: 'AppTek specialized translation service',
                        supportedLanguages: 'Selected languages supported'
                    },
                    'translate_gpt4': {
                        name: 'GPT-4 Translator',
                        description: 'High-quality translation using GPT-4',
                        supportedLanguages: 'All languages supported'
                    },
                    'translate_gpt4_turbo': {
                        name: 'GPT-4 Turbo Translator',
                        description: 'Fast, high-quality translation using GPT-4 Turbo',
                        supportedLanguages: 'All languages supported'
                    },
                    'translate_turbo': {
                        name: 'GPT-3.5 Turbo Translator',
                        description: 'Fast translation using GPT-3.5 Turbo',
                        supportedLanguages: 'All languages supported'
                    },
                    'translate_google': {
                        name: 'Google Translator',
                        description: 'Google Cloud Translation service',
                        supportedLanguages: 'Over 100 languages supported'
                    },
                    'translate_groq': {
                        name: 'Groq Llama 4 Scout Translator',
                        description: 'High-performance translation using Groq Llama 4 Scout models',
                        supportedLanguages: 'All major languages supported'
                    }
                };

                // Check health of each enabled model
                const healthPromises = (enabledTranslationModels || [])
                    .filter(modelId => modelDescriptions[modelId])
                    .map(async modelId => {
                        // Don't health check the default translator as it's our fallback
                        const isHealthy = modelId === 'translate' ? true : await checkServiceHealth(modelId);
                        return {
                            modelId,
                            isHealthy,
                            metadata: modelDescriptions[modelId]
                        };
                    });

                // Wait for all health checks to complete
                const healthResults = await Promise.all(healthPromises);
                
                // Filter out unhealthy models and format the response
                const availableModels = healthResults
                    .filter(result => result.isHealthy)
                    .map(result => ({
                        id: result.modelId,
                        ...result.metadata,
                        // Add health status as additional info
                        status: 'operational'
                    }));

                return availableModels;
            }
        ).catch(error => {
            logger.error(`Circuit breaker caught error in list_translation_models: ${error.message}`);

            return [];
        });
    },

    // Minimal input parameters since this is just a listing endpoint
    defaultInputParameters: {
        async: false,
    },

    // Other standard pathway configurations
    useInputChunking: false,
    temperature: 0,
    timeout: 30,
    enableDuplicateRequests: false,
};

// Export a function to reset health status, useful for testing/debugging
export const resetServiceHealth = async () => {
    serviceHealthStatus.clear();
    return { success: true, message: 'Health status cache cleared' };
};
