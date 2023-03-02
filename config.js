const path = require('path');

var convict = require('convict');

// TODO: Define a schema possibly with formatters

var config = convict({
    pathwaysPath: {
        format: String,
        default: null,
        env: 'CORTEX_PATHWAYS_PATH'
    },
    corePathwaysPath: {
        format: String,
        default: path.join(__dirname, 'pathways')
    },
    redisUrl: {
        format: String,
        default: null,
        env: 'CORTEX_REDIS_URL'
    },
    redisKey: {
        doc: 'Secret used for access to Redis',
        format: '*',
        default: '',
        sensitive: true,
        env: 'CORTEX_REDIS_KEY'
    },
    PORT: {
        format: 'port',
        default: 4000,
        env: 'CORTEX_PORT'
    },
    pathways: {
        format: Object,
        default: {}
    },
  });

// Read in environment variables and set up service configuration
const configFile = process.env.CORTEX_CONFIG_FILE || null;

// Load config file
if (configFile) {
    console.log('Loading config from', configFile);
    config.loadFile(configFile);
  } else {
    throw 'No config file specified. Please set the CORTEX_CONFIG_FILE environment variable to point at the Cortex configuration for your project.'
}

// Set up local variables
const { pathwaysPath, corePathwaysPath, redisUrl, redisKey, PORT } = config.getProperties();

// Configure Redis
if (redisUrl) {
    console.log('Using Redis at', redisUrl);
    config.load({ redisUrl, redisKey });
} else {
    console.log('No Redis URL specified. Please set the CORTEX_REDIS_URL environment variable to point at the Redis instance for your project if you need caching or stored context.')
}

// Configure port
config.load({ PORT });

// Load core pathways and the base pathway from the Cortex package
console.log('Loading core pathways from', corePathwaysPath)
const loadedPathways = require(corePathwaysPath);
const basePathway = require(`${corePathwaysPath}/basePathway.js`);

// Load custom pathways and override core pathways
if (pathwaysPath) {
    console.log('Loading custom pathways from', pathwaysPath)
    const customPathways = require(pathwaysPath);
    loadedPathways = { ...loadedPathways, ...customPathways };
}

const pathways = {};
for (const [key, def] of Object.entries(loadedPathways)) {
    const pathway = { ...basePathway, name: key, objName: key.charAt(0).toUpperCase() + key.slice(1), ...def };
    pathways[def.name || key] = pathways[key] = pathway;
}

// Add pathways to config
config.load({ pathways })

// TODO: Perform validation
// config.validate({ allowed: 'strict' });

module.exports = { config };