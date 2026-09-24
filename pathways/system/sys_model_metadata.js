import { config } from '../../config.js';
import { getModelGroup } from '../../lib/modelGroups.js';

// Map plugin type prefixes to provider names
const TYPE_TO_PROVIDER = {
    'OPENAI': 'openai',
    'GEMINI': 'google',
    'CLAUDE': 'anthropic',
    'GROK': 'xai',
    'KIMI': 'moonshot',
    'REPLICATE': 'replicate',
    'VEO': 'google',
};

// Map plugin type prefixes to categories
const TYPE_TO_CATEGORY = {
    'REPLICATE': 'image',
    'VEO': 'video',
    'OPENAI-DALLE': 'image',
    'GEMINI-MUSIC': 'audio',
    'GEMINI-TTS': 'tts',
};

// Fields safe to expose from model config
const SAFE_FIELDS = [
    'type',
    'maxTokenLength',
    'maxReturnTokens',
    'maxImageSize',
    'supportsStreaming',
    'emulateOpenAIChatModel',
];

export function inferProvider(type) {
    if (!type) return undefined;
    for (const [prefix, provider] of Object.entries(TYPE_TO_PROVIDER)) {
        if (type.startsWith(prefix)) return provider;
    }
    return undefined;
}

export function inferCategory(type) {
    if (!type) return 'chat';
    for (const [prefix, category] of Object.entries(TYPE_TO_CATEGORY)) {
        if (type.startsWith(prefix)) return category;
    }
    return 'chat';
}

export function getPricingAliases(sourceConfig) {
    const aliases = new Set();
    const addAlias = (value) => {
        if (typeof value === 'string' && value.trim()) aliases.add(value);
    };

    addAlias(sourceConfig?.params?.model);

    for (const endpoint of sourceConfig?.endpoints || []) {
        addAlias(endpoint?.params?.model);
    }

    aliases.delete(sourceConfig?.emulateOpenAIChatModel);
    aliases.delete(sourceConfig?.emulateOpenAICompletionModel);

    return [...aliases];
}

