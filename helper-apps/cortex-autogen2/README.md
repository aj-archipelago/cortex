# Cortex AutoGen: Advanced AI Agent System 🤖

A robust, production-ready AI agent system powered by the AutoGen framework, designed for complex task automation and intelligent problem-solving. `Cortex AutoGen` processes tasks from Azure Storage Queues, orchestrating a diverse team of specialized AI agents to deliver real, verifiable results.

## ✨ Key Features

-   **Dynamic Multi-Agent Orchestration**: Utilizes a `SelectorGroupChat` to dynamically select the most suitable agent(s) for each sub-task, enabling flexible and efficient workflows.
-   **Specialized Agent Team**: A comprehensive suite of agents, including:
    -   **Planner Agent**: Devises strategic plans for complex tasks.
    -   **Coder Agent**: Executes Python and shell scripts, performs computations, and creates local files.
    -   **File Cloud Uploader Agent**: Manages secure uploads of generated files to Azure Blob Storage, providing public SAS URLs.
    -   **Presenter Agent**: Formats and presents final results in professional Markdown, incorporating uploaded file URLs.
    -   **Terminator Agent**: Monitors task completion and signals termination.
-   **Real Code Execution & File Generation**: Agents are capable of running actual code, generating diverse file types (e.g., Python scripts, PDFs, images, presentations), and handling complex data processing.
-   **Azure Integration**: Seamlessly integrates with Azure Storage Queue for task ingestion and Azure Blob Storage for file persistence.
-   **Real-time Progress Updates**: Provides live updates on task progress, including summarized current activities.
-   **Production-Ready & Scalable**: Engineered for reliable performance and capable of handling a continuous stream of tasks.

## 🏗️ Architecture Overview

`Cortex AutoGen` operates around a central `SelectorGroupChat` that orchestrates a team of specialized agents. When a new task arrives via the Azure Queue, the `Planner Agent` formulates an initial strategy. Based on the task's requirements, the `SelectorGroupChat` intelligently routes the sub-tasks to the most appropriate agent(s).

For example:
-   Data analysis tasks might involve the `Coder Agent`.
-   Any generated files are then handled by the `File Cloud Uploader Agent`, and the final polished output is prepared by the `Presenter Agent`.
The `Terminator Agent` ensures that all conditions for task completion are met before signaling the end of the process.

## 🔧 Tools & Capabilities

`Cortex AutoGen` provides a robust set of tools accessible to agents for task execution:

-   **Search Tools**:
    -   Bing Web, News, and Image Search: Real-time information retrieval with recency filters.
    -   Azure Cognitive Search: Specialized searches across Al Jazeera indexes (English, Arabic, Wires).
-   **Coding Tools**:
    -   Code Execution: Runs Python scripts with persistent environments.
    -   Shell Execution: Executes terminal commands for system operations.
-   **File Tools**:
    -   File Creation/Reading: Manages local files intelligently across types.
    -   File Listing/Info: Categorizes and analyzes files in the working directory.
-   **Download Tools**:
    -   File Downloads: Retrieves files from URLs with progress tracking.
-   **Azure Blob Tools**:
    -   File Uploads: Securely uploads files to Azure Blob Storage with SAS URLs.

These tools enable agents to perform web research, data processing, file management, and more.

## 🚀 Quick Start

### Prerequisites

-   Python 3.11+
-   Docker (for containerized deployment)
-   Azure Storage Account
-   Redis instance (for progress tracking)
-   API access for OpenAI/Cortex (for LLM models)
-   API access for Azure Cognitive Search and Bing Search (if using these capabilities)

### Installation

```bash
git clone <repository-url>
cd cortex-autogen2
pip install -e .
```

### Configuration

Copy `.env.example` to `.env` and fill in your credentials.
```bash
cp .env.example .env
# Edit .env with your Azure, Redis, OpenAI/Cortex, Cognitive Search, and Bing Search credentials.
```

### Running the Worker

**1. Clean up any existing workers (important to avoid conflicts):**
   ```bash
   pkill -f "python -m src.cortex_autogen2.main" || true
   ```
   *(This command stops any running Python processes related to `cortex_autogen2.main`.)*

