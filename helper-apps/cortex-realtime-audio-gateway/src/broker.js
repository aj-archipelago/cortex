import crypto from 'crypto';
import Redis from 'ioredis';
import WebSocket, { WebSocketServer } from 'ws';

const DEFAULT_REALTIME_PATH = '/openai/v1/realtime';
const DEFAULT_TRANSLATE_PATH = '/openai/v1/realtime/translations';
const REALTIME_AUDIO_PATH = '/realtime-audio';
const DEFAULT_TRANSLATE_DEPLOYMENT = 'gpt-realtime-translate';
const DEFAULT_WHISPER_DEPLOYMENT = 'gpt-realtime-whisper';
const DEFAULT_CONVERSATION_DEPLOYMENT = 'gpt-realtime-2.1';
const DEFAULT_TARGET_LANGUAGE = 'ar';
const GENERIC_BROKER_AUDIENCE = 'concierge-realtime-audio';
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_SERVER_ERROR = 1011;
const MAX_PENDING_MESSAGES = 200;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_AZURE_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const MAX_CLIENT_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const DEFAULT_MAX_SESSION_MS = 10 * 60 * 1000;
const DEFAULT_TRANSLATION_DRAIN_MS = 1000;
const DEFAULT_CONVERSATION_DRAIN_MS = 15000;
const DEFAULT_SESSION_ACK_TIMEOUT_MS = 12000;
const DEFAULT_AZURE_HANDSHAKE_TIMEOUT_MS = 12000;
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MAX_PENDING_AUTH = 256;
const DEFAULT_MAX_ACTIVE_SESSIONS = 1000;
const DEFAULT_UPSTREAM_CLOSE_TIMEOUT_MS = 5000;
const DEFAULT_REDIS_TIMEOUT_MS = 1500;
const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 5 * 60;
const DEFAULT_TOKEN_CLOCK_SKEW_SECONDS = 30;
const MAX_USED_BROKER_TOKENS = 10000;
const DEFAULT_CONVERSATION_INSTRUCTIONS =
    "You are Concierge's voice interface. You may answer a greeting or brief conversational acknowledgement directly in one short sentence. For every question or request for information, news, wires, search, analysis, memory, page context, navigation, applets, or an action, call ask_cortex exactly once and never answer from your own knowledge. After the tool returns, speak its answer faithfully in the user's language without adding an introduction, summary, repetition, or conclusion.";
const CORTEX_TOOL_NAME = 'ask_cortex';
const CORTEX_TOOL = Object.freeze({
    type: 'function',
    name: CORTEX_TOOL_NAME,
    description:
        'Ask the authenticated Cortex assistant to answer the user or perform the requested task.',
    parameters: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: 'The user request, preserving important details.',
            },
        },
        required: ['question'],
        additionalProperties: false,
    },
});
const MAX_PENDING_TOOL_CALLS = 8;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_AUDIO_PAYLOAD_CHARS = 1024 * 1024;
// 600 ms of mono PCM16 silence at 24 kHz flushes an abrupt server-VAD turn.
const CONVERSATION_FLUSH_SILENCE = Buffer.alloc(28800).toString('base64');
const TOKEN_CLIENT_MESSAGE_TYPES = new Set([
    'audio',
    'close',
    'interrupt',
    'ping',
    'tool_result',
]);
const usedBrokerTokenIds = new Map();
let replayRedisClient;
let replayRedisUrl;

const CAPABILITIES = Object.freeze({
    translate: Object.freeze({
        audience: 'concierge-realtime-audio-translate',
        defaultEndpointPath: DEFAULT_TRANSLATE_PATH,
        defaultDeployment: DEFAULT_TRANSLATE_DEPLOYMENT,
        audioAppendType: 'session.input_audio_buffer.append',
    }),
    transcribe: Object.freeze({
        audience: 'concierge-realtime-audio-transcribe',
        defaultEndpointPath: DEFAULT_REALTIME_PATH,
        defaultDeployment: DEFAULT_WHISPER_DEPLOYMENT,
        audioAppendType: 'input_audio_buffer.append',
    }),
    converse: Object.freeze({
        audience: 'concierge-realtime-audio-converse',
        defaultEndpointPath: DEFAULT_REALTIME_PATH,
        defaultDeployment: DEFAULT_CONVERSATION_DEPLOYMENT,
        audioAppendType: 'input_audio_buffer.append',
    }),
});

const BROKER_PATH = REALTIME_AUDIO_PATH;

function normalizeLanguage(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const language = value.trim();
    if (!language || language === 'auto') return fallback;
    return /^[a-z]{2,3}(-[A-Z]{2})?$/i.test(language) ? language : fallback;
}

function hasUsableSecret(value) {
    return Boolean(value && !String(value).includes('{{'));
}

function isEnvTrue(value) {
    return String(value || '').toLowerCase() === 'true';
}

function firstValue(...values) {
    return values.map((value) => String(value || '').trim()).find(Boolean);
}

