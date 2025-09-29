// graphql.js
// Setup the Apollo server and Express middleware

import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { makeExecutableSchema } from '@graphql-tools/schema';
import express from 'express';
import { useServer } from 'graphql-ws/lib/use/ws';
import http from 'http';
import Keyv from 'keyv';
import { WebSocketServer } from 'ws';
// eslint-disable-next-line import/no-extraneous-dependencies
import responseCachePlugin from '@apollo/server-plugin-response-cache';
import { KeyvAdapter } from '@apollo/utils.keyvadapter';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { buildModels, buildPathways } from '../config.js';
import logger from '../lib/logger.js';
import { buildModelEndpoints } from '../lib/requestExecutor.js';
import { startTestServer } from '../tests/helpers/server.js';
import { requestState } from './requestState.js';
import { cancelRequestResolver } from './resolver.js';
import subscriptions from './subscriptions.js';
import { getMessageTypeDefs, getPathwayTypeDef, userPathwayInputParameters } from './typeDef.js';
import { buildRestEndpoints } from './rest.js';
import { callPathway } from '../lib/pathwayTools.js';

// Utility functions
// Server plugins
const getPlugins = (config) => {
    const plugins = [
        ApolloServerPluginLandingPageLocalDefault({ embed: true }), // For local development.   
    ];

    //if cache is enabled and Redis is available, use it
    let cache;
    if (config.get('enableGraphqlCache') && config.get('storageConnectionString')) {
        cache = new KeyvAdapter(new Keyv(config.get('storageConnectionString'), {
            ssl: true,
            abortConnect: false,
        }));
        //caching similar strings, embedding hashing, ... #delta similarity 
        // TODO: custom cache key:
        // https://www.apollographql.com/docs/apollo-server/performance/cache-backends#implementing-your-own-cache-backend
        plugins.push(responseCachePlugin({ cache }));
        logger.info('Using Redis for GraphQL cache');
    }

    return { plugins, cache };
}

// Type Definitions for GraphQL
const getTypedefs = (pathways, pathwayManager) => {
    const defaultTypeDefs = `#graphql
    ${getMessageTypeDefs()}

    enum CacheControlScope {
        PUBLIC
        PRIVATE
    }

    directive @cacheControl(
        maxAge: Int
        scope: CacheControlScope
        inheritMaxAge: Boolean
    ) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION

    type Query {
        _ : Boolean
    }

    type Mutation {
        cancelRequest(requestId: String!): Boolean
    }

    ${getPathwayTypeDef('ExecuteWorkspace', 'String')}
    
    type ExecuteWorkspaceResult {
        debug: String
        result: String
        resultData: String
        previousResult: String
        warnings: [String]
        errors: [String]
        contextId: String
        tool: String
    }
    
    extend type Query {
        executeWorkspace(userId: String!, pathwayName: String!, ${userPathwayInputParameters}): ExecuteWorkspaceResult
    }

    type RequestSubscription {
        requestId: String
        progress: Float
        status: String
        data: String
        info: String
        error: String
    }

    type Subscription {
        requestProgress(requestIds: [String!]): RequestSubscription
    }
`;

    const pathwayManagerTypeDefs = pathwayManager?.getTypeDefs() || '';
    const pathwayTypeDefs = Object.values(pathways)
        .filter(p => !p.disabled)
        .map(p => p.typeDef(p).gqlDefinition);

    const typeDefs = [defaultTypeDefs, pathwayManagerTypeDefs, ...pathwayTypeDefs];
    return typeDefs.join('\n');
}


