import path from 'path';
const __dirname = path.dirname(new URL(import.meta.url).pathname);
import convict from 'convict';
import HandleBars from './lib/handleBars.js';
import fs from 'fs';

// Schema for config
var config = convict({
    pathwaysPath: {
        format: String,
        default: path.join(process.cwd(), '/pathways'),
        env: 'CORTEX_PATHWAYS_PATH'
    },
    corePathwaysPath: {
        format: String,
        default: path.join(__dirname, 'pathways'),
        env: 'CORTEX_CORE_PATHWAYS_PATH'
    },
    basePathwayPath: {
        format: String,
        default: path.join(__dirname, 'pathways', 'basePathway.js'),
        env: 'CORTEX_BASE_PATHWAY_PATH'
    },
    storageConnectionString: {
        doc: 'Connection string used for access to Storage',
        format: '*',
        default: '',
        sensitive: true,
        env: 'STORAGE_CONNECTION_STRING'
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
    enableCache: {
        format: Boolean,
        default: true,
        env: 'CORTEX_ENABLE_CACHE'
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
    cortexApiKey: {
        format: String,
        default: null,
        env: 'CORTEX_API_KEY'
    },
    defaultModelName: {
        format: String,
        default: null,
        env: 'DEFAULT_MODEL_NAME'
    },
    models: {
        format: Object,
        default: {
            "oai-td3": {
                "type": "OPENAI-COMPLETION",
                "url": "{{openaiApiUrl}}",
                "headers": {
                    "Authorization": "Bearer {{openaiApiKey}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "{{openaiDefaultModel}}"
                },
            },
            "oai-whisper": {
                "type": "OPENAI_WHISPER",
                "url": "https://api.openai.com/v1/audio/transcriptions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}"
                },
                "params": {
                    "model": "whisper-1"
                },
            }
        },
        env: 'CORTEX_MODELS'
    },
    openaiDefaultModel: {
        format: String,
        default: 'text-davinci-003',
        env: 'OPENAI_DEFAULT_MODEL'
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
    cortexConfigFile: {
        format: String,
        default: null,
        env: 'CORTEX_CONFIG_FILE'
    },
});

// Read in environment variables and set up service configuration
const configFile = config.get('cortexConfigFile');

// Load config file
if (configFile && fs.existsSync(configFile)) {
    console.log('Loading config from', configFile);
    config.loadFile(configFile);
} else {
    const openaiApiKey = config.get('openaiApiKey');
    if (!openaiApiKey) {
        throw console.log('No config file or api key specified. Please set the OPENAI_API_KEY to use OAI or use CORTEX_CONFIG_FILE environment variable to point at the Cortex configuration for your project.');
    }else {
        console.log(`Using default model with OPENAI_API_KEY environment variable`)
    }
}

// Build and load pathways to config
const buildPathways = async (config) => {
    const { pathwaysPath, corePathwaysPath, basePathwayPath } = config.getProperties();

    // Load cortex base pathway 
    const basePathway = await import(basePathwayPath).then(module => module.default);

    // Load core pathways, default from the Cortex package
    console.log('Loading core pathways from', corePathwaysPath)
    let loadedPathways = await import(`${corePathwaysPath}/index.js`).then(module => module);

    // Load custom pathways and override core pathways if same
    if (pathwaysPath && fs.existsSync(pathwaysPath)) {
        console.log('Loading custom pathways from', pathwaysPath)
        const customPathways = await import(`${pathwaysPath}/index.js`).then(module => module);
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

    for (const [key, model] of Object.entries(models)) {        
        // Compile handlebars templates for models
        models[key] = JSON.parse(HandleBars.compile(JSON.stringify(model))({ ...config.getEnv(), ...config.getProperties() }))
    }

    // Add constructed models to config
    config.load({ models });


    // Check that models are specified, Cortex cannot run without a model
    if (Object.keys(config.get('models')).length <= 0) {
        throw console.log('No models specified! Please set the models in your config file or via CORTEX_MODELS environment variable to point at the models for your project.');
    }

    // Set default model name to the first model in the config in case no default is specified
    if (!config.get('defaultModelName')) {
        console.log('No default model specified, using first model as default.');
        config.load({ defaultModelName: Object.keys(config.get('models'))[0] }); 
    } 

    return models;
}

// TODO: Perform validation
// config.validate({ allowed: 'strict' });

export { config, buildPathways, buildModels };