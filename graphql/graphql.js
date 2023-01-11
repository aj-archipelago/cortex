// TODO notes:
// number of api list, ref 
// default json hosts multiple apis 
// nueron can have ref to api name
// temperature, randomness
// flexible config for pathways
// nuerons complex fns
// json to js, custom code 
// multi step processing
// #first call to pull data from api #second call to process data #third ...
// TODO: current api  implement first! deploy this
// caching ++
// custom input params 
// optional to pass user context, like a userid, personealized returns to the pathways
// e.g. chat pathway with userid
// chunking, batching, parallelism, !!
// model param for the pathway (optional)

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
    //TODO: check code first approach - codegen
    const typeDefs = `#graphql
    enum CacheControlScope {
        PUBLIC
        PRIVATE
    }

    directive @cacheControl(
        maxAge: Int
        scope: CacheControlScope
        inheritMaxAge: Boolean
    ) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION

    ${Object.values(pathways).filter(e => e.typeDef).map(e => e.typeDef.type(e)).filter(Boolean).join('\n\t')}

    type Query {
        ${Object.values(pathways).filter(e => e.typeDef).map(e => e.typeDef.label(e)).join('\n\t')}
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

    return typeDefs;
}

const getResolvers = (config, pathways) => {
    const resolverFunctions = {};
    for (const [name, pathway] of Object.entries(pathways)) {
        resolverFunctions[name] = (parent, args, contextValue, info) => {
            // add shared state to contextValue
            contextValue.config = config;
            contextValue.pathway = pathway;

            return pathway.resolver(parent, args, contextValue, info);
        }
    }
    const resolvers = {
        Query: resolverFunctions,
        Subscription: subscriptions
    }

    return resolvers;
}

//graphql api build factory method
const build = (config) => {
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
        context: ({ req, res }) => ({ req, res }),
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

    return { server, startServer, cache, plugins, typeDefs, resolvers }
}


module.exports = {
    build
};