// Resolvers for GraphQL
const getResolvers = (config, pathways, pathwayManager) => {
    const resolverFunctions = {};
    for (const [name, pathway] of Object.entries(pathways)) {
        if (pathway.disabled) continue;
        resolverFunctions[name] = (parent, args, contextValue, info) => {
            // add shared state to contextValue
            contextValue.pathway = pathway;
            contextValue.config = config;
            return pathway.rootResolver(parent, args, contextValue, info);
        }
    }

    const pathwayManagerResolvers = pathwayManager?.getResolvers() || {};

    // Helper function to resolve file hashes and add them to chatHistory
    const resolveAndAddFileContent = async (pathways, pathwayArgs, requestId, config) => {
        let fileContentAdded = false;
        
        // Check if any pathway has file hashes
        const pathwaysWithFiles = Array.isArray(pathways) ? pathways : [pathways];
        
        for (const pathway of pathwaysWithFiles) {
            if (pathway.fileHashes && pathway.fileHashes.length > 0) {
                try {
                    const { resolveFileHashesToContent } = await import('../lib/util.js');
                    const fileContent = await resolveFileHashesToContent(pathway.fileHashes, config);
                    
                    // Add file content to chatHistory if not already present (only do this once)
                    if (!fileContentAdded) {
                        // Initialize chatHistory if it doesn't exist
                        if (!pathwayArgs.chatHistory) {
                            pathwayArgs.chatHistory = [];
                        }
                        
                        // Find the last user message or create one
                        let lastUserMessage = null;
                        for (let i = pathwayArgs.chatHistory.length - 1; i >= 0; i--) {
                            if (pathwayArgs.chatHistory[i].role === 'user') {
                                lastUserMessage = pathwayArgs.chatHistory[i];
                                break;
                            }
                        }
                        
                        if (!lastUserMessage) {
                            lastUserMessage = {
                                role: 'user',
                                content: []
                            };
                            pathwayArgs.chatHistory.push(lastUserMessage);
                        }
                        
                        // Ensure content is an array
                        if (!Array.isArray(lastUserMessage.content)) {
                            lastUserMessage.content = [
                                JSON.stringify({
                                    type: "text",
                                    text: lastUserMessage.content || ""
                                })
                            ];
                        }
                        
                        // Add file content
                        lastUserMessage.content.push(...fileContent);
                        fileContentAdded = true;
                    }
                } catch (error) {
                    logger.error(`[${requestId}] Failed to resolve file hashes for pathway ${pathway.name || 'unnamed'}: ${error.message}`);
                    // Continue execution without files
                }
                
                // Only process files once for multiple pathways
                if (fileContentAdded) break;
            }
        }
        
        return fileContentAdded;
    };

    // Helper function to execute pathway with cortex pathway name or fallback to legacy
    const executePathwayWithFallback = async (pathway, pathwayArgs, contextValue, info, requestId, originalPrompt = null) => {
        const cortexPathwayName = (originalPrompt && typeof originalPrompt === 'object' && originalPrompt.cortexPathwayName) 
            ? originalPrompt.cortexPathwayName 
            : null;
        
        if (cortexPathwayName) {
            // Use the specific cortex pathway
            // Transform parameters for cortex pathway
            const cortexArgs = {
                model: pathway.model || pathwayArgs.model || "labeeb-agent", // Use pathway model or default
                chatHistory: [],
                systemPrompt: pathway.systemPrompt
            };
            
            // If we have existing chatHistory, use it as base
            if (pathwayArgs.chatHistory && pathwayArgs.chatHistory.length > 0) {
                cortexArgs.chatHistory = JSON.parse(JSON.stringify(pathwayArgs.chatHistory));
            }
            
            // If we have text parameter, we need to add it to the chatHistory
            if (pathwayArgs.text) {
                // Find the last user message or create a new one
                let lastUserMessage = null;
                for (let i = cortexArgs.chatHistory.length - 1; i >= 0; i--) {
                    if (cortexArgs.chatHistory[i].role === 'user') {
                        lastUserMessage = cortexArgs.chatHistory[i];
                        break;
                    }
                }
                
                if (lastUserMessage) {
                    // Ensure content is an array
                    if (!Array.isArray(lastUserMessage.content)) {
                        lastUserMessage.content = [JSON.stringify({
                            type: "text",
                            text: lastUserMessage.content || ""
                        })];
                    }
                    
                    // Add the text parameter as a text content item
                    const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
                    lastUserMessage.content.unshift(JSON.stringify({
                        type: "text",
                        text: `${pathwayArgs.text}\n\n${textFromPrompt}`
                    }));
                } else {
                    // Create new user message with text
                    const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
                    cortexArgs.chatHistory.push({
                        role: 'user',
                        content: [JSON.stringify({
                            type: "text",
                            text: `${pathwayArgs.text}\n\n${textFromPrompt}`
                        })]
                    });
                }
            }
            
            const result = await callPathway(cortexPathwayName, cortexArgs);
            
            // Wrap the result to match expected format
            return { result };
        } else {
            // Fallback to original pathway execution for legacy prompts
            const pathwayContext = { ...contextValue, pathway };
            return await pathway.rootResolver(null, pathwayArgs, pathwayContext, info);
        }
    };

    const executeWorkspaceResolver = async (_, args, contextValue, info) => {
        const startTime = Date.now();
        const requestId = uuidv4();
        const { userId, pathwayName, promptNames, ...pathwayArgs } = args;
        
        logger.info(`>>> [${requestId}] executeWorkspace started - userId: ${userId}, pathwayName: ${pathwayName}, promptNames: ${promptNames?.join(',') || 'none'}`);
        
        try {
            contextValue.config = config;
            
            // Get the base pathway from the user
            const pathways = await pathwayManager.getLatestPathways();
            
            if (!pathways[userId] || !pathways[userId][pathwayName]) {
                const error = new Error(`Pathway '${pathwayName}' not found for user '${userId}'`);
                logger.error(`!!! [${requestId}] ${error.message} - Available users: ${Object.keys(pathways).join(', ')}`);
                throw error;
            }

            const basePathway = pathways[userId][pathwayName];
            
            // If promptNames is specified, use getPathways to get individual pathways and execute in parallel
            if (promptNames && promptNames.length > 0) {
                
                // Check if the prompts are in legacy format (array of strings)
                // If so, we can't use promptNames filtering and need to ask user to republish
                if (pathwayManager.isLegacyPromptFormat(userId, pathwayName)) {
                    const error = new Error(
                        `The pathway '${pathwayName}' uses legacy prompt format (array of strings) which doesn't support the promptNames parameter. ` +
                        `Please unpublish and republish your workspace to upgrade to the new format that supports named prompts.`
                    );
                    logger.error(`!!! [${requestId}] ${error.message}`);
                    throw error;
                }
                
                // Handle wildcard case - execute all prompts in parallel
                if (promptNames.includes('*')) {
                    logger.info(`[${requestId}] Executing all prompts in parallel (wildcard specified)`);
                    const individualPathways = await pathwayManager.getPathways(basePathway);
                    
                    if (individualPathways.length === 0) {
                        const error = new Error(`No prompts found in pathway '${pathwayName}'`);
                        logger.error(`!!! [${requestId}] ${error.message}`);
                        throw error;
                    }
                    
                    // Resolve file content for any pathways that have file hashes
                    await resolveAndAddFileContent(individualPathways, pathwayArgs, requestId, config);
                    
                    // Execute all pathways in parallel
                    const results = await Promise.all(
                        individualPathways.map(async (pathway, index) => {
                            try {
                                // Check if the prompt has a cortexPathwayName (new format)
                                const originalPrompt = basePathway.prompt[index];
                                
                                const result = await executePathwayWithFallback(pathway, pathwayArgs, contextValue, info, requestId, originalPrompt);
                                
                                return {
                                    result: result.result,
                                    promptName: pathway.name || `prompt_${index + 1}`
                                };
                            } catch (error) {
                                logger.error(`!!! [${requestId}] Error in pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'} - ${error.message}`);
                                throw error;
                            }
                        })
                    );
                    
                    const duration = Date.now() - startTime;
                    logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned ${results.length} results`);
                    
                    // Return a single result with JSON stringified array of results
                    return {
                        debug: `Executed ${results.length} prompts in parallel`,
                        result: JSON.stringify(results),
                        resultData: null,
                        previousResult: null,
                        warnings: [],
                        errors: [],
                        contextId: requestId,
                        tool: 'executeWorkspace'
                    };
                } else {
                    // Handle specific prompt names
                    logger.info(`[${requestId}] Executing specific prompts: ${promptNames.join(', ')}`);
                    const individualPathways = await pathwayManager.getPathways(basePathway, promptNames);
                    
                    if (individualPathways.length === 0) {
                        const error = new Error(`No prompts found matching the specified names: ${promptNames.join(', ')}`);
                        logger.error(`!!! [${requestId}] ${error.message}`);
                        throw error;
                    }
                    
                    // Resolve file content for any pathways that have file hashes
                    await resolveAndAddFileContent(individualPathways, pathwayArgs, requestId, config);
                    
                    // Execute all pathways in parallel
                    const results = await Promise.all(
                        individualPathways.map(async (pathway, index) => {
                            try {
                                // Find the original prompt by name to get the cortexPathwayName
                                const originalPrompt = basePathway.prompt.find(p => 
                                    (typeof p === 'object' && p.name === pathway.name) ||
                                    (typeof p === 'string' && pathway.name === `prompt_${basePathway.prompt.indexOf(p)}`)
                                );
                                
                                const result = await executePathwayWithFallback(pathway, pathwayArgs, contextValue, info, requestId, originalPrompt);
                                
                                return {
                                    result: result.result,
                                    promptName: pathway.name || `prompt_${index + 1}`
                                };
                            } catch (error) {
                                logger.error(`!!! [${requestId}] Error in pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'} - ${error.message}`);
                                throw error;
                            }
                        })
                    );
                    
                    const duration = Date.now() - startTime;
                    logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned ${results.length} results`);
                    
                    // Return a single result with JSON stringified array of results (consistent with wildcard case)
                    return {
                        debug: `Executed ${results.length} specific prompts in parallel: ${promptNames.join(', ')}`,
                        result: JSON.stringify(results),
                        resultData: null,
                        previousResult: null,
                        warnings: [],
                        errors: [],
                        contextId: requestId,
                        tool: 'executeWorkspace'
                    };
                }
            }
            
            // Default behavior: execute all prompts in sequence
            logger.info(`[${requestId}] Executing prompts in sequence`);
            const userPathway = await pathwayManager.getPathway(userId, pathwayName);
            contextValue.pathway = userPathway;
            
            // Handle file hashes if present in the pathway
            await resolveAndAddFileContent(userPathway, pathwayArgs, requestId, config);
            
            // Check if any prompt has cortexPathwayName (for dynamic pathways)
            let result;
            if (userPathway.prompt && Array.isArray(userPathway.prompt)) {
                const firstPrompt = userPathway.prompt[0];
                
                result = await executePathwayWithFallback(userPathway, pathwayArgs, contextValue, info, requestId, firstPrompt);
            } else {
                // No prompt array, use legacy execution
                result = await userPathway.rootResolver(null, pathwayArgs, contextValue, info);
            }
            const duration = Date.now() - startTime;
            logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned 1 result`);
            return result; // Return single result directly
            
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`!!! [${requestId}] executeWorkspace failed after ${duration}ms`);
            logger.error(`!!! [${requestId}] Error type: ${error.constructor.name}`);
            logger.error(`!!! [${requestId}] Error message: ${error.message}`);
            logger.error(`!!! [${requestId}] Error stack: ${error.stack}`);
            
            // Log additional context for debugging "memory access out of bounds" errors
            if (error.message && error.message.includes('memory')) {
                logger.error(`!!! [${requestId}] MEMORY ERROR DETECTED - Additional context:`);
                logger.error(`!!! [${requestId}] - Node.js version: ${process.version}`);
                logger.error(`!!! [${requestId}] - Memory usage: ${JSON.stringify(process.memoryUsage())}`);
                logger.error(`!!! [${requestId}] - Args size estimate: ${JSON.stringify(args).length} chars`);
                logger.error(`!!! [${requestId}] - PathwayArgs keys: ${Object.keys(pathwayArgs).join(', ')}`);
            }
            
            throw error;
        }
    };

    const resolvers = {
        Query: {
            ...resolverFunctions,
            executeWorkspace: executeWorkspaceResolver
        },
        Mutation: {
            'cancelRequest': cancelRequestResolver,
            ...pathwayManagerResolvers.Mutation
        },
        Subscription: subscriptions,
    }

    return resolvers;
}

