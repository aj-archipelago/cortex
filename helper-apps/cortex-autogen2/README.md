## Cortex AutoGen: Advanced AI Agent System 🤖

Multi-agent task automation with real code execution, Azure Storage Queue ingestion, Azure Blob uploads, and live progress via Redis.

### Highlights
- **Selector-based orchestration** with `SelectorGroupChat`
- **Agents**: coder, code executor, cloud file uploader, presenter, terminator
- **Real execution** in a sandboxed working directory (`CORTEX_WORK_DIR`)
- **Azure native**: Queue (ingress) + Blob (files)
- **Live progress** published to Redis (`info`, `progress`, optional `data`)

### Architecture
- Shared core in `task_processor.py` used by both the long-running worker (`main.py`) and the Azure Functions container (`function_app.py`).
- Queue messages are Base64-encoded JSON; task text is read from `message` or `content`.

## Quick Start

### Prerequisites
- Python 3.11+
- Redis instance
- Azure Storage account (Queue + Blob)
- Docker (optional, for containerized Azure Functions local run)

### 1) Set environment variables
Create a `.env` in the project root:

```dotenv
# Core
AZURE_STORAGE_CONNECTION_STRING=...
AZURE_QUEUE_NAME=autogen-test-message-queue         # used by worker (main.py)
AZURE_BLOB_CONTAINER=autogentempfiles
REDIS_CONNECTION_STRING=redis://localhost:6379
REDIS_CHANNEL=requestProgress

# Models API
CORTEX_API_KEY=...
CORTEX_API_BASE_URL=http://host.docker.internal:4000/v1

# Working directory for code execution (must be writable)
CORTEX_WORK_DIR=/tmp/coding

# Azure Functions variant uses QUEUE_NAME (not AZURE_QUEUE_NAME)
QUEUE_NAME=autogen-test-message-queue
```

Keep secrets out of version control. You can also configure `local.settings.json` for local Functions.

### 2) Install dependencies
- Using Poetry:
```bash
poetry install
```
- Or with pip:
```bash
python -m venv .venv && source .venv/bin/activate   # project uses .venv
pip install -r requirements.txt
```

### 3) Run the worker locally
- Activate your virtualenv (`source .venv/bin/activate`) and ensure a clean worker state.
- Recommended workflow (non-continuous, exits when queue is empty):
```bash
# Kill any previously running worker (module or script form)
pkill -f "python -m src.cortex_autogen2.main" || true
pkill -f "python main.py" || true
CONTINUOUS_MODE=false python -m src.cortex_autogen2.main &
# Alternative (direct script):
# CONTINUOUS_MODE=false python main.py &
```
Tip: Use the module path variant if your repository layout exposes `src/cortex_autogen2` on `PYTHONPATH` (e.g., in a monorepo). Otherwise, run `python main.py` directly.

Then send a task:
```bash
python send_task.py "create a simple PDF about cats"
```

Notes:
- `CONTINUOUS_MODE=false` runs once and exits after the queue is empty.
- Use background run `&` to keep logs visible in the current terminal.

### 4) Run the worker in Docker (optional)
Build and run the worker image using `Dockerfile.worker`:
```bash
docker build -f Dockerfile.worker -t cortex-autogen-worker .
docker run --rm --env-file .env -e CORTEX_WORK_DIR=/app/coding --network host cortex-autogen-worker
```

### 5) Run the Azure Functions container locally (optional)
Use Docker Compose and pass your `.env` so the container gets your variables:
```bash
docker compose --env-file .env up --build
```
This builds `Dockerfile` (Functions) and starts on port `7071` (mapped to container `80`).

## Usage Details

### Sending tasks
`send_task.py` publishes a Base64-encoded JSON message with `content` to the queue defined by `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_QUEUE_NAME` (or `QUEUE_NAME` for Functions).

```bash
python send_task.py "list the files in the current directory"
# Override queue/connection if needed:
python send_task.py "create a simple PDF about cats" --queue autogen-test-message-queue --connection "<AZURE_STORAGE_CONNECTION_STRING>"
```

