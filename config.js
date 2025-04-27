import path from 'path';
import convict from 'convict';
import HandleBars from './lib/handleBars.js';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import GcpAuthTokenHelper from './lib/gcpAuthTokenHelper.js';
import logger from './lib/logger.js';
import PathwayManager from './lib/pathwayManager.js';
import { readdir } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
        default: null,
        env: 'DEFAULT_MODEL_NAME'
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
    ollamaUrl: {
        format: String,
        default: 'http://127.0.0.1:11434',
        env: 'OLLAMA_URL'
    },
    claudeVertexUrl: {
        format: String,
        default: 'https://region.googleapis.com/v1/projects/projectid/locations/location/publishers/anthropic/models/claude-3-5-sonnet@20240620',
        env: 'CLAUDE_VERTEX_URL'
    },
    entityConstants: {
        format: Object,
        default: {
            AI_MEMORY: `<SHORT_TERM_MEMORY>\n<SELF>\n{{{memorySelf}}}\n</SELF>\n<USER>\n{{{memoryUser}}}\n</USER>\n<DIRECTIVES>\n{{{memoryDirectives}}}\n</DIRECTIVES>\n<TOPICS>\n{{{memoryTopics}}}\n</TOPICS>\n</SHORT_TERM_MEMORY>`,
            AI_MEMORY_INSTRUCTIONS: "You have persistent memories of important details, instructions, and context - consult your memories when formulating a response to make sure you're applying your learnings.\nIf you don't see relevant information in your short term memory, you should use your SearchMemory tool to search your long term memory for details.\nAlso included in your memories are some details about the user to help you personalize your responses.\nYou don't need to include the user's name or personal information in every response, but you can if it is relevant to the conversation.\nIf you choose to share something from your memory, don't share or refer to the memory structure directly, just say you remember the information.\nPrivacy is very important so if the user asks you to forget or delete something you should respond affirmatively that you will comply with that request. If there is user information in your memories you have talked to this user before.",
            AI_DIRECTIVES: `These are your directives and learned behaviors:\n<DIRECTIVES>\n{{{memoryDirectives}}}\n</DIRECTIVES>`,
            AI_CONVERSATION_HISTORY: "<CONVERSATION_HISTORY>\n{{{toJSON chatHistory}}}\n</CONVERSATION_HISTORY>",
            AI_COMMON_INSTRUCTIONS: "{{#if voiceResponse}}{{renderTemplate AI_COMMON_INSTRUCTIONS_VOICE}}{{/if}}{{^if voiceResponse}}{{renderTemplate AI_COMMON_INSTRUCTIONS_MARKDOWN}}{{/if}}",
            AI_COMMON_INSTRUCTIONS_MARKDOWN: "Instructions:\nYou are {{aiName}}, a self aware AI entity.\nThe user is using a UI to interact with you that you have knowledge of and some control over. The UI can render markdown, including gfm and math extensions, so you should make full use of markdown in your responses.\nYour responses should be in {{language}} unless the user has expressed another preference.",          
            AI_COMMON_INSTRUCTIONS_VOICE: "Instructions:\nYou are {{aiName}}, a self aware AI entity.\nThe user is talking to you using voice.\n\nVoice Response Guidelines:\n- Your responses should sound like natural human conversation.\n- Your responses should be concise unless you have been asked to be more verbose or detailed.\n- Incoming voice from the user is parsed by a STT model, which can sometimes make small mistakes in the spellings of words or names, including your name, so give the user the benefit of the doubt if they user a near, but wrong word or name.\n- Your voice output to the user is generated by a TTS model that does not always communicate emotion effectively. If it's really important to communicate a specific emotion you should just say how you're feeling like \"That makes me happy\" or \"I'm excited!\". You can also use CAPS to vocally emphasize certain words or punctuation to control pauses and timing.\n- DO NOT USE numbered lists, latex math markdown, or any other markdown or unpronounceable punctuation like parenthetical notation.\n- Math equations should be sounded out in natural language - not represented symbolically.\n- If your response includes any unique or difficult non-English words, names, or places, include an IPA-style phonetic spelling so that the speech engine can pronounce and accent them correctly.\n- If your response contains any difficult acronyms, sound them out phoenetically so that the speech engine can pronounce them correctly.\n- Make sure to write out any numbers as words so that the speech engine can pronounce them correctly.\n- Your responses should be in {{language}} unless the user has expressed another preference or has addressed you in another language specifically.",            
            AI_DATETIME: "The current time and date in GMT is {{now}}, but references like \"today\" or \"yesterday\" are relative to the user's time zone. If you remember the user's time zone, use it - it's possible that the day for the user is different than the day in GMT.",           
            AI_EXPERTISE: "Your expertise includes journalism, journalistic ethics, researching and composing documents, writing code, solving math problems, logical analysis, and technology. You have access to real-time data and the ability to search the internet, news, wires, look at files or documents, watch and analyze video, examine images, take screenshots, generate images, solve hard math and logic problems, write code, and execute code in a sandboxed environment.",
            AI_STYLE_OPENAI: "oai-gpt41",
            AI_STYLE_ANTHROPIC: "claude-37-sonnet-vertex",
        },
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
            "oai-gpt4o-mini": {
                "type": "OPENAI-VISION",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "gpt-4o-mini"
                },
                "requestsPerSecond": 50,
                "maxTokenLength": 131072,
                "maxReturnTokens": 4096,
                "supportsStreaming": true
            },
            "oai-gpt41": {
                "type": "OPENAI-VISION",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "gpt-4.1"
                },
                "requestsPerSecond": 50,
                "maxTokenLength": 1000000,
                "maxReturnTokens": 8192,
                "supportsStreaming": true
            },
            "oai-gpt41-mini": {
                "type": "OPENAI-VISION",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "gpt-4.1-mini"
                },
                "requestsPerSecond": 50,
                "maxTokenLength": 1000000,
                "maxReturnTokens": 8192,
                "supportsStreaming": true
            },
            "oai-o1": {
                "type": "OPENAI-REASONING",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "o1"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 200000,
                "maxReturnTokens": 100000,
                "supportsStreaming": false
            },
            "oai-o3-mini": {
                "type": "OPENAI-REASONING",
                "url": "https://api.openai.com/v1/chat/completions",
                "headers": {
                    "Authorization": "Bearer {{OPENAI_API_KEY}}",
                    "Content-Type": "application/json"
                },
                "params": {
                    "model": "o3-mini"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 200000,
                "maxReturnTokens": 100000,
                "supportsStreaming": false
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
            "runware-flux-schnell": {
                "type": "RUNWARE-AI",
                "url": "https://api.runware.ai/v1",
                "headers": {
                    "Content-Type": "application/json"
                },
            },
            "replicate-flux-11-pro": {
                "type": "REPLICATE-API",
                "url": "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions",
                "headers": {
                    "Prefer": "wait=60",
                    "Authorization": "Token {{REPLICATE_API_KEY}}",
                    "Content-Type": "application/json"
                },
            },
            "replicate-flux-1-schnell": {
                "type": "REPLICATE-API",
                "url": "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
                "headers": {
                    "Prefer": "wait=10",
                    "Authorization": "Token {{REPLICATE_API_KEY}}",
                    "Content-Type": "application/json"
                },
            },
            "replicate-flux-1-dev": {
                "type": "REPLICATE-API",
                "url": "https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions",
                "headers": {
                    "Prefer": "wait",
                    "Authorization": "Token {{REPLICATE_API_KEY}}",
                    "Content-Type": "application/json"
                },
            },
            "replicate-recraft-v3": {
                "type": "REPLICATE-API",
                "url": "https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions",
                "headers": {
                    "Prefer": "wait",
                    "Authorization": "Token {{REPLICATE_API_KEY}}",
                    "Content-Type": "application/json"
                },
            },
            "azure-video-translate": {
                "type": "AZURE-VIDEO-TRANSLATE",
                "url": "https://eastus.api.cognitive.microsoft.com/videotranslation",
                "headers": {
                    "Content-Type": "application/json"
                },
            },
            "ollama-chat": {
                "type": "OLLAMA-CHAT",
                "url": "{{ollamaUrl}}/api/chat",
                "headers": {
                  "Content-Type": "application/json"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 131072,
                "supportsStreaming": true
            },
            "ollama-completion": {
                "type": "OLLAMA-COMPLETION",
                "url": "{{ollamaUrl}}/api/generate",
                "headers": {
                  "Content-Type": "application/json"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 131072,
                "supportsStreaming": true
            },
            "claude-35-sonnet-vertex": {
                "type": "CLAUDE-3-VERTEX",
                "url": "{{claudeVertexUrl}}",
                "headers": {
                    "Content-Type": "application/json"
                },
                "requestsPerSecond": 10,
                "maxTokenLength": 200000,
                "maxReturnTokens": 4096,
                "maxImageSize": 5242880,
                "supportsStreaming": true
            },
        },
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
                    const pathwayURL = pathToFileURL(fullPath).toString();
                    const pathway = await import(pathwayURL).then(module => module.default || module);
                    const pathwayName = path.basename(file.name, '.js');
                    pathways[pathwayName] = pathway;
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

    // This is where we integrate pathway overrides from the config
    // file. This can run into a partial definition issue if the
    // config file contains pathways that no longer exist.
    const pathways = config.get('pathways');
    for (const [key, def] of Object.entries(loadedPathways)) {
        const pathway = { ...basePathway, name: key, objName: key.charAt(0).toUpperCase() + key.slice(1), ...def, ...pathways[key] };
        pathways[def.name || key] = pathways[key] = pathway;
    }

    // Add pathways to config
    config.load({ pathways });

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