// Build the server including the GraphQL schema and REST endpoints
const build = async (config) => {
    // First perform config build
    const { pathwayManager } = await buildPathways(config);
    buildModels(config);

    // build model API endpoints and limiters
    buildModelEndpoints(config);

    //build api
    const pathways = config.get('pathways');

    const typeDefs = getTypedefs(pathways, pathwayManager);
    const resolvers = getResolvers(config, pathways, pathwayManager);
    const schema = makeExecutableSchema({ typeDefs, resolvers });

    const { plugins, cache } = getPlugins(config);

    const app = express();

    app.use(express.json({ limit: '200mb' }));

    const httpServer = http.createServer(app);

    // Creating the WebSocket server
    const wsServer = new WebSocketServer({
        // This is the `httpServer` we created in a previous step.
        server: httpServer,
        // Pass a different path here if your ApolloServer serves at
        // a different path.
        path: '/graphql',
    });

    // Hand in the schema we just created and have the
    // WebSocketServer start listening.
    // Respects the keep alive setting in config in case you want to
    // turn it off for deployments that don't route the ping/pong frames
    const keepAlive = config.get('subscriptionKeepAlive');
    logger.info(`Starting web socket server with subscription keep alive: ${keepAlive}`);
    const serverCleanup = useServer({ schema }, wsServer, keepAlive);

    const server = new ApolloServer({
        schema: schema,
        introspection: config.get('env') === 'development',
        csrfPrevention: true,
        plugins: plugins.concat([// Proper shutdown for the HTTP server.
            ApolloServerPluginDrainHttpServer({ httpServer }),

            // Proper shutdown for the WebSocket server.
            {
                async serverWillStart() {
                    return {
                        async drainServer() {
                            await serverCleanup.dispose();
                        },
                    };
                },
            }
        ]),
    });

    // Healthcheck endpoint is valid regardless of auth
    app.get('/healthcheck', (req, res) => {
        res.status(200).send('OK');
    });

    // If CORTEX_API_KEY is set, we roll our own auth middleware - usually not used if you're being fronted by a proxy
    const cortexApiKeys = config.get('cortexApiKeys');
    if (cortexApiKeys && Array.isArray(cortexApiKeys)) {
        app.use((req, res, next) => {
            let providedApiKey = req.headers['cortex-api-key'] || req.query['cortex-api-key'];
            if (!providedApiKey) {
                providedApiKey = req.headers['authorization'];
                providedApiKey = providedApiKey?.startsWith('Bearer ') ? providedApiKey.slice(7) : providedApiKey;
            }

            if (!cortexApiKeys.includes(providedApiKey)) {
                if (req.baseUrl === '/graphql' || req.headers['content-type'] === 'application/graphql') {
                    res.status(401)
                        .set('WWW-Authenticate', 'Cortex-Api-Key')
                        .set('X-Cortex-Api-Key-Info', 'Server requires Cortex API Key')
                        .json({
                            errors: [
                                {
                                    message: 'Unauthorized',
                                    extensions: {
                                        code: 'UNAUTHENTICATED',
                                    },
                                },
                            ],
                        });
                } else {
                    res.status(401)
                        .set('WWW-Authenticate', 'Cortex-Api-Key')
                        .set('X-Cortex-Api-Key-Info', 'Server requires Cortex API Key')
                        .send('Unauthorized');
                }
            } else {
                next();
            }
        });
    }

    // Parse the body for REST endpoints
    app.use(express.json());

    // Server Startup Function
    const startServer = async () => {
        // Start only the main server
        await server.start();

        app.use(
            '/graphql',
            cors(),
            expressMiddleware(server, {
                context: async ({ req, res }) => ({ req, res, config, requestState }),
            }),
        );

        // add the REST endpoints
        buildRestEndpoints(pathways, app, server, config);

        // Now that our HTTP server is fully set up, we can listen to it.
        httpServer.listen(config.get('PORT'), () => {
            logger.info(`🚀 Server is now running at http://localhost:${config.get('PORT')}/graphql`);
        });
    };

    return { server, startServer, startTestServer, cache, plugins, typeDefs, resolvers }
}


export {
    build,
    getResolvers
};