Message format published to the queue (before Base64 encoding):
```json
{
  "request_id": "<uuid>",
  "message_id": "<uuid>",
  "content": "<task text>"
}
```

### Progress updates
- Channel: set via `REDIS_CHANNEL` (recommend `requestProgress`)
- Payload fields: `requestId`, `progress` (0-1), `info` (short status), optional `data` (final Markdown)
- Final result publishes `progress=1.0` with `data` containing the Markdown for UI

### Working directory
- Code execution uses `CORTEX_WORK_DIR`. Defaults: `/home/site/wwwroot/coding` in Functions container; set to `/app/coding` in worker container; recommend `/tmp/coding` locally. Always use absolute paths within this directory.

## Project Structure
```
cortex-autogen2/
├── Dockerfile                  # Azure Functions container
├── Dockerfile.worker           # Traditional worker container
├── docker-compose.yml          # Local Functions container orchestrator
├── main.py                     # Long-running worker
├── function_app.py             # Azure Functions entry
├── task_processor.py           # Shared processing logic
├── host.json                   # Azure Functions host config
├── local.settings.json         # Local Functions settings (do not commit secrets)
├── requirements.txt            # Functions deps (pip)
├── pyproject.toml, poetry.lock # Poetry project config
├── send_task.py                # Queue task sender
├── agents.py                   # Agent definitions
├── services/
│   ├── azure_queue.py
│   └── redis_publisher.py
└── tools/
    ├── azure_blob_tools.py
    ├── coding_tools.py
    ├── download_tools.py
    ├── file_tools.py
    └── search_tools.py
```

## Environment variables reference
| Name                           | Required | Default                         | Used by           | Description |
|--------------------------------|----------|---------------------------------|-------------------|-------------|
| `AZURE_STORAGE_CONNECTION_STRING` | Yes    | —                               | Worker/Functions  | Storage account connection string |
| `AZURE_QUEUE_NAME`             | Yes (worker) | —                            | Worker            | Queue name for worker (`main.py`) |
| `QUEUE_NAME`                   | Yes (Functions) | `autogen-message-queue`    | Functions         | Queue name for Functions (`function_app.py`) |
| `AZURE_BLOB_CONTAINER`         | Yes      | —                               | Uploader tool     | Blob container for uploaded files |
| `REDIS_CONNECTION_STRING`      | Yes      | —                               | Progress          | Redis connection string |
| `REDIS_CHANNEL`                | Yes      | `requestProgress`               | Progress          | Redis pub/sub channel for progress |
| `CORTEX_API_KEY`               | Yes      | —                               | Models            | API key for Cortex/OpenAI-style API |
| `CORTEX_API_BASE_URL`          | No       | `http://host.docker.internal:4000/v1` | Models     | API base URL |
| `CORTEX_WORK_DIR`              | No       | `/tmp/coding` or container path | Code executor     | Writable work dir for code execution |

## Notes
- Health endpoint referenced in `docker-compose.yml` is optional; if you add one, expose it under `/api/health` in the Functions app.
- Do not commit `.env` or `local.settings.json` with secrets.
 - On macOS, Docker's `network_mode: host` is not supported; remove it from `docker-compose.yml` if needed and rely on published ports and `host.docker.internal` for host access.

## Troubleshooting
- No tasks processed: verify `AZURE_QUEUE_NAME`/`QUEUE_NAME` and that messages are Base64-encoded JSON with `content` or `message`.
- No progress visible: ensure `REDIS_CONNECTION_STRING` and `REDIS_CHANNEL` (e.g., `requestProgress`) are set, and network access to Redis.
- Container cannot reach host services: use `--network host` on macOS/Linux and `host.docker.internal` URLs inside containers.

## Contributing
- Open a PR with clear description and include documentation updates when applicable.

## Examples
- Send a research/report task:
```bash
python send_task.py "Summarize the latest trends in AI agent frameworks with references"
```
- Generate and upload a file:
```bash
python send_task.py "Create a simple PDF about cats with 3 bullet points and upload it"
```