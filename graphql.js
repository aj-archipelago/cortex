const { config } = require("./config");
const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer, start } = require('@apollo/server/standalone');

//build api
const endpoints = config.get('endpoints');

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

    ${Object.values(endpoints).map(e => e.typeDef.type).filter(Boolean).join('\n\t')}

    type Query {
        ${Object.values(endpoints).map(e => e.typeDef.label(e)).join('\n\t')}
    }
`;
console.log(typeDefs);

//resolvers
const fns = {};
for (const [name, endpoint] of Object.entries(endpoints)) {
    fns[name] = (parent, args, contextValue, info) => endpoint.resolver({ config, endpoint, parent, args, contextValue, info });
}
const resolvers = {
    Query: fns,
}
console.log(resolvers);


///gql server

//apollo server plugins
const plugins = [
];

//cache
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
if (process.env.STANDALONE_SERVER) {
    startStandaloneServer(server).then(({ url }) => {
        console.log(`🚀 Server ready at ${url}`);
    });
}

module.exports = {
    typeDefs,
    resolvers,
    server,
};