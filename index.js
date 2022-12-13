const { config } = require('./config');
const { typeDefs, resolvers, server, startServer, cache, plugins } = require('./graphql');

module.exports = {
    config,
    typeDefs,
    resolvers,
    server,
    startServer,
    cache,
    plugins
}