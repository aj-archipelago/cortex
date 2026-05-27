import test from 'ava';
import sysModelMetadata, {
    buildMetadataEntry,
    getPricingAliases,
    inferCategory,
    inferProvider,
} from '../../../pathways/system/sys_model_metadata.js';

test('inferProvider maps known model type prefixes', (t) => {
    t.is(inferProvider('OPENAI-RESPONSES'), 'openai');
    t.is(inferProvider('GEMINI-3-REASONING-VISION'), 'google');
    t.is(inferProvider('CLAUDE-4-VERTEX'), 'anthropic');
    t.is(inferProvider('GROK-VISION'), 'xai');
    t.is(inferProvider('REPLICATE-IMAGE'), 'replicate');
    t.is(inferProvider('VEO-VIDEO'), 'google');
    t.is(inferProvider('LOCAL-CPP-MODEL'), undefined);
});

test('inferCategory maps media types and defaults to chat', (t) => {
    t.is(inferCategory('REPLICATE-IMAGE'), 'image');
    t.is(inferCategory('VEO-VIDEO'), 'video');
    t.is(inferCategory('OPENAI-DALLE3'), 'image');
    t.is(inferCategory('GEMINI-MUSIC'), 'audio');
    t.is(inferCategory('GEMINI-TTS'), 'tts');
    t.is(inferCategory('OPENAI-RESPONSES'), 'chat');
    t.is(inferCategory(''), 'chat');
});

test('getPricingAliases exposes provider model names without emulation aliases', (t) => {
    const aliases = getPricingAliases({
        emulateOpenAIChatModel: 'public-chat-alias',
        emulateOpenAICompletionModel: 'public-completion-alias',
        params: { model: 'provider-default' },
        endpoints: [
            { params: { model: 'provider-east' } },
            { params: { model: 'public-chat-alias' } },
            { params: { model: '' } },
        ],
    });

    t.deepEqual(aliases, ['provider-default', 'provider-east']);
});

test('buildMetadataEntry returns null when display metadata is absent', (t) => {
    t.is(buildMetadataEntry('hidden-model', { type: 'OPENAI-CHAT' }), null);
});

test('buildMetadataEntry exposes safe model and media metadata', (t) => {
    const entry = buildMetadataEntry('model-a', {
        type: 'VEO-VIDEO',
        maxTokenLength: 1000,
        maxReturnTokens: 200,
        supportsStreaming: true,
        requestsPerSecond: 10,
        url: 'https://provider.example',
        headers: { Authorization: 'secret' },
        params: { model: 'veo-provider-name' },
        metadata: {
            displayName: 'Veo Test',
            provider: 'google',
            category: 'video',
            isDefault: true,
            isAgentic: true,
            pathwayName: 'video_veo',
            resultKey: 'video_veo',
            mediaDefaults: { inputVideos: [0, 1] },
            availableAspectRatios: ['16:9'],
            availableDurations: [8],
            videoInputModes: ['extend'],
            preferredUrlFormat: 'gcs',
            pricing: { input: 1 },
        },
    });

    t.like(entry, {
        modelId: 'model-a',
        displayName: 'Veo Test',
        provider: 'google',
        category: 'video',
        isDefault: true,
        isAgentic: true,
        type: 'VEO-VIDEO',
        maxTokenLength: 1000,
        maxReturnTokens: 200,
        supportsStreaming: true,
        pathwayName: 'video_veo',
        resultKey: 'video_veo',
        mediaDefaults: { inputVideos: [0, 1] },
        availableAspectRatios: ['16:9'],
        availableDurations: [8],
        videoInputModes: ['extend'],
        preferredUrlFormat: 'gcs',
        pricing: { input: 1 },
    });
    t.deepEqual(entry.pricingAliases, ['veo-provider-name']);
    t.is(entry.requestsPerSecond, undefined);
    t.is(entry.url, undefined);
    t.is(entry.headers, undefined);
    t.is(entry.params, undefined);
});

