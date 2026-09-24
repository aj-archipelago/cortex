# cortex-realtime-audio-gateway

Standalone WebSocket gateway for Concierge realtime audio.

One service owns authentication, limits, buffering, lifecycle, and Azure
credentials for these allowlisted capabilities on `/realtime-audio`:

- `transcribe` -> `gpt-realtime-whisper`
- `translate` -> `gpt-realtime-translate`
- `converse` -> `gpt-realtime-2.1`

The first browser message selects the capability:

```json
{ "type": "auth", "capability": "translate", "brokerToken": "..." }
```

The signed token audience must match the selected capability.

## Flow

1. Concierge validates the logged-in user and mints a short-lived broker token.
2. The browser opens `/realtime-audio`.
3. The browser sends `{ "type": "auth", "capability": "...", "brokerToken": "..." }` plus signed session options such as `targetLanguage`.
4. The gateway verifies the token and opens the allowlisted Azure deployment using server-side credentials.
5. Token-authenticated browsers can send only audio, ping, and close events. Trusted API-key clients retain Azure-native event access.

## Environment

Required:

- `AZURE_OPENAI_REALTIME_ENDPOINT`, or a capability-specific URL
- `ARCHIPELAGO_FOUNDRY_RESOURCE_KEY`, `AZURE_OPENAI_REALTIME_API_KEY`, or `AZURE_OPENAI_API_KEY`

Optional:

- `AZURE_REALTIME_TRANSLATE_DEPLOYMENT` defaults to `gpt-realtime-translate`
- `AZURE_REALTIME_WHISPER_DEPLOYMENT` defaults to `gpt-realtime-whisper`
- `AZURE_REALTIME_CONVERSATION_DEPLOYMENT` defaults to `gpt-realtime-2.1`
- `AZURE_REALTIME_TRANSLATE_URL`
- `AZURE_REALTIME_TRANSCRIBE_URL`
- `AZURE_REALTIME_CONVERSATION_URL`
- `REALTIME_AUDIO_BROKER_TOKEN_SECRET`
- `CORTEX_REALTIME_AUDIO_BROKER_TOKEN_SECRET`
- `REALTIME_AUDIO_BROKER_AUTH_TIMEOUT_MS`
- `REALTIME_AUDIO_BROKER_MAX_SESSION_MS`
- `REALTIME_AUDIO_GATEWAY_MAX_PENDING_AUTH` defaults to `256`
- `REALTIME_AUDIO_GATEWAY_MAX_ACTIVE_SESSIONS` defaults to `1000`
- `REALTIME_AUDIO_UPSTREAM_CLOSE_TIMEOUT_MS` defaults to `5000`
- `REALTIME_AUDIO_TRANSLATION_DRAIN_MS` defaults to `1000`
- `REALTIME_AUDIO_CONVERSATION_DRAIN_MS` defaults to `15000`
- `REALTIME_AUDIO_SESSION_ACK_TIMEOUT_MS` defaults to `12000`
- `REALTIME_AUDIO_AZURE_HANDSHAKE_TIMEOUT_MS` defaults to `12000`
- `REALTIME_AUDIO_BROKER_MAX_TOKEN_TTL_SECONDS` defaults to `300`
- `REALTIME_AUDIO_BROKER_TOKEN_CLOCK_SKEW_SECONDS` defaults to `30`
- `REALTIME_AUDIO_REDIS_CONNECTION_STRING` or `REDIS_CONNECTION_STRING` enables distributed one-time token claims
- `REALTIME_AUDIO_REDIS_TIMEOUT_MS` defaults to `1500`
- `REALTIME_AUDIO_REQUIRE_SHARED_REPLAY_STORE=true` fails health and token claims without Redis

Configure the same dedicated broker token secret in Concierge and this gateway.
Azure, Cortex, and gateway API keys are never accepted as signing keys. Browser tokens must use the
capability-specific audience or the generic `concierge-realtime-audio` audience
with a matching `capability` claim.

Keep a non-Redis gateway at one replica. Before scaling out, configure Redis and
set `REALTIME_AUDIO_REQUIRE_SHARED_REPLAY_STORE=true`. Redis failures then fail
closed rather than accepting a replayable token.
