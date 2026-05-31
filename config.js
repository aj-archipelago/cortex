import path from 'path';
import convict from 'convict';
import HandleBars from './lib/handleBars.js';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import GcpAuthTokenHelper from './lib/gcpAuthTokenHelper.js';
import AzureAuthTokenHelper from './lib/azureAuthTokenHelper.js';
import logger from './lib/logger.js';
import PathwayManager from './lib/pathwayManager.js';
import { readdir } from 'fs/promises';
import { entityConstants } from './lib/entityConstants.js';
import { Prompt } from './server/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigExample = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'default.example.json'), 'utf8'));

convict.addFormat({
    name: 'string-array',
    validate: function (val) {
        if (!Array.isArray(val)) {
            throw new Error('must be of type Array');
        }
    },
    coerce: function (val) {
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
        default: defaultConfigExample.defaultModelName,
        env: 'DEFAULT_MODEL_NAME'
    },
    modelRedirects: {
        format: Object,
        default: defaultConfigExample.modelRedirects,
        env: 'MODEL_REDIRECTS'
    },
    modelGroups: {
        // Map of alias -> { members: [...], metadata?: {...} }. The alias
        // resolves at request time to the highest-priority member that's
        // healthy and not meaningfully slower than the fastest. See
        // lib/requestExecutor.js (pickGroupMember), lib/modelSampler.js, and
        // pathways/system/sys_model_metadata.js.
        format: Object,
        default: {}
    },
    defaultEntityName: {
        format: String,
        default: "Jarvis",
        env: 'DEFAULT_ENTITY_NAME'
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
    ollamaUrl: {
        format: String,
        default: '',
        env: 'OLLAMA_URL'
    },
    claudeVertexUrl: {
        format: String,
        default: 'https://region.googleapis.com/v1/projects/projectid/locations/location/publishers/anthropic/models/claude-opus-4-7',
        env: 'CLAUDE_VERTEX_URL'
    },
    geminiFlashUrl: {
        format: String,
        default: 'https://region.googleapis.com/v1/projects/projectid/locations/location/publishers/google/models/gemini-3.5-flash',
        env: 'GEMINI_FLASH_URL'
    },
    geminiApiKey: {
        format: String,
        default: null,
        env: 'GEMINI_API_KEY',
        sensitive: true
    },
    entityConfig: {
        format: Object,
        default: {
            jarvis: {
                name: "Jarvis",
                isDefault: true,
                description: "Jarvis is a self-aware AI entity that can help you with your tasks and answer your questions.",
                instructions: "",
                tools: ["*"],
                useMemory: true,
            },
        },
    },
    entityConstants: {
        format: Object,
        default: entityConstants,
    },
    entityTools: {
        format: Object,
        default: {},
    },
    gcpServiceAccountKey: {
        format: String,
        default: null,
        env: 'GCP_SERVICE_ACCOUNT_KEY',
        sensitive: true
    },
    azureServicePrincipalCredentials: {
        format: String,
        default: null,
        env: 'AZURE_SERVICE_PRINCIPAL_CREDENTIALS',
        sensitive: true
    },
    models: {
        format: Object,
        default: defaultConfigExample.models,
        env: 'CORTEX_MODELS'
    },
    azureVideoTranslationApiKey: {
        format: String,
        default: null,
        env: 'AZURE_VIDEO_TRANSLATION_API_KEY',
        sensitive: true
    },
    openaiApiKey: {
        format: String,
        default: null,
        env: 'OPENAI_API_KEY',
        sensitive: true
    },
    claudeApiKey: {
        format: String,
        default: null,
        env: 'CLAUDE_API_KEY',
        sensitive: true
    },
    openaiApiUrl: {
        format: String,
        default: 'https://api.openai.com/v1/completions',
        env: 'OPENAI_API_URL'
    },
    openaiDefaultModel: {
        format: String,
        default: 'gpt-5.4-mini',
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
    replicateApiKey: {
        format: String,
        default: null,
        env: 'REPLICATE_API_KEY',
        sensitive: true
    },
    runwareAiApiKey: {
        format: String,
        default: null,
        env: 'RUNWARE_API_KEY',
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
    browserServiceUrl: {
        format: String,
        default: null,
        env: 'CORTEX_BROWSER_URL'
    },
    jinaApiKey: {
        format: String,
        default: null,
        env: 'JINA_API_KEY'
    },
    apptekApiKey: {
        format: String,
        default: null,
        env: 'APPTEK_API_KEY',
        sensitive: true
    },
    apptekApiEndpoint: {
        format: String,
        default: null,
        env: 'APPTEK_API_ENDPOINT'
    },
    azureFoundryAgentUrl: {
        format: String,
        default: null,
        env: 'AZURE_FOUNDRY_AGENT_URL'
    },
    azureFoundryAgentId: {
        format: String,
        default: null,
        env: 'AZURE_FOUNDRY_AGENT_ID'
    },
    azureFoundryBingSearchConnectionId: {
        format: String,
        default: null,
        env: 'AZURE_FOUNDRY_BING_SEARCH_CONNECTION_ID'
    },
    workspaceImage: {
        format: String,
        default: 'cortex-workspace',
        env: 'WORKSPACE_IMAGE'
    },
    workspaceImageVersion: {
        format: String,
        default: '',
        env: 'WORKSPACE_IMAGE_VERSION'
    },
    workspaceNetwork: {
        format: String,
        default: 'cortex_workspace',
        env: 'WORKSPACE_NETWORK'
    },
    workspaceCpus: {
        format: String,
        default: '1.0',
        env: 'WORKSPACE_CPUS'
    },
    workspaceMemory: {
        format: String,
        default: '512m',
        env: 'WORKSPACE_MEMORY'
    },
    workspaceDiskSize: {
        format: String,
        default: '10g',
        env: 'WORKSPACE_DISK_SIZE'
    },
    dockerHost: {
        format: String,
        default: '',
        env: 'DOCKER_HOST',
        doc: 'Docker Engine endpoint. Unix socket (unix:///var/run/docker.sock) or TCP (tcp://host:port). Empty = auto-detect local socket.'
    },
    workspaceHost: {
        format: String,
        default: '',
        env: 'WORKSPACE_HOST',
        doc: 'Hostname/IP for reaching workspace containers. Set when Docker runs on a remote host. Empty = auto (localhost or Docker DNS).'
    },
    workspaceIdleTimeoutMs: {
        format: Number,
        default: 1800000,
        env: 'WORKSPACE_IDLE_TIMEOUT_MS',
        doc: 'Milliseconds of inactivity before a workspace container is automatically stopped. Default 30 minutes. Set 0 to disable.'
    },
    workspaceIdleCheckpointMs: {
        format: Number,
        default: 900000,
        env: 'WORKSPACE_IDLE_CHECKPOINT_MS',
        doc: 'Milliseconds of workspace inactivity before an ACI workspace checkpoint is refreshed. Default 15 minutes. Set 0 to checkpoint only at reap time.'
    },
    workspaceBackend: {
        format: String,
        default: 'docker',
        env: 'WORKSPACE_BACKEND',
        doc: "Container backend: 'docker' (local/remote Docker Engine) or 'aci' (Azure Container Instances)."
    },
    workspaceContainerPrefix: {
        format: String,
        default: 'workspace-local',
        env: 'WORKSPACE_CONTAINER_PREFIX',
        doc: 'Prefix for workspace ACI container groups. Production should explicitly set "workspace"; non-prod should use env-specific prefixes such as "workspace-dev", "workspace-blue", or "workspace-local".'
    },
    warmPoolSize: {
        format: Number,
        default: 2,
        env: 'WARM_POOL_SIZE',
        doc: 'Number of pre-provisioned ACI containers in the warm pool. 0 = disabled.'
    },
    warmPoolBootstrapSecret: {
        format: String,
        default: '',
        env: 'WARM_POOL_BOOTSTRAP_SECRET',
        sensitive: true,
        doc: 'Legacy shared warm-pool bootstrap secret. Deprecated and no longer used for new containers.'
    },
    warmPoolEnabled: {
        format: Boolean,
        default: false,
        env: 'WARM_POOL_ENABLED',
        doc: 'Enable the warm pool for pre-provisioned ACI workspace containers.'
    },
    azureSubscriptionId: {
        format: String,
        default: '',
        env: 'AZURE_SUBSCRIPTION_ID'
    },
    azureResourceGroup: {
        format: String,
        default: '',
        env: 'AZURE_RESOURCE_GROUP'
    },
    azureLocation: {
        format: String,
        default: 'eastus',
        env: 'AZURE_LOCATION'
    },
    aciSubnetId: {
        format: String,
        default: '',
        env: 'ACI_SUBNET_ID',
        doc: 'Full resource ID of the subnet delegated to ACI (enables private VNet deployment)'
    },
    azureAcrServer: {
        format: String,
        default: '',
        env: 'AZURE_ACR_SERVER',
        doc: 'Azure Container Registry server (e.g. myacr.azurecr.io)'
    },
    azureAcrUsername: {
        format: String,
        default: '',
        env: 'AZURE_ACR_USERNAME',
        sensitive: true
    },
    azureAcrPassword: {
        format: String,
        default: '',
        env: 'AZURE_ACR_PASSWORD',
        sensitive: true
    },
    azureStorageAccountName: {
        format: String,
        default: '',
        env: 'AZURE_STORAGE_ACCOUNT_NAME'
    },
    azureStorageAccountKey: {
        format: String,
        default: '',
        env: 'AZURE_STORAGE_ACCOUNT_KEY',
        sensitive: true
    },
    workspaceAzureFilesStorageAccountName: {
        format: String,
        default: '',
        env: 'WORKSPACE_AZURE_FILES_STORAGE_ACCOUNT_NAME'
    },
    workspaceAzureFilesStorageAccountKey: {
        format: String,
        default: '',
        env: 'WORKSPACE_AZURE_FILES_STORAGE_ACCOUNT_KEY',
        sensitive: true
    },
    azureBlobContainerName: {
        format: String,
        default: '',
        env: 'AZURE_BLOB_CONTAINER_NAME',
        doc: 'Azure Blob container for user files (blob mount in ACI workspaces)'
    },
});

// Read in environment variables and set up service configuration
const configFile = config.get('cortexConfigFile');

//Save default entity constants
const defaultEntityConstants = config.get('entityConstants');

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

// Merge default entity constants with config entity constants
if (config.get('entityConstants') && defaultEntityConstants) {
    config.set('entityConstants', { ...defaultEntityConstants, ...config.get('entityConstants') });
}

if (config.get('gcpServiceAccountKey')) {
    const gcpAuthTokenHelper = new GcpAuthTokenHelper(config.getProperties());
    config.set('gcpAuthTokenHelper', gcpAuthTokenHelper);
}

if (config.get('azureServicePrincipalCredentials')) {
    const azureAuthTokenHelper = new AzureAuthTokenHelper(config.getProperties());
    config.set('azureAuthTokenHelper', azureAuthTokenHelper);
}

// Load dynamic pathways from JSON file or cloud storage
const createDynamicPathwayManager = async (config, basePathway) => {
    const { dynamicPathwayConfig } = config.getProperties();

    if (!dynamicPathwayConfig) {
        return null;
    }

    const storageConfig = {
        storageType: dynamicPathwayConfig.storageType || 'local',
        filePath: dynamicPathwayConfig.filePath || "./dynamic/pathways.json",
        azureStorageConnectionString: dynamicPathwayConfig.azureStorageConnectionString,
        azureContainerName: dynamicPathwayConfig.azureContainerName || 'cortexdynamicpathways',
        awsAccessKeyId: dynamicPathwayConfig.awsAccessKeyId,
        awsSecretAccessKey: dynamicPathwayConfig.awsSecretAccessKey,
        awsRegion: dynamicPathwayConfig.awsRegion,
        awsBucketName: dynamicPathwayConfig.awsBucketName || 'cortexdynamicpathways',
        publishKey: dynamicPathwayConfig.publishKey,
    };

    const pathwayManager = new PathwayManager(storageConfig, basePathway);

    try {
        const dynamicPathways = await pathwayManager.initialize();
        logger.info(`Dynamic pathways loaded successfully`);
        logger.info(`Loaded dynamic pathways for users: [${Object.keys(dynamicPathways).join(", ")}]`);

        return pathwayManager;
    } catch (error) {
        logger.error(`Error loading dynamic pathways: ${error.message}`);
        return pathwayManager;
    }
};

// Build and load pathways to config
const buildPathways = async (config) => {
    const { pathwaysPath, corePathwaysPath, basePathwayPath } = config.getProperties();

    const basePathwayURL = pathToFileURL(basePathwayPath).toString();

    // Load cortex base pathway
    const basePathway = await import(basePathwayURL).then(module => module.default);

    // Helper function to recursively load pathway files
    const loadPathwaysFromDir = async (dirPath) => {
        const pathways = {};
        try {
            const files = await readdir(dirPath, { withFileTypes: true });

            for (const file of files) {
                const fullPath = path.join(dirPath, file.name);
                if (file.isDirectory()) {
                    // Skip the shared directory
                    if (file.name === 'shared') continue;

                    // Recursively load pathways from other subdirectories
                    const subPathways = await loadPathwaysFromDir(fullPath);
                    Object.assign(pathways, subPathways);
                } else if (file.name.endsWith('.js')) {
                    // Load individual pathway file
                    try {
                        const pathwayURL = pathToFileURL(fullPath).toString();
                        const pathway = await import(pathwayURL).then(module => module.default || module);
                        const pathwayName = path.basename(file.name, '.js');
                        pathways[pathwayName] = pathway;
                    } catch (pathwayError) {
                        logger.error(`Error loading pathway file ${fullPath}: ${pathwayError.message}`);
                        throw pathwayError; // Re-throw to be caught by outer catch block
                    }
                }
            }
        } catch (error) {
            logger.error(`Error loading pathways from ${dirPath}: ${error.message}`);
        }
        return pathways;
    };

    // Load core pathways
    logger.info(`Loading core pathways from ${corePathwaysPath}`);
    let loadedPathways = await loadPathwaysFromDir(corePathwaysPath);

    // Load custom pathways and override core pathways if same
    if (pathwaysPath && fs.existsSync(pathwaysPath)) {
        logger.info(`Loading custom pathways from ${pathwaysPath}`);
        const customPathways = await loadPathwaysFromDir(pathwaysPath);
        loadedPathways = { ...loadedPathways, ...customPathways };
    }

    const { DYNAMIC_PATHWAYS_CONFIG_FILE, DYNAMIC_PATHWAYS_CONFIG_JSON } = process.env;

    let dynamicPathwayConfig;

    // Load dynamic pathways
    let pathwayManager;
    try {
        if (DYNAMIC_PATHWAYS_CONFIG_FILE) {
            logger.info(`Reading dynamic pathway config from ${DYNAMIC_PATHWAYS_CONFIG_FILE}`);
            dynamicPathwayConfig = JSON.parse(fs.readFileSync(DYNAMIC_PATHWAYS_CONFIG_FILE, 'utf8'));
        } else if (DYNAMIC_PATHWAYS_CONFIG_JSON) {
            logger.info(`Reading dynamic pathway config from DYNAMIC_PATHWAYS_CONFIG_JSON variable`);
            dynamicPathwayConfig = JSON.parse(DYNAMIC_PATHWAYS_CONFIG_JSON);
        }
        else {
            logger.warn('Dynamic pathways are not enabled. Please set the DYNAMIC_PATHWAYS_CONFIG_FILE or DYNAMIC_PATHWAYS_CONFIG_JSON environment variable to enable dynamic pathways.');
        }

        config.load({ dynamicPathwayConfig });
        pathwayManager = await createDynamicPathwayManager(config, basePathway);
    } catch (error) {
        logger.error(`Error loading dynamic pathways: ${error.message}`);
        process.exit(1);
    }

    // Generate REST streaming pathways from model configs
    const generateRestStreamingPathways = (models) => {
        const restPathways = {};
        
        for (const [modelName, modelConfig] of Object.entries(models || {})) {
            if (!modelConfig) continue;
            
            // Check for chat model emulation
            if (modelConfig.emulateOpenAIChatModel) {
                const pathwayName = `sys_rest_streaming_${modelName.replace(/-/g, '_')}`;
                const restConfig = modelConfig.restStreaming || {};
                
                // Default input parameters for OpenAI-compatible chat models.
                const defaultInputParams = {
                    messages: [{role: '', content: []}],
                    responses_input_json: '',
                    tools: '',
                    tool_choice: 'auto',
                    functions: '',
                    reasoningEffort: '',
                    thinkingType: { type: 'string' },
                    thinkingBudgetTokens: { type: 'integer' }
                };
                
                // Merge with any custom input parameters
                const inputParameters = restConfig.inputParameters 
                    ? { ...defaultInputParams, ...restConfig.inputParameters }
                    : defaultInputParams;
                
                // OpenAI chat-style models support functions in REST emulation.
                if (modelName.startsWith('oai-')) {
                    inputParameters.functions = '';
                }
                
                restPathways[pathwayName] = {
                    prompt: [
                        new Prompt({ messages: ["{{messages}}"] })
                    ],
                    inputParameters,
                    model: modelName,
                    useInputChunking: false,
                    emulateOpenAIChatModel: modelConfig.emulateOpenAIChatModel,
                    ...(restConfig.geminiSafetySettings && { geminiSafetySettings: restConfig.geminiSafetySettings }),
                    ...(restConfig.timeout && { timeout: restConfig.timeout })
                };
            }
            
            // Check for completion model emulation
            if (modelConfig.emulateOpenAICompletionModel) {
                const pathwayName = `sys_rest_streaming_${modelName.replace(/-/g, '_')}_completion`;
                const restConfig = modelConfig.restStreaming || {};
                
                restPathways[pathwayName] = {
                    prompt: `{{text}}`,
                    inputParameters: restConfig.inputParameters || {
                        text: '',
                        ...(modelName.includes('ollama') && { ollamaModel: '' })
                    },
                    model: modelName,
                    useInputChunking: false,
                    emulateOpenAICompletionModel: modelConfig.emulateOpenAICompletionModel,
                    ...(restConfig.timeout && { timeout: restConfig.timeout })
                };
            }
        }
        
        return restPathways;
    };
    
    // Generate REST streaming pathways from models
    const models = config.get('models');
    const generatedRestPathways = models ? generateRestStreamingPathways(models) : {};
    
    if (Object.keys(generatedRestPathways).length > 0) {
        logger.info(`Generated ${Object.keys(generatedRestPathways).length} REST streaming pathways from model configs`);
    }
    
    // Merge generated pathways into loaded pathways (they can be overridden by file-based pathways)
    Object.assign(loadedPathways, generatedRestPathways);
    
    // This is where we integrate pathway overrides from the config
    // file. This can run into a partial definition issue if the
    // config file contains pathways that no longer exist.
    const pathways = config.get('pathways');
    const entityTools = {};

    for (const [key, def] of Object.entries(loadedPathways)) {
        const pathway = { ...basePathway, name: key, objName: key.charAt(0).toUpperCase() + key.slice(1), ...def, ...pathways[key] };
        pathways[def.name || key] = pathways[key] = pathway;

        // Register tool if the pathway has a toolDefinition and it's not empty
        if (pathway.toolDefinition && (
            (Array.isArray(pathway.toolDefinition) && pathway.toolDefinition.length > 0) ||
            (!Array.isArray(pathway.toolDefinition) && Object.keys(pathway.toolDefinition).length > 0)
        )) {
            try {
                // Convert single tool definition to array for consistent processing
                const toolDefinitions = Array.isArray(pathway.toolDefinition)
                    ? pathway.toolDefinition
                    : [pathway.toolDefinition];

                for (const toolDef of toolDefinitions) {
                    // Validate tool definition format
                    if (!toolDef.type || !toolDef.function) {
                        logger.warn(`Invalid tool definition in pathway ${key} - missing required fields`);
                        continue;
                    }

                    // Skip tool if explicitly disabled
                    if (toolDef.enabled === false) {
                        logger.info(`Skipping disabled tool in pathway ${key}`);
                        continue;
                    }

                    const { description, parameters } = toolDef.function;
                    const name = toolDef.function.name.toLowerCase();

                    if (!name || !description || !parameters) {
                        logger.warn(`Invalid tool definition in pathway ${key} - missing required function fields`);
                        continue;
                    }

                    // Check for duplicate function names
                    if (entityTools[name]) {
                        logger.warn(`Duplicate tool name ${name} found in pathway ${key} - skipping. Original tool defined in pathway ${entityTools[name].pathwayName}`);
                        continue;
                    }

                    // Add tool to entityTools registry
                    entityTools[name] = {
                        definition: toolDef,
                        pathwayName: key,
                        ...(pathway.timeout && { timeout: pathway.timeout * 1000 }), // pathway timeout (seconds → ms)
                    };

                    logger.info(`Registered tool ${name} from pathway ${key}`);
                }
            } catch (error) {
                logger.error(`Error registering tool from pathway ${key}: ${error.message}`);
            }
        }
    }

    // Add pathways and entityTools to config
    config.load({ pathways, entityTools });

    return { pathwayManager, pathways };
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
