const { config } = require("./config");
const { fns } = require("./fn");
const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { hasListReturn } = require("./util");

//build API
const endpoints = config.get('endpoints');
const endpointNames = Object.keys(endpoints);

const typeDef = (endpointName) => {
    if (hasListReturn(endpoints[endpointName])) {
        return `${endpointName}(text: String!): [String],`
    }
    return `${endpointName}(text: String!): String,`
}

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

    type Query {
        ${endpointNames.map(endpointName => typeDef(endpointName)).join('\n\t')}
    }
`;
console.log(typeDefs);

//resolver fns
//resolvers
const resolvers = {
    Query: fns,
}
console.log(resolvers);


const plugins = [
    // ApolloServerPluginLandingPageLocalDefault({ embed: true }), // For local development.   
    // responseCachePlugin({ cache }),
    // responseCachePlugin(),
    // ApolloServerPluginCacheControl({ defaultMaxAge: 3600 * 24 * 30 })
];


if (config.get('cache')) {
    const responseCachePlugin = require('@apollo/server-plugin-response-cache').default;
    const { KeyvAdapter } = require("@apollo/utils.keyvadapter");
    const Keyv = require("keyv");
    const cache = new KeyvAdapter(new Keyv(process.env.REDIS_CONNECTION_URL,
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
    // cache,
    // cache: "bounded",
    plugins,
    // debug: true,
});

// Start server.
startStandaloneServer(server).then(({ url }) => {
    console.log(`🚀 Server ready at ${url}`);
});
// const { url } = await startStandaloneServer(server);
// console.log(`🚀 Server ready at ${url}`);

module.exports = {
    typeDefs,
    resolvers,
    server,
};