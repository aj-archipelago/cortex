import path from 'path';
import convict from 'convict';
import HandleBars from './lib/handleBars.js';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import GcpAuthTokenHelper from './lib/gcpAuthTokenHelper.js';
import logger from './lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

convict.addFormat({
    name: 'string-array',
    validate: function(val) {
      if (!Array.isArray(val)) {
        throw new Error('must be of type Array');
      }
    },
    coerce: function(val) {
      return val.split(',');
    },
});

// Schema for config
var config = convict({
    env: {
        format: String,
        default: 'development',
        env: 'NODE_ENV'
    },
    cortexId: {
        format: String,
        default: 'local',
        env: 'CORTEX_ID'
    },
    basePathwayPath: {
        format: String,
        default: path.join(__dirname, 'pathways', 'basePathway.js'),
        env: 'CORTEX_BASE_PATHWAY_PATH'
    },
    corePathwaysPath: {
        format: String,
        default: path.join(__dirname, 'pathways'),
        env: 'CORTEX_CORE_PATHWAYS_PATH'
    },
    cortexApiKeys: {
        format: 'string-array',
        default: null,
        env: 'CORTEX_API_KEY',
        sensitive: true
    },
    cortexConfigFile: {
        format: String,
        default: null,
        env: 'CORTEX_CONFIG_FILE'
    },
    defaultModelName: {
        format: String,
        default: null,
        env: 'DEFAULT_MODEL_NAME'
    },
    enableCache: {
        format: Boolean,
        default: true,
        env: 'CORTEX_ENABLE_CACHE'
    },
    enableDuplicateRequests: {
        format: Boolean,
        default: true,
        env: 'CORTEX_ENABLE_DUPLICATE_REQUESTS'
    },
    enableGraphqlCache: {
        format: Boolean,
        default: false,
        env: 'CORTEX_ENABLE_GRAPHQL_CACHE'
    },
    enableRestEndpoints: {
        format: Boolean,
        default: false,
        env: 'CORTEX_ENABLE_REST'
    },
    gcpServiceAccountKey: {
        format: String,
        default: null,
        env: 'GCP_SERVICE_ACCOUNT_KEY',
        sensitive: true
    },
    models: {
        format: Object,
        default: {
            "oai-gpturbo": {
                "type": "OPENAI-CHAT",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "gpt-3.5-turbo"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 8192,
                "supportsStreaming": true,
            },
            "oai-whisper": {
                "type": "OPENAI-WHISPER",
                "url": "https://api.openai.com/v1/audio/transcriptions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}"
                },
                "params": {
                    "model": "whisper-1"
                },
            },
            "neuralspace": {
                "type": "NEURALSPACE",
                "url": "https://voice.neuralspace.ai/api/v2/jobs",
                "headers": {
                    "Authorization": "{{NEURALSPACE_API_KEY}}",
                },
            },
            "azure-cognitive": {
                "type": "AZURE-COGNITIVE",
                "url": "{{{AZURE_COGNITIVE_API_URL}}}",
                "headers": {
                    "api-key": "{{AZURE_COGNITIVE_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "requestsPerSecond": 10
            },
            "oai-embeddings": {
                "type": "OPENAI-EMBEDDINGS",
                "url": "https://api.openai.com/v1/embeddings",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "text-embedding-ada-002"
                },
                "maxTokenLength": 8192,
            },
            "oai-gpt4o": {
                "type": "OPENAI-VISION",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "gpt-4o"
                },
                "requestsPerSecond": 50,
                "maxTokenLength": 131072,
                "maxReturnTokens": 4096,
                "supportsStreaming": true
            },
            "azure-bing": {
                "type": "AZURE-BING",
                "url": "https://api.bing.microsoft.com/v7.0/search",
                "headers": {
                    "Ocp-Apim-Subscription-Key": "{{AZURE_BING_KEY}}",
                    "Content-Type": "application/json"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 200000
            },
        },
        env: 'CORTEX_MODELS'
    },
    openaiApiKey: {
        format: String,
        default: null,
        env: 'OPENAI_API_KEY',
        sensitive: true
    },
    openaiApiUrl: {
        format: String,
        default: 'https://api.openai.com/v1/completions',
        env: 'OPENAI_API_URL'
    },
    openaiDefaultModel: {
        format: String,
        default: 'gpt-3.5-turbo',
        env: 'OPENAI_DEFAULT_MODEL'
    },
    pathways: {
        format: Object,
        default: {}
    },
    pathwaysPath: {
        format: String,
        default: path.join(process.cwd(), '/pathways'),
        env: 'CORTEX_PATHWAYS_PATH'
    },
    PORT: {
        format: 'port',
        default: 4000,
        env: 'CORTEX_PORT'
    },
    storageConnectionString: {
        doc: 'Connection string used for access to Storage',
        format: '*',
        default: '',
        sensitive: true,
        env: 'STORAGE_CONNECTION_STRING'
    },
    redisEncryptionKey: {
        format: String,
        default: null,
        env: 'REDIS_ENCRYPTION_KEY',
        sensitive: true
    },
    dalleImageApiUrl: {
        format: String,
        default: 'null',
        env: 'DALLE_IMAGE_API_URL'
    },
    whisperMediaApiUrl: {
        format: String,
        default: 'null',
        env: 'WHISPER_MEDIA_API_URL'
    },
    whisperTSApiUrl: {
        format: String,
        default: null,
        env: 'WHISPER_TS_API_URL'
    },
    subscriptionKeepAlive: {
        format: Number,
        default: 0,
        env: 'SUBSCRIPTION_KEEP_ALIVE'
    },
    neuralSpaceApiKey: {
        format: String,
        default: null,
        env: 'NEURALSPACE_API_KEY'
    },
});

