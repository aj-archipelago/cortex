const { config } = require('./config');
const { build } = require('./graphql');

module.exports = (configParams) => {
    configParams && config.load(configParams);
    const { server, azureHandler, cache, plugins, typeDefs, resolvers } = build(config);
    return { server, azureHandler, cache, plugins, typeDefs, resolvers, build };
}