**2. Run the worker (choose one):**

   **a) Using Docker (Recommended for Production/Local Development):**
      ```bash
      docker stop cortex-autogen2-worker || true && \
      docker rm cortex-autogen2-worker || true && \
      docker build -t cortex-autogen2 . && \
      docker run --name cortex-autogen2-worker \
                 --env-file .env \
                 -e REDIS_CONNECTION_STRING="redis://host.docker.internal:6379" \
                 -e CORTEX_API_BASE_URL="http://host.docker.internal:4000/v1" \
                 cortex-autogen2
      ```
      *(This command builds the Docker image, removes any old container, and then runs a new container in the foreground, passing necessary environment variables. Note: `host.docker.internal` allows the container to access services running on the Docker host.)*

   **b) Directly via Python (for local testing/development):**
      ```bash
      # Run a single task and exit
      CONTINUOUS_MODE=false python -m src.cortex_autogen2.main

      # Run continuously in the background (recommended for local development)
      CONTINUOUS_MODE=true python -m src.cortex_autogen2.main &
      ```
      *(For background execution, use `&`. To view logs, remove `&` or check your shell's job control.)*

### 3. Send a Task

Use `send_task.py` to push tasks to the Azure Queue:

```bash
# Basic task
python send_task.py "Generate a Python script to calculate the factorial of 15" --wait

# Request an article using Cognitive Search and Bing
python send_task.py "Write an Al Jazeera style article about the latest developments in AI ethics, including insights from academic papers (search Cognitive Index 'indexwires') and recent news (Bing search)." --wait

# Query the Al Jazeera SQL database for article counts
python send_task.py "How many published articles of type 'post' and 'video' were created in the last 30 days for Al Jazeera English (AJE)? Provide a daily breakdown and visualize it." --wait

# Request a presentation
python send_task.py "Create a visually stunning, detailed, and fun PowerPoint (.pptx) presentation about the most powerful Pokémon. The presentation should include: (1) an engaging cover slide, (2) individual slides for at least 8 of the most powerful Pokémon, each with vibrant images, key stats (type, abilities, base stats, signature moves), and fun facts, (3) a 'battle showdown' comparison slide using visuals and stats, (4) a conclusion slide. Output should be a downloadable .pptx file. Include references for images and data sources if possible." --wait
```
*(The `--wait` flag makes `send_task.py` wait for the worker to process and return the result.)*

## 🔍 How to Verify Real Execution and Results

The `Cortex AutoGen` system is designed for verifiable execution. Here's how to confirm its capabilities:

1.  **Code & Computation Verification**:
    -   Request complex mathematical calculations (e.g., prime numbers, factorials, statistical analysis).
    -   Ask for algorithms that require actual implementation and testing (e.g., sorting, data structure operations).
    -   Review the computed output for accuracy.

2.  **File & Data Verification**:
    -   For any task involving file creation (PDFs, images, presentations), ensure the `Presenter Agent` provides a **real, working public URL** from the `File Cloud Uploader Agent`.
    -   Download and verify the content of the generated files.
    -   For database queries, check that the SQL results and visualizations accurately reflect the requested data.

3.  **Content & Research Verification**:
    -   Verify the accuracy and proper referencing of facts.

## ⚡ Performance & System Details

-   **Typical execution time**: Optimized for quick task completion.
-   **File Storage**: Automatic upload to Azure Blob Storage with temporary SAS URLs.
-   **Real-time Progress**: Updates are published via Redis for live monitoring.

### 🛠️ Project Structure

```
cortex-autogen2/
├── Dockerfile              # Docker container definition
├── main.py                 # Main worker entry point and agent orchestration
├── poetry.lock             # Poetry dependency lock file
├── pyproject.toml          # Poetry project configuration
├── README.md               # This documentation file
├── send_task.py            # Script for manual task submission to the queue
├── agents.py               # Agent definitions
├── services/               # External service integrations (Azure Queue, Redis Publisher)
│   ├── __init__.py
│   ├── azure_queue.py
│   └── redis_publisher.py
└── tools/                  # Agent tools
    ├── __init__.py
    ├── azure_blob_tools.py
    ├── coding_tools.py
    ├── download_tools.py
    ├── file_tools.py
    └── search_tools.py
```

## ✅ System Status

**Current Status**: ✅ **PRODUCTION READY**

`Cortex AutoGen` is continuously evolving, with the latest enhancements focused on dynamic agent selection, advanced file handling, and specialized task execution. It has been rigorously tested to ensure reliable performance across diverse AI tasks.

**Last Verified**: July 2024 with comprehensive tests across code execution, file generation/upload, database querying, web search, and article writing.

## 🤝 Contributing

We welcome contributions to `Cortex AutoGen`! To get started:

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Commit your changes with clear, descriptive messages.
4. Push your branch and submit a pull request.

Please include tests for new features and update documentation as needed. For major changes, open an issue first to discuss.

---

Feel free to open issues or contribute to further enhance `Cortex AutoGen`! 