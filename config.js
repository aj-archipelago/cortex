var convict = require('convict');

// TODO: Define a schema possibly with formatters
const config = convict({});
config.loadFile(process.env.CONFIG_FILES);

//build endpoints
const endpointDefs = require(process.env.ENDPOINTS_PATH);
const defaultEndpoint = require(process.env.DEFAULT_ENDPOINT);
const endpoints = {};
for (const [key, def] of Object.entries(endpointDefs)) {
    endpoints[def.name || key] = endpoints[key] = { ...defaultEndpoint, name: key, ...def };
}
config.load({ endpoints })
console.log(config.get('endpoints')); //print endpoints

// TODO: Perform validation
// config.validate({ allowed: 'strict' });


module.exports = { config };