function normalizeAzureEndpoint(value) {
    const endpoint = String(value || '').trim();
    if (!endpoint) return '';
    if (/^https?:\/\//i.test(endpoint)) return endpoint.replace(/\/+$/, '');
    return `https://${endpoint.replace(/\/+$/, '')}.openai.azure.com`;
}

function joinEndpointPath(endpoint, path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${endpoint}${normalizedPath}`;
}

function getAzureRealtimeApiKey(env = process.env) {
    return firstValue(
        env.AZURE_OPENAI_REALTIME_API_KEY,
        env.ARCHIPELAGO_FOUNDRY_RESOURCE_KEY,
        env.AZURE_OPENAI_API_KEY,
    );
}

function getAzureRealtimeEndpoint(env) {
    const configuredEndpoint = normalizeAzureEndpoint(
        env.AZURE_OPENAI_REALTIME_ENDPOINT,
    );
    if (configuredEndpoint) return configuredEndpoint;

    const knownUrl = firstValue(
        env.AZURE_REALTIME_TRANSLATE_URL,
        env.AZURE_OPENAI_REALTIME_TRANSLATE_URL,
        env.AZURE_REALTIME_WHISPER_CLIENT_SECRETS_URL,
        env.AZURE_OPENAI_REALTIME_CLIENT_SECRETS_URL,
    );
    if (!knownUrl) return '';

    try {
        return new URL(knownUrl).origin;
    } catch {
        return '';
    }
}

function getCapabilityEndpoint(capability, env) {
    const definition = CAPABILITIES[capability];
    const explicitUrls = {
        translate: [
            env.AZURE_REALTIME_TRANSLATE_URL,
            env.AZURE_OPENAI_REALTIME_TRANSLATE_URL,
        ],
        transcribe: [
            env.AZURE_REALTIME_TRANSCRIBE_URL,
            env.AZURE_OPENAI_REALTIME_TRANSCRIBE_URL,
        ],
        converse: [
            env.AZURE_REALTIME_CONVERSATION_URL,
            env.AZURE_OPENAI_REALTIME_CONVERSATION_URL,
        ],
    };
    const explicitUrl = firstValue(...explicitUrls[capability]);
    if (explicitUrl) return explicitUrl;

    const endpoint = getAzureRealtimeEndpoint(env);
    if (!endpoint) return '';

    const configuredPaths = {
        translate: firstValue(
            env.AZURE_REALTIME_TRANSLATE_PATH,
            env.AZURE_OPENAI_REALTIME_TRANSLATE_PATH,
        ),
        transcribe: firstValue(
            env.AZURE_REALTIME_TRANSCRIBE_PATH,
            env.AZURE_OPENAI_REALTIME_TRANSCRIBE_PATH,
        ),
        converse: firstValue(
            env.AZURE_REALTIME_CONVERSATION_PATH,
            env.AZURE_OPENAI_REALTIME_CONVERSATION_PATH,
        ),
    };

    return joinEndpointPath(
        endpoint,
        configuredPaths[capability] || definition.defaultEndpointPath,
    );
}

function normalizeRealtimeEndpoint(value) {
    try {
        const url = new URL(value);
        const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
            url.hostname,
        );
        if (
            !(
                ['https:', 'wss:'].includes(url.protocol) ||
                (isLoopback && ['http:', 'ws:'].includes(url.protocol))
            ) ||
            url.hash ||
            url.username ||
            url.password
        )
            return '';
        return url.toString();
    } catch {
        return '';
    }
}

function getCapabilityDeployment(capability, env) {
    if (capability === 'translate') {
        return firstValue(
            env.AZURE_REALTIME_TRANSLATE_DEPLOYMENT,
            env.AZURE_OPENAI_REALTIME_TRANSLATE_DEPLOYMENT,
            CAPABILITIES.translate.defaultDeployment,
        );
    }
    if (capability === 'transcribe') {
        return firstValue(
            env.AZURE_REALTIME_WHISPER_DEPLOYMENT,
            env.AZURE_OPENAI_REALTIME_WHISPER_DEPLOYMENT,
            CAPABILITIES.transcribe.defaultDeployment,
        );
    }
    return firstValue(
        env.AZURE_REALTIME_CONVERSATION_DEPLOYMENT,
        env.AZURE_OPENAI_REALTIME_CONVERSATION_DEPLOYMENT,
        CAPABILITIES.converse.defaultDeployment,
    );
}

function getRealtimeCapabilitySettings({
    env = process.env,
    capability = 'translate',
} = {}) {
    const definition = CAPABILITIES[capability];
    if (!definition) return null;

    const endpointUrl = normalizeRealtimeEndpoint(
        getCapabilityEndpoint(capability, env),
    );
    const modelName = getCapabilityDeployment(capability, env);
    const transcriptionModel = getCapabilityDeployment('transcribe', env);
    const apiKey = getAzureRealtimeApiKey(env);

    return {
        capability,
        available: Boolean(endpointUrl && modelName && hasUsableSecret(apiKey)),
        endpoint: endpointUrl ? { url: endpointUrl } : null,
        modelName,
        transcriptionModel,
        apiKey,
    };
}

function getRealtimeGatewaySettings({ env = process.env } = {}) {
    return {
        authenticationAvailable: Boolean(
            getConfiguredGatewayApiKeys({ env }).length ||
                getRealtimeBrokerTokenSecrets({ env }).length,
        ),
        capabilities: Object.fromEntries(
            Object.keys(CAPABILITIES).map((capability) => [
                capability,
                getRealtimeCapabilitySettings({ env, capability }),
            ]),
        ),
    };
}

function getRealtimeTranslationSettings(options = {}) {
    return getRealtimeCapabilitySettings({
        ...options,
        capability: 'translate',
    });
}

function parseRequestPathname(value) {
    if (typeof value !== 'string') return null;
    return URL.parse(value, 'http://localhost')?.pathname || null;
}

function buildAzureRealtimeUrl(settings) {
    const url = new URL(settings.endpoint.url);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';

    if (settings.capability === 'transcribe') {
        url.searchParams.set('intent', 'transcription');
        url.searchParams.delete('model');
    } else {
        url.searchParams.set('model', settings.modelName);
    }

    return url.toString();
}

function buildAzureRealtimeTranslationUrl(settings) {
    return buildAzureRealtimeUrl({ ...settings, capability: 'translate' });
}

function splitKeys(value) {
    return String(value || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
}

function getConfiguredGatewayApiKeys({ env = process.env } = {}) {
    return [
        ...splitKeys(env.REALTIME_AUDIO_GATEWAY_API_KEY),
        ...splitKeys(env.CORTEX_REALTIME_API_KEY),
        ...splitKeys(env.CORTEX_API_KEY),
    ].filter(hasUsableSecret);
}

function getRealtimeBrokerTokenSecrets({ env = process.env } = {}) {
    const secrets = [
        env.REALTIME_AUDIO_BROKER_TOKEN_SECRET,
        env.CORTEX_REALTIME_AUDIO_BROKER_TOKEN_SECRET,
    ].filter(hasUsableSecret);

    return [...new Set(secrets)];
}

function getAzureHandshakeTimeoutMs(env = process.env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_AZURE_HANDSHAKE_TIMEOUT_MS,
        DEFAULT_AZURE_HANDSHAKE_TIMEOUT_MS,
    );
}

function getPositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAuthTimeoutMs(env = process.env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_BROKER_AUTH_TIMEOUT_MS,
        DEFAULT_AUTH_TIMEOUT_MS,
    );
}

function getMaxPendingAuth(env = process.env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_GATEWAY_MAX_PENDING_AUTH,
        DEFAULT_MAX_PENDING_AUTH,
    );
}

function getMaxActiveSessions(env = process.env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_GATEWAY_MAX_ACTIVE_SESSIONS,
        DEFAULT_MAX_ACTIVE_SESSIONS,
    );
}

function getUpstreamCloseTimeoutMs(env = process.env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_UPSTREAM_CLOSE_TIMEOUT_MS,
        DEFAULT_UPSTREAM_CLOSE_TIMEOUT_MS,
    );
}

function getMaxSessionMs(env = process.env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_BROKER_MAX_SESSION_MS,
        DEFAULT_MAX_SESSION_MS,
    );
}

function parseBrokerToken(token) {
    if (typeof token !== 'string') return null;
    const [payloadPart, signature] = token.split('.');
    if (!payloadPart || !signature) return null;

    try {
        return {
            payloadPart,
            signature,
            payload: JSON.parse(
                Buffer.from(payloadPart, 'base64url').toString('utf8'),
            ),
        };
    } catch {
        return null;
    }
}

function hasExpectedAudience(payload, capability) {
    const definition = CAPABILITIES[capability];
    return (
        payload.aud === definition.audience ||
        (payload.aud === GENERIC_BROKER_AUDIENCE &&
            payload.capability === capability)
    );
}

function verifyBrokerToken(options = {}, token, capability = 'translate') {
    if (!CAPABILITIES[capability]) return null;
    const parsed = parseBrokerToken(token);
    if (!parsed) return null;

    const actualBuffer = Buffer.from(parsed.signature);
    const hasMatchingSecret = getRealtimeBrokerTokenSecrets(options).some(
        (secret) => {
            // Broker tokens are MACs, not password hashes; SHA-256 is the protocol digest.
            const expected = crypto
                .createHmac('sha256', secret)
                .update(parsed.payloadPart)
                .digest('base64url');
            const expectedBuffer = Buffer.from(expected);
            return (
                actualBuffer.length === expectedBuffer.length &&
                crypto.timingSafeEqual(actualBuffer, expectedBuffer)
            );
        },
    );
    if (!hasMatchingSecret) return null;

    const now = Math.floor(Date.now() / 1000);
    const issuedAt = parsed.payload.iat;
    const expiresAt = parsed.payload.exp;
    const maxLifetime = getPositiveNumber(
        options.env?.REALTIME_AUDIO_BROKER_MAX_TOKEN_TTL_SECONDS,
        DEFAULT_MAX_TOKEN_LIFETIME_SECONDS,
    );
    const clockSkew = getPositiveNumber(
        options.env?.REALTIME_AUDIO_BROKER_TOKEN_CLOCK_SKEW_SECONDS,
        DEFAULT_TOKEN_CLOCK_SKEW_SECONDS,
    );
    if (
        !hasExpectedAudience(parsed.payload, capability) ||
        typeof issuedAt !== 'number' ||
        typeof expiresAt !== 'number' ||
        issuedAt > now + clockSkew ||
        expiresAt <= now ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > maxLifetime
    ) {
        return null;
    }

    return parsed.payload;
}

function cleanupBrokerTokenUseStore(store, now) {
    for (const [key, expiresAt] of store.entries()) {
        if (expiresAt <= now) store.delete(key);
    }
}

function claimBrokerTokenUse(
    authorization,
    { store = usedBrokerTokenIds, now = Math.floor(Date.now() / 1000) } = {},
) {
    const tokenId =
        typeof authorization?.jti === 'string' ? authorization.jti.trim() : '';
    const expiresAt =
        typeof authorization?.exp === 'number' ? authorization.exp : 0;

    cleanupBrokerTokenUseStore(store, now);

    if (!tokenId || expiresAt <= now) return false;

    const key = `${authorization?.sub || 'anonymous'}:${tokenId}`;
    if (store.has(key)) return false;
    if (store.size >= MAX_USED_BROKER_TOKENS) return false;

    store.set(key, expiresAt);
    return true;
}

function getReplayRedisClient(env, logger) {
    const url = firstValue(
        env.REALTIME_AUDIO_REDIS_CONNECTION_STRING,
        env.REDIS_CONNECTION_STRING,
    );
    if (!url) return null;
    if (replayRedisClient && replayRedisUrl === url) return replayRedisClient;

    replayRedisClient?.disconnect();
    replayRedisUrl = url;
    replayRedisClient = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
    });
    replayRedisClient.on('error', (error) => {
        logger.error(`Realtime token replay store error: ${error.message}`);
    });
    return replayRedisClient;
}

function closeReplayStore() {
    replayRedisClient?.disconnect();
    replayRedisClient = undefined;
    replayRedisUrl = undefined;
}

function getRedisTimeoutMs(env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_REDIS_TIMEOUT_MS,
        DEFAULT_REDIS_TIMEOUT_MS,
    );
}

async function withTimeout(promise, timeoutMs, message) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(message)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function claimBrokerTokenUseShared(
    authorization,
    {
        env = process.env,
        logger = console,
        redisClient = getReplayRedisClient(env, logger),
        now = Math.floor(Date.now() / 1000),
    } = {},
) {
    if (!redisClient) {
        return isEnvTrue(env.REALTIME_AUDIO_REQUIRE_SHARED_REPLAY_STORE)
            ? false
            : claimBrokerTokenUse(authorization, { now });
    }

    const tokenId = String(authorization?.jti || '').trim();
    const expiresAt = Number(authorization?.exp || 0);
    if (!tokenId || expiresAt <= now) return false;

    const tokenHash = crypto
        .createHash('sha256')
        .update(`${authorization?.sub || 'anonymous'}:${tokenId}`)
        .digest('hex');
    const ttlMs = Math.max(1000, (expiresAt - now) * 1000);

    try {
        const claim = redisClient.set(
            `realtime-audio:token:${tokenHash}`,
            '1',
            'PX',
            ttlMs,
            'NX',
        );
        return (
            (await withTimeout(
                claim,
                getRedisTimeoutMs(env),
                'Redis token claim timed out',
            )) === 'OK'
        );
    } catch (error) {
        logger.error(`Realtime token claim failed: ${error.message}`);
        return false;
    }
}

async function checkReplayStoreHealth({
    env = process.env,
    logger = console,
    redisClient = getReplayRedisClient(env, logger),
} = {}) {
    if (!redisClient) {
        return !isEnvTrue(env.REALTIME_AUDIO_REQUIRE_SHARED_REPLAY_STORE);
    }
    try {
        const healthKey = `realtime-audio:health:${crypto.randomUUID()}`;
        return (
            (await withTimeout(
                redisClient.set(
                    healthKey,
                    '1',
                    'PX',
                    getRedisTimeoutMs(env),
                    'NX',
                ),
                getRedisTimeoutMs(env),
                'Redis health check timed out',
            )) === 'OK'
        );
    } catch (error) {
        logger.error(
            `Realtime replay store health check failed: ${error.message}`,
        );
        return false;
    }
}

function getTranslationDrainMs(env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_TRANSLATION_DRAIN_MS,
        DEFAULT_TRANSLATION_DRAIN_MS,
    );
}

function getConversationDrainMs(env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_CONVERSATION_DRAIN_MS,
        DEFAULT_CONVERSATION_DRAIN_MS,
    );
}

function getSessionAckTimeoutMs(env) {
    return getPositiveNumber(
        env.REALTIME_AUDIO_SESSION_ACK_TIMEOUT_MS,
        DEFAULT_SESSION_ACK_TIMEOUT_MS,
    );
}

function getSafetyIdentifier(value, capability) {
    const identifier = String(value || `concierge-realtime-${capability}`).trim();
    if (/^[A-Za-z0-9._:-]{1,64}$/.test(identifier)) return identifier;
    return crypto
        .createHash('sha256')
        .update(identifier)
        .digest('hex')
        .slice(0, 32);
}

function getGatewayApiKeyFromRequest(request) {
    const authHeader = request.headers.authorization || '';
    return (
        request.headers['realtime-audio-gateway-api-key'] ||
        request.headers['cortex-api-key'] ||
        request.headers['x-api-key'] ||
        (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader)
    );
}

function isRequestAuthorized(options = {}, request) {
    const apiKeys = getConfiguredGatewayApiKeys(options);
    if (apiKeys.length === 0) return false;
    return apiKeys.includes(getGatewayApiKeyFromRequest(request));
}

function sendClientEvent(clientWs, event) {
    if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(event));
    }
}

function closeClientWithError(clientWs, message, code = CLOSE_SERVER_ERROR) {
    sendClientEvent(clientWs, {
        type: 'error',
        error: { message },
    });
    clientWs.close(code, message.slice(0, 120));
}

function createTranslationSessionUpdate({
    targetLanguage,
    transcriptionModel,
}) {
    const transcription = transcriptionModel
        ? { model: transcriptionModel }
        : undefined;

    return {
        type: 'session.update',
        session: {
            audio: {
                input: {
                    ...(transcription ? { transcription } : {}),
                    noise_reduction: { type: 'near_field' },
                },
                output: { language: targetLanguage },
            },
        },
    };
}

function createTranscriptionSessionUpdate({ sourceLanguage, modelName }) {
    const transcription = { model: modelName };
    if (sourceLanguage) transcription.language = sourceLanguage;

    return {
        type: 'session.update',
        session: {
            type: 'transcription',
            audio: {
                input: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    turn_detection: null,
                    transcription,
                },
            },
        },
    };
}

function createConversationSessionUpdate() {
    return {
        type: 'session.update',
        session: {
            type: 'realtime',
            instructions: DEFAULT_CONVERSATION_INSTRUCTIONS,
            tools: [CORTEX_TOOL],
            tool_choice: 'auto',
            audio: {
                input: {
                    turn_detection: {
                        type: 'server_vad',
                        create_response: true,
                        interrupt_response: true,
                        silence_duration_ms: 500,
                    },
                },
            },
        },
    };
}

function getCortexToolCall(event) {
    if (event?.type === 'response.function_call_arguments.done') {
        return event.name === CORTEX_TOOL_NAME
            ? {
                  callId: event.call_id,
                  name: event.name,
                  arguments: event.arguments,
              }
            : null;
    }

    const item = event?.item;
    if (
        event?.type === 'response.output_item.done' &&
        item?.type === 'function_call' &&
        item?.name === CORTEX_TOOL_NAME
    ) {
        return {
            callId: item.call_id,
            name: item.name,
            arguments: item.arguments,
        };
    }

    return null;
}

function createInitialSessionUpdate(capability, settings, sessionOptions) {
    if (capability === 'translate') {
        return createTranslationSessionUpdate({
            targetLanguage: sessionOptions.targetLanguage,
            transcriptionModel: settings.transcriptionModel,
        });
    }
    if (capability === 'transcribe') {
        return createTranscriptionSessionUpdate({
            sourceLanguage: sessionOptions.sourceLanguage,
            modelName: settings.modelName,
        });
    }
    if (capability === 'converse') {
        return createConversationSessionUpdate();
    }
    return null;
}

function createSessionUpdate(options) {
    return createTranslationSessionUpdate(options);
}

function resolveAuthorizedTargetLanguage(authorization, requestedLanguage) {
    if (!authorization) {
        return normalizeLanguage(requestedLanguage, DEFAULT_TARGET_LANGUAGE);
    }

    const signedTargetLanguage = normalizeLanguage(
        authorization.targetLanguage,
        DEFAULT_TARGET_LANGUAGE,
    );
    const requestedTargetLanguage = normalizeLanguage(
        requestedLanguage,
        signedTargetLanguage,
    );

    return requestedTargetLanguage === signedTargetLanguage
        ? signedTargetLanguage
        : null;
}

function resolveAuthorizedSourceLanguage(authorization, requestedLanguage) {
    const signedLanguage = normalizeLanguage(
        authorization?.sourceLanguage,
        undefined,
    );
    const requested = normalizeLanguage(requestedLanguage, signedLanguage);
    if (signedLanguage && requested !== signedLanguage) return null;
    return requested;
}

function resolveSessionOptions(capability, authorization, requested = {}) {
    if (capability === 'translate') {
        const targetLanguage = resolveAuthorizedTargetLanguage(
            authorization,
            requested.targetLanguage,
        );
        return targetLanguage ? { targetLanguage } : null;
    }
    if (capability === 'transcribe') {
        const sourceLanguage = resolveAuthorizedSourceLanguage(
            authorization,
            requested.sourceLanguage,
        );
        return sourceLanguage === null ? null : { sourceLanguage };
    }
    return {};
}

function normalizeCapability(value) {
    if (typeof value !== 'string') return undefined;
    const capability = value.trim().toLowerCase();
    return CAPABILITIES[capability] ? capability : undefined;
}

function normalizeClientMessage(capability, message, settings, sessionOptions) {
    if (message.type === 'audio') {
        if (
            typeof message.audio !== 'string' ||
            !message.audio.length ||
            message.audio.length > MAX_AUDIO_PAYLOAD_CHARS ||
            message.audio.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(message.audio)
        ) {
            return null;
        }
        return {
            type: CAPABILITIES[capability].audioAppendType,
            audio: message.audio,
        };
    }

    if (message.type === 'session.update' && capability === 'translate') {
        return createInitialSessionUpdate(capability, settings, sessionOptions);
    }

    if (message.type === 'session.update' && capability === 'transcribe') {
        const normalized = structuredClone(message);
        normalized.session ||= {};
        normalized.session.type = 'transcription';
        normalized.session.audio ||= {};
        normalized.session.audio.input ||= {};
        normalized.session.audio.input.transcription ||= {};
        normalized.session.audio.input.transcription.model = settings.modelName;
        if (sessionOptions.sourceLanguage) {
            normalized.session.audio.input.transcription.language =
                sessionOptions.sourceLanguage;
        }
        return normalized;
    }

    if (message.type === 'session.update' && capability === 'converse') {
        const normalized = structuredClone(message);
        if (normalized.session) delete normalized.session.model;
        return normalized;
    }

    return message;
}

function registerRealtimeAudioGateway({
    env = process.env,
    logger = console,
    WebSocketClient = WebSocket,
    claimTokenUse = claimBrokerTokenUseShared,
} = {}) {
    const wsServer = new WebSocketServer({
        noServer: true,
        maxPayload: 1024 * 1024,
    });
    wsServer.realtimeAudioPath = BROKER_PATH;
    wsServer.realtimeAudioPaths = new Set([BROKER_PATH]);
    wsServer.realtimeAudioUpstreamSockets = new Set();
    wsServer.realtimeAudioShuttingDown = false;
    wsServer.realtimeAudioPendingAuthCount = 0;
    wsServer.realtimeAudioActiveSessionCount = 0;

    wsServer.on('connection', (clientWs, request) => {
        if (wsServer.realtimeAudioShuttingDown) {
            clientWs.close(1012, 'Server shutting down');
            return;
        }
        const url = new URL(request.url, 'http://localhost');
        const requestHasServerAuth = isRequestAuthorized({ env }, request);
        if (url.pathname !== BROKER_PATH) {
            closeClientWithError(clientWs, 'Unsupported realtime capability');
            return;
        }
        let capability = requestHasServerAuth
            ? normalizeCapability(url.searchParams.get('capability'))
            : undefined;
        if (requestHasServerAuth && !capability) {
            closeClientWithError(clientWs, 'Unsupported realtime capability');
            return;
        }
        if (
            !requestHasServerAuth &&
            wsServer.realtimeAudioPendingAuthCount >= getMaxPendingAuth(env)
        ) {
            clientWs.close(1013, 'Realtime audio is busy');
            return;
        }

        let pendingAuth = !requestHasServerAuth;
        let activeSession = false;
        if (pendingAuth) wsServer.realtimeAudioPendingAuthCount += 1;
        const releasePendingAuth = () => {
            if (!pendingAuth) return;
            pendingAuth = false;
            wsServer.realtimeAudioPendingAuthCount = Math.max(
                0,
                wsServer.realtimeAudioPendingAuthCount - 1,
            );
        };
        const releaseActiveSession = () => {
            if (!activeSession) return;
            activeSession = false;
            wsServer.realtimeAudioActiveSessionCount = Math.max(
                0,
                wsServer.realtimeAudioActiveSessionCount - 1,
            );
        };

        let settings = capability
            ? getRealtimeCapabilitySettings({ env, capability })
            : undefined;
        if (settings && !settings.available) {
            closeClientWithError(
                clientWs,
                `Azure realtime ${capability} is not configured`,
            );
            return;
        }

        const pendingMessages = [];
        let pendingMessageBytes = 0;
        let azureWs = null;
        let azureReady = false;
        let responseActive = false;
        let conversationAudioReceived = false;
        const pendingToolCallIds = new Set();
        const completedToolCallIds = new Set();
        let clientClosed = false;
        let gracefulCloseRequested = false;
        let gracefulCloseTimer;
        let upstreamCloseTimer;
        let sessionAckTimer;
        let authenticating = false;
        let sessionOptions = {};
        let authorized = false;
        const sessionTimer = setTimeout(() => {
            closeClientWithError(
                clientWs,
                `Realtime ${capability || 'audio'} session timed out`,
            );
            closeAzureWithTimeout();
        }, getMaxSessionMs(env));
        const authTimer = requestHasServerAuth
            ? null
            : setTimeout(() => {
                  closeClientWithError(
                      clientWs,
                      'Unauthorized',
                      CLOSE_POLICY_VIOLATION,
                  );
              }, getAuthTimeoutMs(env));

        const clearTimers = ({ preserveUpstreamClose = false } = {}) => {
            clearTimeout(sessionTimer);
            if (authTimer) clearTimeout(authTimer);
            if (gracefulCloseTimer) clearTimeout(gracefulCloseTimer);
            if (upstreamCloseTimer && !preserveUpstreamClose) {
                clearTimeout(upstreamCloseTimer);
                upstreamCloseTimer = null;
            }
            if (sessionAckTimer) clearTimeout(sessionAckTimer);
        };

        const closeAzureWithTimeout = () => {
            if (!azureWs || azureWs.readyState === WebSocket.CLOSED) {
                releaseActiveSession();
                return;
            }
            if (
                azureWs.readyState === WebSocket.OPEN ||
                azureWs.readyState === WebSocket.CONNECTING
            ) {
                azureWs.close();
            }
            if (!upstreamCloseTimer) {
                upstreamCloseTimer = setTimeout(
                    () => {
                        upstreamCloseTimer = null;
                        if (azureWs?.readyState !== WebSocket.CLOSED) {
                            azureWs?.terminate();
                        }
                    },
                    getUpstreamCloseTimeoutMs(env),
                );
            }
        };

        const scheduleAzureClose = (delayMs) => {
            if (gracefulCloseTimer) clearTimeout(gracefulCloseTimer);
            gracefulCloseTimer = setTimeout(closeAzureWithTimeout, delayMs);
        };

        const sendUpstream = (message) => {
            if (gracefulCloseRequested) return;
            if (!authorized || !azureWs) {
                closeClientWithError(
                    clientWs,
                    'Unauthorized',
                    CLOSE_POLICY_VIOLATION,
                );
                return;
            }

            let payload;
            try {
                payload = JSON.stringify(message);
            } catch {
                closeClientWithError(
                    clientWs,
                    'Invalid realtime audio message',
                    CLOSE_POLICY_VIOLATION,
                );
                return;
            }
            if (
                capability === 'converse' &&
                message.type === 'input_audio_buffer.append'
            ) {
                conversationAudioReceived = true;
            }
            if (azureReady && azureWs.readyState === WebSocket.OPEN) {
                if (azureWs.bufferedAmount > MAX_AZURE_BUFFERED_AMOUNT) {
                    closeClientWithError(
                        clientWs,
                        'Realtime audio stream is too far behind',
                    );
                    closeAzureWithTimeout();
                    return;
                }
                azureWs.send(payload);
                return;
            }

            const payloadBytes = Buffer.byteLength(payload);
            if (
                pendingMessages.length >= MAX_PENDING_MESSAGES ||
                pendingMessageBytes + payloadBytes > MAX_PENDING_BYTES
            ) {
                closeClientWithError(
                    clientWs,
                    'Realtime audio stream started too quickly',
                );
                closeAzureWithTimeout();
                return;
            }
            pendingMessages.push({ payload, bytes: payloadBytes });
            pendingMessageBytes += payloadBytes;
        };

        const requestAzureClose = ({ drainConversation = true } = {}) => {
            gracefulCloseRequested = true;
            if (!azureWs) {
                clearTimers();
                sendClientEvent(clientWs, { type: 'session.closed' });
                clientWs.close();
                return;
            }
            if (azureWs.readyState === WebSocket.OPEN) {
                if (
                    capability === 'transcribe' ||
                    (capability === 'converse' && !drainConversation)
                ) {
                    closeAzureWithTimeout();
                    return;
                }
                const drainMs =
                    capability === 'converse'
                        ? getConversationDrainMs(env)
                        : getTranslationDrainMs(env);
                if (
                    capability === 'converse' &&
                    !responseActive &&
                    conversationAudioReceived
                ) {
                    azureWs.send(
                        JSON.stringify({
                            type: 'input_audio_buffer.append',
                            audio: CONVERSATION_FLUSH_SILENCE,
                        }),
                    );
                }
                scheduleAzureClose(drainMs);
                return;
            }
            closeAzureWithTimeout();
        };

        const startAzureSession = ({ authorization, options }) => {
            if (
                wsServer.realtimeAudioActiveSessionCount >=
                getMaxActiveSessions(env)
            ) {
                releasePendingAuth();
                clientWs.close(1013, 'Realtime audio is busy');
                return;
            }
            authorized = true;
            releasePendingAuth();
            sessionOptions = options;
            if (authTimer) clearTimeout(authTimer);

            try {
                azureWs = new WebSocketClient(buildAzureRealtimeUrl(settings), {
                    maxPayload: MAX_CLIENT_BUFFERED_AMOUNT,
                    handshakeTimeout: getAzureHandshakeTimeoutMs(env),
                    headers: {
                        'api-key': settings.apiKey,
                        'OpenAI-Safety-Identifier': getSafetyIdentifier(
                            authorization?.sub,
                            capability,
                        ),
                    },
                });
                activeSession = true;
                wsServer.realtimeAudioActiveSessionCount += 1;
            } catch (error) {
                logger.error(
                    `Azure realtime ${capability} connection failed: ${error.message}`,
                );
                closeClientWithError(
                    clientWs,
                    `Azure realtime ${capability} session failed`,
                );
                return;
            }
            wsServer.realtimeAudioUpstreamSockets.add(azureWs);

            const markAzureReady = () => {
                if (azureReady) return;
                if (sessionAckTimer) clearTimeout(sessionAckTimer);
                azureReady = true;
                while (
                    pendingMessages.length &&
                    azureWs.readyState === WebSocket.OPEN
                ) {
                    if (azureWs.bufferedAmount > MAX_AZURE_BUFFERED_AMOUNT) {
                        closeClientWithError(
                            clientWs,
                            'Realtime audio stream is too far behind',
                        );
                        closeAzureWithTimeout();
                        return;
                    }
                    const pending = pendingMessages.shift();
                    pendingMessageBytes -= pending.bytes;
                    azureWs.send(pending.payload);
                }
                sendClientEvent(clientWs, { type: 'broker.ready', capability });
            };

            azureWs.on('open', () => {
                const initialUpdate = createInitialSessionUpdate(
                    capability,
                    settings,
                    sessionOptions,
                );
                if (initialUpdate) azureWs.send(JSON.stringify(initialUpdate));
                if (capability !== 'converse') {
                    markAzureReady();
                } else {
                    sessionAckTimer = setTimeout(() => {
                        closeClientWithError(
                            clientWs,
                            'Azure realtime converse session setup timed out',
                        );
                        closeAzureWithTimeout();
                    }, getSessionAckTimeoutMs(env));
                }
            });

            azureWs.on('message', (data) => {
                let event;
                try {
                    event = JSON.parse(data.toString());
                } catch {
                    event = null;
                }
                if (capability === 'converse') {
                    if (event?.type === 'session.updated') markAzureReady();
                    const toolCall = getCortexToolCall(event);
                    if (
                        toolCall?.callId &&
                        !completedToolCallIds.has(toolCall.callId)
                    ) {
                        if (
                            pendingToolCallIds.size >= MAX_PENDING_TOOL_CALLS &&
                            !pendingToolCallIds.has(toolCall.callId)
                        ) {
                            closeClientWithError(
                                clientWs,
                                'Too many pending Cortex tool calls',
                            );
                            closeAzureWithTimeout();
                            return;
                        }
                        pendingToolCallIds.add(toolCall.callId);
                    }
                    if (event?.type === 'response.created') {
                        responseActive = true;
                        if (gracefulCloseRequested) {
                            scheduleAzureClose(getConversationDrainMs(env));
                        }
                    }
                    if (event?.type === 'response.done') {
                        const completedActiveResponse = responseActive;
                        responseActive = false;
                        conversationAudioReceived = false;
                        if (gracefulCloseRequested && completedActiveResponse) {
                            closeAzureWithTimeout();
                        }
                    }
                    if (!azureReady && event?.type === 'error') {
                        closeClientWithError(
                            clientWs,
                            'Azure realtime converse session failed',
                        );
                        closeAzureWithTimeout();
                        return;
                    }
                }
                if (clientWs.readyState === WebSocket.OPEN) {
                    const frameBytes = Buffer.byteLength(data);
                    if (
                        clientWs.bufferedAmount + frameBytes >
                        MAX_CLIENT_BUFFERED_AMOUNT
                    ) {
                        closeClientWithError(
                            clientWs,
                            'Realtime client is too far behind',
                        );
                        closeAzureWithTimeout();
                        return;
                    }
                    clientWs.send(data.toString());
                }
            });

            azureWs.on('error', (error) => {
                if (
                    (clientClosed || gracefulCloseRequested) &&
                    /closed before the connection was established/i.test(
                        error.message,
                    )
                ) {
                    return;
                }
                logger.error(
                    `Azure realtime ${capability} socket error: ${error.message}`,
                );
                closeClientWithError(
                    clientWs,
                    `Azure realtime ${capability} session failed`,
                );
            });

            azureWs.on('close', (code, reasonBuffer) => {
                wsServer.realtimeAudioUpstreamSockets.delete(azureWs);
                releaseActiveSession();
                clearTimers();
                if (clientClosed) return;
                const normalClose = gracefulCloseRequested || code === 1000;
                if (!normalClose) {
                    const upstreamReason = reasonBuffer?.toString() || '';
                    logger.error(
                        `Azure realtime ${capability} closed unexpectedly (${code})${upstreamReason ? `: ${upstreamReason}` : ''}`,
                    );
                    closeClientWithError(
                        clientWs,
                        `Azure realtime ${capability} session disconnected`,
                    );
                    return;
                }
                sendClientEvent(clientWs, { type: 'session.closed' });
                clientWs.close(1000);
            });
        };

        if (requestHasServerAuth) {
            const options = resolveSessionOptions(capability, null, {
                targetLanguage: url.searchParams.get('targetLanguage'),
                sourceLanguage: url.searchParams.get('sourceLanguage'),
            });
            startAzureSession({ authorization: null, options });
        }

        clientWs.on('message', async (data) => {
            if (wsServer.realtimeAudioShuttingDown) {
                clientWs.close(1012, 'Server shutting down');
                return;
            }
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch {
                sendClientEvent(clientWs, {
                    type: 'error',
                    error: { message: 'Invalid realtime audio message' },
                });
                return;
            }
            if (
                !message ||
                typeof message !== 'object' ||
                Array.isArray(message)
            ) {
                sendClientEvent(clientWs, {
                    type: 'error',
                    error: { message: 'Invalid realtime audio message' },
                });
                return;
            }

            if (message.type === 'auth') {
                if (authorized || authenticating) return;
                authenticating = true;

                const requestedCapability = normalizeCapability(
                    message.capability,
                );
                const authCapability = capability || requestedCapability;
                if (
                    !authCapability ||
                    (message.capability !== undefined &&
                        !requestedCapability) ||
                    (capability &&
                        requestedCapability &&
                        requestedCapability !== capability)
                ) {
                    closeClientWithError(
                        clientWs,
                        'Unauthorized',
                        CLOSE_POLICY_VIOLATION,
                    );
                    return;
                }

                const authorization = verifyBrokerToken(
                    { env },
                    message.brokerToken,
                    authCapability,
                );
                const authSettings = getRealtimeCapabilitySettings({
                    env,
                    capability: authCapability,
                });
                if (
                    !authorization ||
                    !authSettings.available ||
                    !(await claimTokenUse(authorization, { env, logger }))
                ) {
                    closeClientWithError(
                        clientWs,
                        'Unauthorized',
                        CLOSE_POLICY_VIOLATION,
                    );
                    return;
                }

                if (clientClosed || clientWs.readyState !== WebSocket.OPEN) {
                    authenticating = false;
                    return;
                }

                capability = authCapability;
                settings = authSettings;
                const options = resolveSessionOptions(
                    capability,
                    authorization,
                    {
                        targetLanguage: message.targetLanguage,
                        sourceLanguage: message.sourceLanguage,
                    },
                );
                if (!options) {
                    closeClientWithError(
                        clientWs,
                        'Unauthorized',
                        CLOSE_POLICY_VIOLATION,
                    );
                    return;
                }

                authenticating = false;
                startAzureSession({ authorization, options });
                return;
            }

            if (!authorized) {
                closeClientWithError(
                    clientWs,
                    'Unauthorized',
                    CLOSE_POLICY_VIOLATION,
                );
                return;
            }

            if (
                !requestHasServerAuth &&
                !TOKEN_CLIENT_MESSAGE_TYPES.has(message.type)
            ) {
                closeClientWithError(
                    clientWs,
                    'Unsupported realtime audio message',
                    CLOSE_POLICY_VIOLATION,
                );
                return;
            }

            if (gracefulCloseRequested) return;

            if (message.type === 'close') {
                requestAzureClose({
                    drainConversation: message.drain !== false,
                });
                return;
            }

            if (message.type === 'ping') {
                sendClientEvent(clientWs, { type: 'pong' });
                return;
            }

            if (message.type === 'interrupt') {
                if (capability !== 'converse') {
                    closeClientWithError(
                        clientWs,
                        'Invalid realtime interruption',
                        CLOSE_POLICY_VIOLATION,
                    );
                    return;
                }

                const itemId =
                    typeof message.itemId === 'string' ? message.itemId : '';
                const audioEndMs =
                    typeof message.audioEndMs === 'number'
                        ? message.audioEndMs
                        : Number.NaN;
                const contentIndex =
                    message.contentIndex === undefined
                        ? 0
                        : message.contentIndex;
                if (itemId) {
                    if (
                        itemId.length > 256 ||
                        !Number.isInteger(audioEndMs) ||
                        audioEndMs < 0 ||
                        !Number.isInteger(contentIndex) ||
                        contentIndex < 0
                    ) {
                        closeClientWithError(
                            clientWs,
                            'Invalid realtime interruption',
                            CLOSE_POLICY_VIOLATION,
                        );
                        return;
                    }
                    sendUpstream({
                        type: 'conversation.item.truncate',
                        item_id: itemId,
                        content_index: contentIndex,
                        audio_end_ms: audioEndMs,
                    });
                }

                for (const callId of pendingToolCallIds) {
                    sendUpstream({
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: callId,
                            output: 'Cancelled because the user interrupted.',
                        },
                    });
                    completedToolCallIds.add(callId);
                }
                pendingToolCallIds.clear();
                return;
            }

            if (message.type === 'tool_result') {
                const callId =
                    typeof message.callId === 'string' ? message.callId : '';
                const output =
                    typeof message.output === 'string' ? message.output : '';
                if (
                    capability !== 'converse' ||
                    !callId ||
                    callId.length > 256 ||
                    !pendingToolCallIds.delete(callId) ||
                    !output ||
                    Buffer.byteLength(output) > MAX_TOOL_RESULT_BYTES
                ) {
                    closeClientWithError(
                        clientWs,
                        'Invalid Cortex tool result',
                        CLOSE_POLICY_VIOLATION,
                    );
                    return;
                }
                completedToolCallIds.add(callId);
                sendUpstream({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: callId,
                        output,
                    },
                });
                sendUpstream({ type: 'response.create' });
                return;
            }

            try {
                const normalized = normalizeClientMessage(
                    capability,
                    message,
                    settings,
                    sessionOptions,
                );
                if (normalized) sendUpstream(normalized);
            } catch {
                closeClientWithError(
                    clientWs,
                    'Invalid realtime audio message',
                    CLOSE_POLICY_VIOLATION,
                );
            }
        });

        clientWs.on('close', () => {
            clientClosed = true;
            releasePendingAuth();
            clearTimers({ preserveUpstreamClose: true });
            closeAzureWithTimeout();
        });

        clientWs.on('error', (error) => {
            logger.error(
                `Realtime ${capability} client socket error: ${error.message}`,
            );
            closeAzureWithTimeout();
        });
    });

    logger.info(
        `Realtime audio gateway listening on ${BROKER_PATH} (${Object.keys(CAPABILITIES).join(', ')})`,
    );
    return wsServer;
}

function registerRealtimeAudioBroker(options = {}) {
    return registerRealtimeAudioGateway(options);
}

export {
    BROKER_PATH,
    CAPABILITIES,
    buildAzureRealtimeTranslationUrl,
    buildAzureRealtimeUrl,
    checkReplayStoreHealth,
    claimBrokerTokenUse,
    claimBrokerTokenUseShared,
    closeReplayStore,
    createInitialSessionUpdate,
    createSessionUpdate,
    getRealtimeCapabilitySettings,
    getRealtimeGatewaySettings,
    getRealtimeTranslationSettings,
    isRequestAuthorized,
    parseRequestPathname,
    registerRealtimeAudioBroker,
    registerRealtimeAudioGateway,
    resolveAuthorizedTargetLanguage,
    verifyBrokerToken,
};