export function buildMetadataEntry(modelId, sourceConfig, { isModelGroup = false } = {}) {
    const metadata = sourceConfig?.metadata;
    if (!metadata?.displayName) return null;

    const type = sourceConfig.type || '';
    const category = metadata.category || inferCategory(type);
    const entry = {
        modelId,
        displayName: metadata.displayName,
        provider: metadata.provider || inferProvider(type),
        category,
    };

    if (metadata.isDeprecated) entry.isDeprecated = true;
    if (metadata.replacementModel) entry.replacementModel = metadata.replacementModel;
    if (metadata.isDefault) entry.isDefault = true;
    if (metadata.isAgentic) entry.isAgentic = true;
    if (metadata.releaseStage) entry.releaseStage = metadata.releaseStage;
    if (metadata.isAvailable === false) {
        entry.isAvailable = false;
        entry.unavailableReason = metadata.unavailableReason || "Model is not available";
    }
    if (isModelGroup) entry.isModelGroup = true;

    // Copy safe fields from the config object.
    for (const field of SAFE_FIELDS) {
        if (sourceConfig[field] !== undefined) {
            entry[field] = sourceConfig[field];
        }
    }

    // Copy media-specific fields
    if (metadata.pathwayName) entry.pathwayName = metadata.pathwayName;
    if (metadata.resultKey) entry.resultKey = metadata.resultKey;
    if (metadata.mediaDefaults) entry.mediaDefaults = metadata.mediaDefaults;
    if (metadata.mediaDefaultOverrides) entry.mediaDefaultOverrides = metadata.mediaDefaultOverrides;
    if (metadata.availableAspectRatios) entry.availableAspectRatios = metadata.availableAspectRatios;
    if (metadata.availableDurations) entry.availableDurations = metadata.availableDurations;
    if (metadata.availableOutputFormats) entry.availableOutputFormats = metadata.availableOutputFormats;
    if (metadata.mediaControls) entry.mediaControls = metadata.mediaControls;
    if (metadata.referenceImageRoles) entry.referenceImageRoles = metadata.referenceImageRoles;
    if (metadata.referenceImageRoleLimits) entry.referenceImageRoleLimits = metadata.referenceImageRoleLimits;
    if (metadata.videoFrameReferenceRoles) entry.videoFrameReferenceRoles = metadata.videoFrameReferenceRoles;
    if (metadata.videoInputModes) entry.videoInputModes = metadata.videoInputModes;
    if (metadata.mediaInputModes) entry.mediaInputModes = metadata.mediaInputModes;
    if (metadata.preferredUrlFormat) entry.preferredUrlFormat = metadata.preferredUrlFormat;
    if (metadata.mediaToggles) entry.mediaToggles = metadata.mediaToggles;
    if (metadata.availableResolutions) entry.availableResolutions = metadata.availableResolutions;
    if (metadata.availableImageSizes) entry.availableImageSizes = metadata.availableImageSizes;
    if (metadata.availableVoices) entry.availableVoices = metadata.availableVoices;
    if (metadata.availableLanguages) entry.availableLanguages = metadata.availableLanguages;
    if (metadata.supportedReasoningEfforts) entry.supportedReasoningEfforts = metadata.supportedReasoningEfforts;
    if (metadata.requiredEnv) {
        entry.requiredEnv = metadata.requiredEnv;
        const requirements = [metadata.requiredEnv].flat();
        const missing = requirements.filter(env => {
            const configKey = { GCP_SERVICE_ACCOUNT_KEY: "gcpServiceAccountKey", GEMINI_API_KEY: "geminiApiKey" }[env];
            return !(configKey ? config.get(configKey) : process.env[env]);
        });
        if (missing.length && entry.isAvailable !== false) {
            entry.isAvailable = false;
            entry.unavailableReason = `${missing.join(", ")} is not configured`;
        }
    }

    if (metadata.pricing) entry.pricing = metadata.pricing;

    const pricingAliases = metadata.pricing ? getPricingAliases(sourceConfig) : [];
    if (pricingAliases.length > 0) entry.pricingAliases = pricingAliases;

    return entry;
}

export default {
    prompt: [],
    inputParameters: {
        category: '',
    },
    model: 'oai-gpt54-mini',
    executePathway: async ({ args }) => {
        try {
            const allModels = config.get('models');
            const allModelGroups = config.get('modelGroups') || {};
            const redirects = config.get('modelRedirects') || {};
            const categoryFilter = args.category || '';

            const models = [];

            for (const [modelId, groupConfig] of Object.entries(allModelGroups)) {
                const entry = buildMetadataEntry(modelId, getModelGroup(groupConfig), { isModelGroup: true });
                if (!entry) continue;
                if (categoryFilter && entry.category !== categoryFilter) continue;
                models.push(entry);
            }

            for (const [modelId, modelConfig] of Object.entries(allModels)) {
                if (redirects[modelId]) continue;
                const entry = buildMetadataEntry(modelId, modelConfig);
                if (!entry) continue;
                if (categoryFilter && entry.category !== categoryFilter) continue;
                models.push(entry);
            }

            // Hide superseded choices only when their replacement is configured.
            // Keep their metadata and execution IDs for history and existing jobs.
            for (const entry of models) {
                const replacementId = allModels[entry.modelId]?.metadata?.deprecatedWhenAvailable;
                const replacement = models.find(model => model.modelId === replacementId);
                if (replacement && replacement.isAvailable !== false) {
                    entry.isDeprecated = true;
                    entry.replacementModel = replacementId;
                }
            }
            return JSON.stringify({ models, redirects });
        } catch (error) {
            return JSON.stringify({ error: error.message });
        }
    },
    json: true,
    manageTokenLength: false,
};
