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

const { config } = require("./config");

//build api
const pathways = config.get('pathways');

//typeDefs
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

    ${Object.values(pathways).filter(e => e.typeDef).map(e => e.typeDef.type).filter(Boolean).join('\n\t')}

    type Query {
        ${Object.values(pathways).filter(e => e.typeDef).map(e => e.typeDef.label(e)).join('\n\t')}
    }
`;

const resolverFunctions = {};
for (const [name, pathway] of Object.entries(pathways)) {
    resolverFunctions[name] = (parent, args, contextValue, info) => pathway.resolver({ config, pathway, parent, args, contextValue, info });
}
const resolvers = {
    Query: resolverFunctions,
}

/// Create apollo graphql server
const { ApolloServer, gql } = require('apollo-server-azure-functions');
const {
    ApolloServerPluginLandingPageLocalDefault
} = require('apollo-server-core');
const Keyv = require("keyv");
const { KeyvAdapter } = require("@apollo/utils.keyvadapter");
const responseCachePlugin = require('apollo-server-plugin-response-cache').default

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

// Create server.
const server = new ApolloServer({
    typeDefs,
    resolvers,
    csrfPrevention: true,
    plugins
});

module.exports = {
    typeDefs,
    resolvers,
    server,
    cache,
    plugins
};