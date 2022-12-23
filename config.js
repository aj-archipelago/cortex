const path = require('path');

var convict = require('convict');

// TODO: Define a schema possibly with formatters
const config = convict({});
const configFile = process.env.CONFIG_FILE || __dirname + '/config/default.json';
const pathwaysPath = process.env.PATHWAYS_PATH || __dirname + '/pathways';

console.log('Loading config from', configFile)
config.loadFile(configFile);

console.log('Loading pathways from', pathwaysPath)
const loadedPathways = require(pathwaysPath);
const basePathway = require(`./pathways/basePathway.js`);

const pathways = {};
for (const [key, def] of Object.entries(loadedPathways)) {
    pathways[def.name || key] = pathways[key] = { ...basePathway, name: key, ...def };
}

// Add pathways to config
config.load({ pathways })

// TODO: Perform validation
// config.validate({ allowed: 'strict' });

module.exports = { config };