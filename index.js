const { config } = require('./config');
const { build } = require('./graphql/graphql');

module.exports = (configParams) => {
    configParams && config.load(configParams);
    return build(config);
}