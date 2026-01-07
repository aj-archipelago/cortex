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
import { buildModels, buildPathways } from '../config.js';
import logger from '../lib/logger.js';
import { buildModelEndpoints } from '../lib/requestExecutor.js';
import { startTestServer } from '../tests/helpers/server.js';
import { requestState } from './requestState.js';
import { cancelRequestResolver, submitClientToolResultResolver } from './resolver.js';
import subscriptions from './subscriptions.js';
import { getMessageTypeDefs } from './typeDef.js';
import { buildRestEndpoints } from './rest.js';
import { executeWorkspaceResolver, getExecuteWorkspaceTypeDefs } from './executeWorkspace.js';

// Utility functions
// Server plugins
const getPlugins = (config) => {
    const plugins = [
        ApolloServerPluginLandingPageLocalDefault({ embed: true }), // For local development.   
    ];

    //if cache is enabled and Redis is available, use it
    let cache;
    if (config.get('enableGraphqlCache') && config.get('storageConnectionString')) {
        const keyvCache = new Keyv(config.get('storageConnectionString'), {
            ssl: true,
            abortConnect: false,
        });
        
        // Handle Redis connection errors to prevent crashes
        keyvCache.on('error', (error) => {
            logger.error(`GraphQL Keyv Redis connection error: ${error}`);
        });
        
        cache = new KeyvAdapter(keyvCache);
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
        submitClientToolResult(requestId: String!, toolCallbackId: String!, result: String!, success: Boolean!): Boolean
    }

    ${getExecuteWorkspaceTypeDefs()}

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
    const queryResolvers = {};
    const mutationResolvers = {};
    
    for (const [name, pathway] of Object.entries(pathways)) {
        if (pathway.disabled) continue;
        
        const resolver = (parent, args, contextValue, info) => {
            // add shared state to contextValue
            contextValue.pathway = pathway;
            contextValue.config = config;
            return pathway.rootResolver(parent, args, contextValue, info);
        };
        
        // Check if pathway is a mutation using the isMutation property
        if (pathway.isMutation) {
            mutationResolvers[name] = resolver;
        } else {
            queryResolvers[name] = resolver;
        }
    }

    const pathwayManagerResolvers = pathwayManager?.getResolvers() || {};

    const resolvers = {
        Query: {
            ...queryResolvers,
            executeWorkspace: (parent, args, contextValue, info) => 
                executeWorkspaceResolver(parent, args, contextValue, info, config, pathwayManager)
        },
        Mutation: {
            'cancelRequest': cancelRequestResolver,
            'submitClientToolResult': submitClientToolResultResolver,
            ...mutationResolvers,
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
        introspection: config.get('env') === 'development' || config.get('env') === 'debug',
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

