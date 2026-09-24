# Transcription failure containment

A timed-out Whisper request used to keep downloading after its caller stopped waiting. Nested retries could send the same chunk to several workers, and cleanup could remove their input before they finished. Reopened Concierge uploads also reused expired Azure access URLs.

## Request lifecycle

Concierge renews recognized saved-upload URLs through the existing file handler, using the queue job owner's storage context. It requires the returned blob identity to match the saved file. Access tokens do not participate in completion-state comparisons; storage account, container, path, snapshot and version do. External URL query strings retain their meaning. Public-only requests keep their existing access rules. Immutable snapshot/version access renewal is unsupported and fails explicitly.

Each Whisper service runs one HTTP supervisor and one resident model process. A worker accepts one job at a time and returns `429` when busy or loading, without queueing work. Successful jobs reuse the model. Source failures release it. An inference failure or process crash reloads the model; admission stays closed until loading finishes.

| Boundary | Limit |
| --- | --- |
| Source download | 60 seconds; 15 seconds per socket read; 512 MiB |
| Worker job, including download and FFmpeg | 240 seconds |
| Cortex HTTP request | 260 seconds |
| Gateway budget | Must exceed the worker and HTTP budgets; configure at least 300 seconds |
| Busy retries | Three attempts total, with capped backoff |
| Uncertain-outcome cleanup | Absolute worker deadline plus 10 seconds |

Cortex stamps the absolute deadline after limiter admission. The worker clamps it to its own limit and uses a monotonic clock while running. Hosts must have synchronized clocks. Timeout or client disconnect kills the model's entire process group, including FFmpeg, before local files are removed. Gunicorn runs one HTTP worker and allows 270 seconds for graceful shutdown.

Cortex retries only explicit `429` responses and disables speculative duplicate requests. Repeated chunk URLs within one request share a promise. A batch waits for every started chunk to settle before cleanup; failure prevents later batches from starting.

The worker sends `X-Whisper-Job-Settled: true` on an error only after that request has released its input. Cortex cleans up immediately after an acknowledgement or a busy rejection. If the connection fails without acknowledgement, it keeps input blobs until the last transmitted deadline plus the reaping allowance. A dropped response never triggers another accepted attempt. Cleanup remains safe if the gateway strips the acknowledgement header, but takes longer.

The multipart OpenAI path also uses bounded downloads and the single retry budget. Its remote provider receives uploaded bytes and does not read the chunk URL.

## Deployment order

Deploy **all Whisper workers before Cortex**, then the Concierge queue worker and web application. Old workers do not enforce the deadline, so a mixed worker fleet cannot provide the cleanup guarantee. Drain active jobs before replacing workers.

Use `/health` for readiness; `/openapi.json` only proves that the HTTP server is running. A recovering worker reports 503 until its model is ready. If recovery fails, replace the unhealthy container. The container runtime must kill all processes when replacing a container, including after an HTTP supervisor crash. Set its termination grace to at least 270 seconds if jobs should finish during shutdown.

Before promoting the worker image, run a real GPU canary with normal audio and a representative long chunk. Exercise an unavailable source, a stalled download, cancellation, and a subsequent successful job. Confirm one model process, no surviving FFmpeg process after failure, and that the gateway does not retry accepted POSTs. Keep the 240-second job ceiling below the gateway budget; adjust chunk size if valid chunks exceed it.

Rollback Cortex before rolling workers back. Concierge's access renewal is independent of the worker protocol.

## Local validation

The JavaScript suites cover URL renewal, changed-file rejection, retry budgets, cancellation, duplicate chunk suppression, sibling settlement, cleanup timing, and stalled downloads. Python tests use a fake model in a real child process and local HTTP servers. They validate process-group termination and recovery without requiring a GPU.

```sh
npm run test:unit -- 'tests/unit/core/whisper*.test.js' tests/unit/plugins/whisperLifecycle.test.js tests/unit/core/cancelRequestAbort.test.js
PYTHONPATH=helper-apps/cortex-whisper-wrapper python -m unittest discover -s helper-apps/cortex-whisper-wrapper/tests -v
```

GPU inference, cloud gateway behavior, and throughput require validation in the operator's own deployment. FastAPI and httpx are required for the Python HTTP tests.
