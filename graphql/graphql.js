import { createServer } from 'http';
import {
    ApolloServerPluginDrainHttpServer,
    ApolloServerPluginLandingPageLocalDefault,
} from 'apollo-server-core';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import express from 'express';
import { ApolloServer } from 'apollo-server-express';
import Keyv from 'keyv';
import { KeyvAdapter } from '@apollo/utils.keyvadapter';
import responseCachePlugin from 'apollo-server-plugin-response-cache';
import subscriptions from './subscriptions.js';
import { buildLimiters } from '../lib/request.js';
import { cancelRequestResolver } from './resolver.js';
import { buildPathways, buildModels } from '../config.js';
import { requestState } from './requestState.js';

const getPlugins = (config) => {
    // server plugins
    const plugins = [
        ApolloServerPluginLandingPageLocalDefault({ embed: true }), // For local development.   
    ];

    //if cache is enabled and Redis is available, use it
    let cache;
    if (config.get('enableGraphqlCache') && config.get('storageConnectionString')) {
        cache = new KeyvAdapter(new Keyv(config.get('storageConnectionString'),{
            ssl: true,
            abortConnect: false,            
        }));
        //caching similar strings, embedding hashing, ... #delta similarity 
        // TODO: custom cache key:
        // https://www.apollographql.com/docs/apollo-server/performance/cache-backends#implementing-your-own-cache-backend
        plugins.push(responseCachePlugin({ cache }));
    }

    return { plugins, cache };
}

const buildRestEndpoints = (pathways, app, server, config) => {
  for (const [name, pathway] of Object.entries(pathways)) {
    // Only expose endpoints for enabled pathways that explicitly want to expose a REST endpoint
    if (pathway.disabled || !config.get('enableRestEndpoints')) continue;

    const fieldVariableDefs = pathway.typeDef(pathway).restDefinition || [];

    app.post(`/rest/${name}`, async (req, res) => {
      const variables = fieldVariableDefs.reduce((acc, variableDef) => {
        if (req.body.hasOwnProperty(variableDef.name)) {
          acc[variableDef.name] = req.body[variableDef.name];
        }
        return acc;
      }, {});

      const variableParams = fieldVariableDefs.map(({ name, type }) => `$${name}: ${type}`).join(', ');
      const queryArgs = fieldVariableDefs.map(({ name }) => `${name}: $${name}`).join(', ');

      const query = `
                query ${name}(${variableParams}) {
                    ${name}(${queryArgs}) {
                        contextId
                        previousResult
                        result
                    }
                }
            `;

      const result = await server.executeOperation({ query, variables });
      res.json(result.data[name]);
    });
  }
};

//typeDefs
const getTypedefs = (pathways) => {

    const defaultTypeDefs = `#graphql
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
    
    type RequestSubscription {
        requestId: String
        progress: Float
        data: String
    }

    type Subscription {
        requestProgress(requestIds: [String!]): RequestSubscription
    }
`;

    const typeDefs = [defaultTypeDefs, ...Object.values(pathways).filter(p=>!p.disabled).map(p => p.typeDef(p).gqlDefinition)];
    return typeDefs.join('\n');
}

const getResolvers = (config, pathways) => {
    const resolverFunctions = {};
    for (const [name, pathway] of Object.entries(pathways)) {
        if (pathway.disabled) continue; //skip disabled pathways
        resolverFunctions[name] = (parent, args, contextValue, info) => {
            // add shared state to contextValue
            contextValue.pathway = pathway;
            return pathway.rootResolver(parent, args, contextValue, info);
        }
    }

    const resolvers = {
        Query: resolverFunctions,
        Mutation: { 'cancelRequest': cancelRequestResolver },
        Subscription: subscriptions,
    }

    return resolvers;
}

//graphql api build factory method
const build = async (config) => {
    // First perform config build
    await buildPathways(config);
    buildModels(config);

    // build api limiters 
    buildLimiters(config);

    //build api
    const pathways = config.get('pathways');

    const typeDefs = getTypedefs(pathways);
    const resolvers = getResolvers(config, pathways);

    const schema = makeExecutableSchema({ typeDefs, resolvers });

    const { plugins, cache } = getPlugins(config);

    const app = express()

    const httpServer = createServer(app);

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
    const serverCleanup = useServer({ schema }, wsServer);

    const server = new ApolloServer({
        schema,
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
            }]),
        context: ({ req, res }) => ({ req, res, config, requestState }),
    });

    // If CORTEX_API_KEY is set, we roll our own auth middleware - usually not used if you're being fronted by a proxy
    const cortexApiKey = config.get('cortexApiKey');

    app.use((req, res, next) => {
        if (cortexApiKey && req.headers.cortexApiKey !== cortexApiKey && req.query.cortexApiKey !== cortexApiKey) {
            res.status(401).send('Unauthorized');
        } else {
            next();
        }
    });
    
    // Use the JSON body parser middleware for REST endpoints
    app.use(express.json());
        
    // add the REST endpoints
    buildRestEndpoints(pathways, app, server, config);

    // if local start server
    const startServer = async () => {
        await server.start();
        server.applyMiddleware({ app });

        // Now that our HTTP server is fully set up, we can listen to it.
        httpServer.listen(config.get('PORT'), () => {
            console.log(`🚀 Server is now running at http://localhost:${config.get('PORT')}${server.graphqlPath}`);
        });
    };

    return { server, startServer, cache, plugins, typeDefs, resolvers }
}


export {
    build
};