test('buildMetadataEntry exposes media UI control metadata without provider config', (t) => {
    const entry = buildMetadataEntry('media-model', {
        type: 'REPLICATE-IMAGE',
        requestsPerSecond: 20,
        endpoints: [
            {
                url: 'https://provider.example/private',
                headers: { Authorization: 'secret' },
                params: { model: 'provider-media-model' },
            },
        ],
        metadata: {
            displayName: 'Media Model',
            pathwayName: 'image_media',
            resultKey: 'image_media',
            mediaDefaults: {
                inputImages: [0, 3],
                aspectRatio: '16:9',
                imageSize: '2K',
            },
            mediaDefaultOverrides: {
                imageSize: { '1:1': '1K' },
            },
            availableAspectRatios: ['1:1', '16:9'],
            availableDurations: [5, 10],
            availableOutputFormats: ['png', 'jpeg'],
            mediaControls: ['quality', 'seed'],
            referenceImageRoles: ['subject', 'style'],
            referenceImageRoleLimits: { subject: 1, style: 2 },
            videoFrameReferenceRoles: ['start_frame', 'end_frame'],
            videoInputModes: ['generate', 'extend'],
            preferredUrlFormat: 'gcs',
            mediaToggles: ['optimizePrompt'],
            availableResolutions: ['720p', '1080p'],
            availableImageSizes: ['1K', '2K'],
            availableVoices: ['Kore', 'Puck'],
            availableLanguages: ['en-US', 'ar-AR'],
            supportedReasoningEfforts: ['none', 'low'],
            pricing: { image: 0.01 },
        },
    });

    t.like(entry, {
        modelId: 'media-model',
        displayName: 'Media Model',
        provider: 'replicate',
        category: 'image',
        pathwayName: 'image_media',
        resultKey: 'image_media',
        mediaDefaults: {
            inputImages: [0, 3],
            aspectRatio: '16:9',
            imageSize: '2K',
        },
        mediaDefaultOverrides: {
            imageSize: { '1:1': '1K' },
        },
        availableAspectRatios: ['1:1', '16:9'],
        availableDurations: [5, 10],
        availableOutputFormats: ['png', 'jpeg'],
        mediaControls: ['quality', 'seed'],
        referenceImageRoles: ['subject', 'style'],
        referenceImageRoleLimits: { subject: 1, style: 2 },
        videoFrameReferenceRoles: ['start_frame', 'end_frame'],
        videoInputModes: ['generate', 'extend'],
        preferredUrlFormat: 'gcs',
        mediaToggles: ['optimizePrompt'],
        availableResolutions: ['720p', '1080p'],
        availableImageSizes: ['1K', '2K'],
        availableVoices: ['Kore', 'Puck'],
        availableLanguages: ['en-US', 'ar-AR'],
        supportedReasoningEfforts: ['none', 'low'],
        pricing: { image: 0.01 },
    });
    t.deepEqual(entry.pricingAliases, ['provider-media-model']);
    t.is(entry.requestsPerSecond, undefined);
    t.is(entry.endpoints, undefined);
    t.is(entry.headers, undefined);
    t.is(entry.url, undefined);
    t.is(entry.params, undefined);
});

test('buildMetadataEntry marks unavailable required environment values', (t) => {
    const previous = process.env.TEST_REQUIRED_ENV;
    delete process.env.TEST_REQUIRED_ENV;

    const entry = buildMetadataEntry('env-model', {
        type: 'REPLICATE-IMAGE',
        metadata: {
            displayName: 'Env Model',
            requiredEnv: 'TEST_REQUIRED_ENV',
        },
    });

    t.is(entry.requiredEnv, 'TEST_REQUIRED_ENV');
    t.false(entry.isAvailable);
    t.is(entry.unavailableReason, 'TEST_REQUIRED_ENV is not configured');

    if (previous === undefined) {
        delete process.env.TEST_REQUIRED_ENV;
    } else {
        process.env.TEST_REQUIRED_ENV = previous;
    }
});

test('buildMetadataEntry marks model groups', (t) => {
    const entry = buildMetadataEntry('group-a', {
        members: ['model-a'],
        metadata: {
            displayName: 'Group A',
            provider: 'cortex',
            category: 'chat',
        },
    }, { isModelGroup: true });

    t.true(entry.isModelGroup);
    t.is(entry.modelId, 'group-a');
});

test('sys_model_metadata pathway keeps JSON response configuration', (t) => {
    t.true(sysModelMetadata.json);
    t.false(sysModelMetadata.manageTokenLength);
    t.deepEqual(sysModelMetadata.inputParameters, { category: '' });
});
