const { createServer } = require('http');
const {
    ApolloServerPluginDrainHttpServer,
    ApolloServerPluginLandingPageLocalDefault,
} = require("apollo-server-core");
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { WebSocketServer } = require('ws');
const { useServer } = require('graphql-ws/lib/use/ws');
const express = require('express');

/// Create apollo graphql server
const Keyv = require("keyv");
const { KeyvAdapter } = require("@apollo/utils.keyvadapter");
const responseCachePlugin = require('apollo-server-plugin-response-cache').default

const subscriptions = require('./subscriptions');
const { buildLimiters } = require('../request');
const { cancelRequestResolver } = require('./resolver');

const PORT = process.env.CORTEX_PORT || 4000;

const getPlugins = (config) => {
    // server plugins
    const plugins = [
        ApolloServerPluginLandingPageLocalDefault({ embed: true }), // For local development.   
    ];

    //cache
    let cache;
    if (config.get('cache')) {
        cache = new KeyvAdapter(new Keyv(process.env.REDIS_CONNECTION_URL,
            {
                password: process.env.REDIS_CONNECTION_KEY,
                ssl: true,
                abortConnect: false
            })
        );
        //caching similar strings, embedding hashing, ... #delta similarity 
        // TODO: custom cache key:
        // https://www.apollographql.com/docs/apollo-server/performance/cache-backends#implementing-your-own-cache-backend
        plugins.push(responseCachePlugin({ cache }));
    }

    return { plugins, cache };
}

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
        _test : Boolean
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
        requestProgress(requestId: String!): RequestSubscription
    }
`;

    const typeDefs = [defaultTypeDefs, ...Object.values(pathways).map(p => p.typeDef(p))];
    return typeDefs.join('\n');
}

const requestState = {}

const getResolvers = (config, pathways) => {
    const resolverFunctions = {};
    for (const [name, pathway] of Object.entries(pathways)) {
        resolverFunctions[name] = (parent, args, contextValue, info) => {
            // add shared state to contextValue
            contextValue.pathway = pathway;
            return pathway.rootResolver(parent, args, contextValue, info);
        }
    }

    const resolvers = {
        Query: resolverFunctions,
        Mutation: {'cancelRequest': cancelRequestResolver},
        Subscription: subscriptions,
    }

    return resolvers;
}

//graphql api build factory method
const build = (config) => {
    // build api limiters 
    buildLimiters(config);
    
    //build api
    const pathways = config.get('pathways');

    const typeDefs = getTypedefs(pathways);
    const resolvers = getResolvers(config, pathways);

    const schema = makeExecutableSchema({ typeDefs, resolvers });

    const { plugins, cache } = getPlugins(config);

    const { ApolloServer, gql } = require('apollo-server-express');
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

    // if local start server
    const startServer = async () => {
        await server.start();
        server.applyMiddleware({ app });

        // Now that our HTTP server is fully set up, we can listen to it.
        httpServer.listen(PORT, () => {
            console.log(`🚀 Server is now running at http://localhost:${PORT}${server.graphqlPath}`);
        });
    };

    app.use((req, res, next) => {
        if (process.env.API_KEY && req.headers.api_key !== process.env.API_KEY && req.query.api_key !== process.env.API_KEY) {
            res.status(401).send('Unauthorized');
        }
        
        next();
    })

    return { server, startServer, cache, plugins, typeDefs, resolvers }
}


module.exports = {
    build
};