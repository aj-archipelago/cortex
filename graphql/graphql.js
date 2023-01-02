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


/// Create apollo graphql server
const {
    ApolloServerPluginLandingPageLocalDefault
} = require('apollo-server-core');
const Keyv = require("keyv");
const { KeyvAdapter } = require("@apollo/utils.keyvadapter");
const responseCachePlugin = require('apollo-server-plugin-response-cache').default


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
    }

    return resolvers;
}

const AZURE = 'azure';
const STANDALONE = 'standalone';

//graphql api build factory method
const build = (config) => {
    //build api
    const pathways = config.get('pathways');

    const typeDefs = getTypedefs(pathways);
    const resolvers = getResolvers(config, pathways);

    const { plugins, cache } = getPlugins(config);

    //build server
    const isAzureServer = config.get('server') === AZURE;
    const isStandAloneServer = config.get('server') === STANDALONE;

    const { ApolloServer, gql } = require(isAzureServer ? 'apollo-server-azure-functions' : 'apollo-server');

    const server = new ApolloServer({
        typeDefs,
        resolvers,
        csrfPrevention: true,
        plugins,
        context: ({ req, res }) => ({ req, res }),
    });

    // if azure export handler
    const azureHandler = isAzureServer ? server.createHandler() : null;

    // if local start server
    const startServer = isStandAloneServer ? async () => {
        const { url } = await server.listen();
        console.log(`🚀 Server ready at ${url}`);
    } : null;

    return { server, azureHandler, startServer, cache, plugins, typeDefs, resolvers }
}


module.exports = {
    build
};