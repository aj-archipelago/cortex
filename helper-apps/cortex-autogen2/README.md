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

## 🏗️ Updated Architecture Overview

Cortex AutoGen now supports two deployment models (traditional worker and Azure Function App) with shared core logic in `task_processor.py` for better scalability. It uses a central `SelectorGroupChat` to orchestrate agents, processing tasks from Azure Queues while ensuring clean worker states by killing existing processes before starting new ones.

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
- Python 3.11+
- Docker (for containerized deployment)
- Azure Storage Account
- Redis instance (for progress tracking)
- API access for OpenAI/Cortex and Azure services

### Installation and Running

1. **Activate Virtual Environment**: Always run commands within the `.venv` directory to manage dependencies.
2. **Environment Setup**: Include the `.env` file for Docker commands to load environment variables.
3. **Worker Management**: Before testing, kill existing workers with `pkill -f "python -m src.cortex_autogen2.main"`, verify with `ps aux | grep cortex_autogen2`, then start a fresh worker with `CONTINUOUS_MODE=false python -m src.cortex_autogen2.main &`.
4. Clone and install:
   ```bash
   git clone <repository-url>
   cd cortex-autogen2
   poetry install  # Or pip install -r requirements.txt
   ```
5. Send a test task:
   ```bash
   python send_task.py "Your test task here" --wait
   ```

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

### 🛠️ Updated Project Structure

```
cortex-autogen2/
├── Dockerfile  # For Azure Function App
├── Dockerfile.worker  # For traditional worker
├── docker-compose.yml  # Local development orchestration
├── main.py  # Main worker entry point
├── function_app.py  # Azure Function app configuration
├── task_processor.py  # Shared task processing logic
├── host.json                     # Azure Functions host configuration
├── local.settings.json           # Local Azure Functions settings
├── requirements.txt              # Python dependencies for Azure Functions
├── deploy_container_app.sh       # Azure Container Apps deployment script
├── run_local_container.sh        # Local container development script
├── poetry.lock                   # Poetry dependency lock file
├── pyproject.toml                # Poetry project configuration
├── README.md                     # This documentation file
├── send_task.py                  # Script for manual task submission to the queue
├── agents.py                     # Agent definitions
├── services/                     # External service integrations (Azure Queue, Redis Publisher)
│   ├── __init__.py
│   ├── azure_queue.py
│   └── redis_publisher.py
└── tools/                        # Agent tools
    ├── __init__.py
    ├── azure_blob_tools.py
    ├── coding_tools.py
    ├── download_tools.py
    ├── file_tools.py
    └── search_tools.py
```

## 🏗️ Architecture Improvements

The project now supports two deployment models with shared core functionality:

### **Core Module (`task_processor.py`)**
- **Extracted Logic**: All task processing logic has been extracted into a reusable `TaskProcessor` class
- **Shared Functionality**: Both worker and Azure Function App use the same core processing logic
- **Clean Separation**: Model initialization, progress tracking, and agent orchestration are centralized
- **Minimal Code**: Reduced duplication while maintaining full functionality

### **Deployment Options**
1. **Traditional Worker** (`main.py`): Continuous processing with persistent connections
2. **Azure Function App** (`function_app.py`): Containerized, event-driven processing for Azure Container Apps

### **Benefits**
- **Scalability**: Azure Container Apps provide automatic scaling based on queue depth
- **Cost Efficiency**: Pay-per-execution model for sporadic workloads
- **Reliability**: Built-in retry logic and dead letter queue handling
- **Maintenance**: Reduced operational overhead with managed infrastructure
- **Containerization**: Full Docker support for consistent deployment

## ✅ System Status

**Current Status**: ✅ **PRODUCTION READY**

`Cortex AutoGen` is continuously evolving, with the latest enhancements focused on dynamic agent selection, advanced file handling, specialized task execution, and flexible deployment options. It has been rigorously tested to ensure reliable performance across diverse AI tasks.

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