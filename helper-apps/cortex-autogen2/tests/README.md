# Cortex AutoGen2 Automated Testing Suite

Comprehensive automated testing framework for evaluating and improving the AutoGen2 system quality.

## Features

- ✅ **Automated Test Execution**: Run predefined test cases with zero manual intervention
- 📊 **LLM-Based Evaluation**: Scores progress updates (0-100) and final outputs (0-100) using Cortex API
- 📈 **Performance Metrics**: Track latency, update frequency, error rates, and more
- 🗄️ **SQLite Storage**: All test results, scores, and metrics stored locally
- 💡 **Improvement Suggestions**: LLM analyzes failures and suggests code improvements
- 📉 **Trend Analysis**: Detect quality regressions over time
- 🖥️ **CLI Interface**: Easy-to-use command-line tool

## Quick Start

### 1. Prerequisites

Ensure you have:
- Docker running (for cortex-autogen-function container)
- Redis running (for progress updates)
- Azure Queue setup
- Environment variables configured (.env file)

Required environment variables:
```bash
CORTEX_API_KEY=your_key_here
CORTEX_API_BASE_URL=http://localhost:4000/v1
REDIS_CONNECTION_STRING=redis://localhost:6379
REDIS_CHANNEL=cortex_progress
AZURE_STORAGE_CONNECTION_STRING=your_connection_string
AZURE_QUEUE_NAME=cortex-tasks
```

### 2. Install Dependencies

The testing suite uses the same dependencies as the main project. No additional installation needed.

### 3. Run Tests

```bash
# Run all test cases
python tests/cli/run_tests.py --all

# Run specific test
python tests/cli/run_tests.py --test tc001_pokemon_pptx

# View test history
python tests/cli/run_tests.py --history --limit 20

# View score trend for a test case
python tests/cli/run_tests.py --trend tc001_pokemon_pptx
```

## Test Cases

The suite includes 3 predefined test cases:

### TC001: Pokemon PPTX Presentation
Creates a professional PowerPoint with Pokemon images, tests:
- Image collection (10+ images)
- Professional slide design
- Preview image generation
- File upload with SAS URLs

### TC002: PDF Report with Images
Generates a renewable energy PDF report, tests:
- Web research and image collection
- Chart/graph generation
- PDF formatting
- Document quality

### TC003: Random CSV Generation
Creates realistic sales data CSVs, tests:
- Data generation
- Statistical calculations
- CSV formatting
- Quick task execution

## Architecture

```
tests/
├── orchestrator.py           # Main test execution engine
├── test_cases.yaml           # Test case definitions
├── database/
│   ├── schema.sql            # SQLite database schema
│   ├── repository.py         # Data access layer
│   └── test_results.db       # SQLite database (gitignored)
├── collectors/
│   ├── progress_collector.py # Redis subscriber for progress updates
│   └── log_collector.py      # Docker log parser
├── evaluators/
│   ├── llm_scorer.py         # LLM-based evaluation
│   └── prompts.py            # Evaluation prompts and rubrics
├── metrics/
│   └── collector.py          # Performance metrics calculation
├── analysis/
│   ├── improvement_suggester.py  # LLM-powered suggestions
│   └── trend_analyzer.py     # Trend and regression detection
└── cli/
    └── run_tests.py          # CLI interface
```

## How It Works

1. **Test Submission**: Test orchestrator submits task to Azure Queue
2. **Data Collection**:
   - Progress collector subscribes to Redis for real-time updates
   - Log collector streams Docker container logs
3. **Execution Monitoring**: Wait for task completion or timeout
4. **Data Storage**: Store progress updates, logs, files in SQLite
5. **Metrics Calculation**: Calculate latency, frequency, error counts
6. **LLM Evaluation**:
   - Score progress updates (frequency, clarity, accuracy)
   - Score final output (completeness, quality, correctness)
7. **Analysis**: Generate improvement suggestions and track trends

## Evaluation Criteria

### Progress Updates (0-100)
- **Frequency** (25 pts): Updates every 2-5 seconds ideal
- **Clarity** (25 pts): Emojis, concise, informative
- **Accuracy** (25 pts): Progress % matches work done
- **Coverage** (25 pts): All important steps communicated

### Final Output (0-100)
- **Completeness** (25 pts): All deliverables present
- **Quality** (25 pts): Professional, polished, no placeholders
- **Correctness** (25 pts): Accurate data, no hallucinations
- **Presentation** (25 pts): SAS URLs, previews, clear results

## Database Schema

Test results are stored in `tests/database/test_results.db`:

- **test_runs**: Test execution records
- **progress_updates**: Real-time progress data
- **logs**: Docker log entries
- **files_created**: Generated files with SAS URLs
- **evaluations**: LLM scores and reasoning
- **metrics**: Performance metrics
- **suggestions**: Improvement recommendations

## Example Output

```
🧪 Running Test: Pokemon PowerPoint Presentation with Images
   ID: tc001_pokemon_pptx
   Timeout: 300s

📝 Test run created: ID=1, Request=test_tc001_pokemon_pptx_a3f9b12e
✅ Task submitted to queue
📡 Starting data collection...
   Progress: 10% - 📋 Planning task execution...
   Progress: 25% - 🌐 Collecting Pokemon images...
   Progress: 50% - 💻 Creating PowerPoint presentation...
   Progress: 75% - 📸 Generating slide previews...
   Progress: 100% - ✅ Task completed successfully!
✅ Data collection complete
   Progress updates: 12
   Log entries: 45

📊 Calculating metrics...
   Time to completion: 142.3s
   Progress updates: 12
   Files created: 15
   Errors: 0

🤖 Running LLM evaluation...
   Progress Score: 88/100
   Output Score: 92/100

✨ Evaluation complete:
   Progress Score: 88/100
   Output Score: 92/100
   Overall Score: 90/100

✅ Test Complete: Pokemon PowerPoint Presentation with Images
```

## Extending the Suite

### Add New Test Cases

Edit `tests/test_cases.yaml`:

```yaml
test_cases:
  - id: tc004_my_new_test
    name: "My New Test"
    task: "Test task description..."
    timeout_seconds: 300
    expected_deliverables:
      - type: pdf
        pattern: "*.pdf"
        min_count: 1
    min_progress_updates: 5
    quality_criteria:
      - "Criterion 1"
      - "Criterion 2"
```

### Customize Evaluation

Modify prompts in `tests/evaluators/prompts.py` to change scoring criteria.

### Add New Metrics

Extend `tests/metrics/collector.py` with additional metrics calculation logic.

## Troubleshooting

### No progress updates collected
- Check Redis is running: `redis-cli ping`
- Verify REDIS_CONNECTION_STRING in .env
- Check Docker container is running: `docker ps`

### Database errors
- Delete and recreate: `rm tests/database/test_results.db`
- Schema will auto-recreate on next run

### LLM evaluation fails
- Verify CORTEX_API_KEY is set
- Check CORTEX_API_BASE_URL is accessible
- Review logs for API errors

## Future Enhancements

- [ ] Web dashboard for viewing results
- [ ] CI/CD integration (GitHub Actions)
- [ ] Parallel test execution
- [ ] Screenshot comparison for visual regression
- [ ] Custom test case generator
- [ ] Export reports (PDF, HTML)
- [ ] Slack/email notifications

## License

Part of the Cortex AutoGen2 project.
