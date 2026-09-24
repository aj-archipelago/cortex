# Replicate transcription

Two Cortex pathways accept the same media and subtitle inputs as `transcribe`:

- `transcribe_replicate_whisper`: `openai/whisper`, segment timestamps.
- `transcribe_replicate_whisperx`: `victor-upmeet/whisperx`, forced word alignment.

Set `REPLICATE_API_KEY` (the existing Replicate credential); the direct client
also accepts `REPLICATE_API_TOKEN`. Model versions are pinned in
`config/default.example.json` and `pathways/shared/transcribe_replicate/client.js`.

The existing `transcribe` endpoint defaults to OpenAI. To change that endpoint's
backend without changing Concierge callers, set `TRANSCRIBE_PROVIDER` to
`replicate-whisperx` or `replicate-whisper` in the target Cortex environment and
restart it. Set it to `openai`, or remove it, to restore the OpenAI route. Set it to `azure` with `WHISPER_TS_API_URL` to use the self-hosted timestamped wrapper. The
explicit pathways always select their named provider. Invalid values fail
instead of silently selecting another service. These changes do not reroute
the separate xAI, Gemini, or MAI transcription pathways.

Example GraphQL request:

```graphql
query Transcribe($file: String!) {
  transcribe_replicate_whisperx(
    file: $file
    language: "ar"
    responseFormat: "vtt"
    wordTimestamped: true
    maxWordsPerLine: 6
    maxLineCount: 2
  ) {
    result
    errors
  }
}
```

## Compatibility

| Input or output | Replicate Whisper | Replicate WhisperX |
| --- | --- | --- |
| Text, SRT, VTT | Yes | Yes |
| Explicit language or autodetection | Yes | Yes |
| Media-helper chunking, absolute offsets | Yes | Yes |
| Word timestamps | No | Yes, when alignment covers every word |
| Highlighted words | No | Yes, when alignment covers every word |
| Maximum line width | Wraps text within each segment | Wraps aligned words |
| Maximum words per line / line count | Rejected; requires word timing | Yes |
| Speaker diarization | No | Disabled to match the current route |

Both models transcribe in the source language; translation is disabled. A
`text` response with `wordTimestamped: true` produces VTT. Plain Whisper rejects
word-dependent controls before preparing media or creating a paid prediction.
WhisperX preserves words with missing alignment in text and segment subtitles,
but rejects word-dependent formatting for that output rather than inventing
timestamps. Alignment coverage depends on the audio and language.

The adapter uses the existing media helper, forwards `contextId`, preserves
explicit zero offsets, and runs at most four chunks per batch. Duplicate chunk
URLs share a prediction. It publishes progress while waiting. All requests use
the same ten-minute prediction deadline, including queue time. Cancellation or
a failed poll triggers best-effort provider cancellation. Cleanup waits for
sibling requests and retains inputs when a prediction's terminal state cannot
be confirmed. There is no automatic prediction resubmission after ambiguous
network errors. Credentials and signed input URLs are excluded from errors.

## Directional benchmark

`helper-apps/transcribe-bench/replicate-swap.mjs` compares the configured Azure
Whisper URL with both pinned Replicate versions. It performs two passes, reverses
provider order on the second pass, and sends one benchmark request at a time.
It reuses each Replicate response for text/SRT/VTT and word-format checks.

Supply a JSON array of fixtures with `name`, `url`, `durationSeconds`, `language`,
and optionally `reference`. Use public URLs in saved manifests; keep signed URLs
in memory. Names should be simple file basenames. From the project root:

```sh
node --env-file=.env helper-apps/transcribe-bench/replicate-swap.mjs \
  /tmp/public-fixtures.json /tmp/transcription-results
```

The timer includes provider download, queue/startup, inference, polling, and
subtitle normalization. It excludes the common upload/media preparation and
Concierge job queue. Azure requests enable word timestamps; WhisperX enables forced
alignment. Plain Whisper only computes segment timestamps, so its speed does not
represent equivalent word-level functionality. The report stores each request's
wall time, provider prediction time when available, normalized output, failure
status, and reference WER. WER lowercases text, removes punctuation and Arabic
diacritics, and normalizes Arabic alef/ya forms; it is a rough reference comparison,
not human adjudication or a measure of timestamp accuracy.

## Validation

```sh
npm run test:unit -- tests/unit/ported/transcribe_replicate.test.js
npm run test:unit -- \
  tests/unit/plugins/whisperLifecycle.test.js \
  tests/unit/core/whisperRequestPolicy.test.js
```

Tests cover provider contracts, output formats and timing, chunk offsets,
deduplication, cancellation, ambiguous submissions, sibling cleanup, preservation
of media for unconfirmed predictions, and the default OpenAI dispatch.