// Read in environment variables and set up service configuration
const configFile = config.get('cortexConfigFile');

// Load config file
if (configFile && fs.existsSync(configFile)) {
    logger.info(`Loading config from ${configFile}`);
    config.loadFile(configFile);
} else {
    const openaiApiKey = config.get('openaiApiKey');
    if (!openaiApiKey) {
        const errorString = 'No config file or api key specified. Please set the OPENAI_API_KEY to use OAI or use CORTEX_CONFIG_FILE environment variable to point at the Cortex configuration for your project.';
        logger.error(errorString);
        throw new Error(errorString);
    } else {
        logger.info(`Using default model with OPENAI_API_KEY environment variable`)
    }
}

if (config.get('gcpServiceAccountKey')) {
    const gcpAuthTokenHelper = new GcpAuthTokenHelper(config.getProperties());
    config.set('gcpAuthTokenHelper', gcpAuthTokenHelper);
}

// Build and load pathways to config
const buildPathways = async (config) => {
    const { pathwaysPath, corePathwaysPath, basePathwayPath } = config.getProperties();

    const pathwaysURL = pathToFileURL(pathwaysPath).toString();
    const corePathwaysURL = pathToFileURL(corePathwaysPath).toString();
    const basePathwayURL = pathToFileURL(basePathwayPath).toString();

    // Load cortex base pathway 
    const basePathway = await import(basePathwayURL).then(module => module.default);

    // Load core pathways, default from the Cortex package
    logger.info(`Loading core pathways from ${corePathwaysPath}`)
    let loadedPathways = await import(`${corePathwaysURL}/index.js`).then(module => module);

    // Load custom pathways and override core pathways if same
    if (pathwaysPath && fs.existsSync(pathwaysPath)) {
        logger.info(`Loading custom pathways from ${pathwaysPath}`)
        const customPathways = await import(`${pathwaysURL}/index.js`).then(module => module);
        loadedPathways = { ...loadedPathways, ...customPathways };
    }

    // This is where we integrate pathway overrides from the config
    // file. This can run into a partial definition issue if the
    // config file contains pathways that no longer exist.
    const pathways = config.get('pathways');
    for (const [key, def] of Object.entries(loadedPathways)) {
        const pathway = { ...basePathway, name: key, objName: key.charAt(0).toUpperCase() + key.slice(1), ...def, ...pathways[key] };
        pathways[def.name || key] = pathways[key] = pathway;
    }

    // Add pathways to config
    config.load({ pathways })

    return pathways;
}

// Build and load models to config
const buildModels = (config) => {
    const { models } = config.getProperties();

    // iterate over each model
    for (let [key, model] of Object.entries(models)) {
        if (!model.name) {
            model.name = key;
        }
        
        // if model is in old format, convert it to new format
        if (!model.endpoints) {
            model = {
                ...model,
                endpoints: [
                    {
                        name: "default",
                        url: model.url,
                        headers: model.headers,
                        params: model.params,
                        requestsPerSecond: model.requestsPerSecond
                    }
                ]
            };
        }

        // compile handlebars templates for each endpoint
        model.endpoints = model.endpoints.map(endpoint => 
            JSON.parse(HandleBars.compile(JSON.stringify(endpoint))({ ...model, ...config.getEnv(), ...config.getProperties() }))
        );

        models[key] = model;
    }

    // Add constructed models to config
    config.load({ models });

    // Check that models are specified, Cortex cannot run without a model
    if (Object.keys(config.get('models')).length <= 0) {
        const errorString = 'No models specified! Please set the models in your config file or via CORTEX_MODELS environment variable to point at the models for your project.';
        logger.error(errorString);
        throw new Error(errorString);
    }

    // Set default model name to the first model in the config in case no default is specified
    if (!config.get('defaultModelName')) {
        logger.warn('No default model specified, using first model as default.');
        config.load({ defaultModelName: Object.keys(config.get('models'))[0] });
    }

    return models;
}

// TODO: Perform validation
// config.validate({ allowed: 'strict' });

export { config, buildPathways, buildModels };