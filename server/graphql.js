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
    
    union ExecuteWorkspaceResponse = ExecuteWorkspace | ExecuteWorkspaceResult
    
    extend type Query {
        executeWorkspace(userId: String!, pathwayName: String!, ${userPathwayInputParameters}): [ExecuteWorkspaceResult]
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
            logger.debug(`[${requestId}] Found pathway: ${pathwayName} for user: ${userId}`);
            
            // If promptNames is specified, use getPathways to get individual pathways and execute in parallel
            if (promptNames && promptNames.length > 0) {
                // Handle wildcard case - execute all prompts in parallel
                if (promptNames.includes('*')) {
                    logger.info(`[${requestId}] Executing all prompts in parallel (wildcard specified)`);
                    const individualPathways = await pathwayManager.getPathways(basePathway);
                    
                    if (individualPathways.length === 0) {
                        const error = new Error(`No prompts found in pathway '${pathwayName}'`);
                        logger.error(`!!! [${requestId}] ${error.message}`);
                        throw error;
                    }
                    
                    // Execute all pathways in parallel
                    logger.debug(`[${requestId}] Executing ${individualPathways.length} pathways in parallel`);
                    const results = await Promise.all(
                        individualPathways.map(async (pathway, index) => {
                            try {
                                logger.debug(`[${requestId}] Starting pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'}`);
                                const pathwayContext = { ...contextValue, pathway };
                                const result = await pathway.rootResolver(null, pathwayArgs, pathwayContext, info);
                                logger.debug(`[${requestId}] Completed pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'}`);
                                return {
                                    result: result.result,
                                    promptName: pathway.name || `prompt_${index + 1}`
                                };
                            } catch (error) {
                                logger.error(`!!! [${requestId}] Error in pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'} - ${error.message}`);
                                logger.debug(`[${requestId}] Error stack: ${error.stack}`);
                                throw error;
                            }
                        })
                    );
                    
                    const duration = Date.now() - startTime;
                    logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned ${results.length} results`);
                    
                    // Return a single result with JSON stringified array of results
                    return [{
                        debug: `Executed ${results.length} prompts in parallel`,
                        result: JSON.stringify(results),
                        resultData: null,
                        previousResult: null,
                        warnings: [],
                        errors: [],
                        contextId: requestId,
                        tool: 'executeWorkspace'
                    }];
                } else {
                    // Handle specific prompt names
                    logger.info(`[${requestId}] Executing specific prompts: ${promptNames.join(', ')}`);
                    const individualPathways = await pathwayManager.getPathways(basePathway, promptNames);
                    
                    if (individualPathways.length === 0) {
                        const error = new Error(`No prompts found matching the specified names: ${promptNames.join(', ')}`);
                        logger.error(`!!! [${requestId}] ${error.message}`);
                        throw error;
                    }
                    
                    // Execute all pathways in parallel
                    logger.debug(`[${requestId}] Executing ${individualPathways.length} pathways in parallel`);
                    const results = await Promise.all(
                        individualPathways.map(async (pathway, index) => {
                            try {
                                logger.debug(`[${requestId}] Starting pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'}`);
                                const pathwayContext = { ...contextValue, pathway };
                                const result = await pathway.rootResolver(null, pathwayArgs, pathwayContext, info);
                                logger.debug(`[${requestId}] Completed pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'}`);
                                return result;
                            } catch (error) {
                                logger.error(`!!! [${requestId}] Error in pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'} - ${error.message}`);
                                logger.debug(`[${requestId}] Error stack: ${error.stack}`);
                                throw error;
                            }
                        })
                    );
                    
                    const duration = Date.now() - startTime;
                    logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned ${results.length} results`);
                    return results;
                }
            }
            
            // Default behavior: execute all prompts in sequence
            logger.info(`[${requestId}] Executing prompts in sequence`);
            const userPathway = await pathwayManager.getPathway(userId, pathwayName);
            contextValue.pathway = userPathway;
            
            const result = await userPathway.rootResolver(null, pathwayArgs, contextValue, info);
            const duration = Date.now() - startTime;
            logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned 1 result`);
            return [result]; // Wrap single result in array for consistent return type
            
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
    build
};

