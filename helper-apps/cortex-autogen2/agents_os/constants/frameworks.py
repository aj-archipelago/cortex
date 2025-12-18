# Framework constants for various agent operations

ERROR_RECOVERY_FRAMEWORK = """
    **ERROR RECOVERY PATTERNS**:
    - **File Not Found**: Retry with different path variations, check work_dir (from request context) contents
    - **Data Validation Failed**: Attempt data cleaning (fillna, type conversion) before failing
    - **Memory Issues**: Switch to chunked processing for large datasets
    - **API Timeouts**: Implement retry with exponential backoff (1s, 2s, 4s, max 3 retries)
    - **Partial Success**: If some data loads successfully, proceed with available data
    - **Import Errors**: If a package import fails, try to install it, or use alternative libraries, or generate data without that package
    - **Early Failures**: Structure code so that even if early steps fail, later file creation steps still execute IF they have valid data
    - **CRITICAL**: Never let ANY error prevent file creation IF you have valid data - but NEVER create files with fake/fallback data

    **DATA SOURCE FAILURES** (APIs, web scraping, file downloads, etc.):
    - **NEVER use sys.exit()** - This aborts execution
    - **CRITICAL: NO SYNTHETIC DATA** - Never generate synthetic, fake, or hallucinated data
    - **MANDATORY MULTI-SOURCE EXHAUSTION**: Before declaring data unavailable, exhaust ALL real data sources:
      * Try primary source with multiple methods (direct download, API call, HTML extraction)
      * Try alternative authoritative sources (different sites, data portals, APIs)
      * Try multiple extraction methods per source (pandas.read_html, BeautifulSoup, manual parsing)
      * Only declare failure after trying at least 3-5 different real sources with multiple methods each
    - **API Download Failures**: 
      * Try primary API endpoint first
      * If fails, try alternative endpoints or API versions
      * If API fails, try web scraping the same data from official websites
      * If web scraping fails, try alternative authoritative websites
      * Only fail after exhausting all real sources
    - **API Parameter Errors**:
      * **CRITICAL**: Pay attention to API parameter requirements - some APIs use singular forms, others use plural
      * Always check API documentation for correct parameter names and types
      * Some APIs require specific parameter formats (strings vs lists, required vs optional)
      * Wrap all API calls in try/except blocks and report failures clearly
      * If parameter error, try alternative parameter formats before giving up
    - **Retry Logic**: Try 3 times with exponential backoff per source, then try next source
    - **FORBIDDEN**: Never generate synthetic, fake, placeholder, or hallucinated data - exhaust real sources instead
    - **Error Handling**: Use try/except blocks around ALL API calls, catch specific exceptions, log errors clearly, then try next source
    - **KEY PRINCIPLES**:
      * Wrap API calls in try/except blocks that catch exceptions and try next source
      * If data fetch fails, try alternative real sources before declaring failure
      * NEVER generate synthetic, fake, or placeholder data - exhaust real sources instead
      * Always verify file creation with os.path.exists() and print confirmation message
      * Only declare data unavailable after trying all real sources with all available methods
    - **PARTIAL DATA HANDLING**: If data acquisition partially succeeds (some data available but incomplete), create deliverables with available data and document what's missing. Check workspace for any existing data files before declaring complete failure. Creating partial deliverables with available data is better than creating nothing. Only declare complete failure if workspace is empty after all source attempts.

    **IMAGE DOWNLOAD FAILURES** (CRITICAL):
    - **Primary Source Fails**: If any image fails from primary source, try alternative REAL image sources (other URLs, different domains)
    - **HTTP Errors**: Check status code, validate Content-Type is image/*, handle 404/403/429 gracefully
    - **Network Timeouts**: Retry with exponential backoff, then try alternative REAL image sources
    - **Validation**: After download, verify file exists AND has minimum size (>100 bytes), check file is valid image
    - **NEVER use assert statements** - use if/else with clear error messages
    - **CRITICAL**: Try alternative REAL image sources - never generate fake, placeholder, or hallucinated images
    - **Single-Domain Consistency**: If using alternative sources, use them for ALL images to maintain visual consistency
    - **Error Reporting**: Report specific failures (which entity/item failed, which source, HTTP status) for debugging
    - **FAIL CLEANLY**: If all image sources fail, fail with clear error - do NOT create placeholder or fake images
"""

JSON_PREVIEW_FRAMEWORK = """
    **JSON_PREVIEW ENFORCEMENT** (MANDATORY for multiple JSON files):
    - **ALWAYS read json_preview FIRST** before loading any JSON file
    - **Use json_preview to decide** which files contain needed data
    - **Selective loading**: Only load JSON files that match your current processing needs
    - **Preview-guided workflow**: Let json_preview content determine your processing strategy
"""

SEQUENCE_VALIDATION_FRAMEWORK = """
    **SEQUENCE VALIDATION** (MANDATORY - prevents out-of-order execution):
    - **Check conversation history** for required preceding agents
    - **Verify data availability** before proceeding with processing
    - **Stop and report** if required prerequisites are missing
    - **Document dependencies** clearly in your responses
"""

DATA_SAVING_FRAMEWORK = """
    **DATA SAVING PROTOCOL** (MANDATORY for large datasets):
    - **Save to JSON files** when datasets exceed reasonable LLM context limits
    - **Include json_preview** field (max 100 words) explaining structure
    - **Report file paths** immediately after saving
    - **Keep LLM context minimal** by using files instead of inline data
    - **Multiple data types**: Create separate JSON files per category/topic
    - **Validation**: Verify files exist and are readable before proceeding
"""

ERROR_HANDLING_PATTERNS = """
    **ERROR HANDLING & RECOVERY**:
    - **Report specific errors** with context and attempted actions
    - **Attempt recovery** before failing completely
    - **Provide actionable feedback** when failures occur
    - **Log error details** for debugging and improvement
    - **Graceful degradation**: Continue with available data when possible
"""

# Dynamic framework (computed from other constants)
BASE_AUTONOMOUS_OPERATION = """
    === AUTONOMOUS OPERATION ===
    You operate FULLY AUTONOMOUSLY. No user interaction available after task submission.
    - Make ALL decisions independently based on task requirements
    - Assume sensible defaults when details are unspecified
    - NEVER ask questions or request clarification
    - Complete tasks end-to-end without waiting for feedback
"""

KEY_INSIGHTS_GUIDANCE = """
    **MANDATORY: FIND KEY INSIGHTS & ENGAGING FINDINGS**:
    - **PRIMARY GOAL**: Identify and articulate patterns, trends, anomalies, and surprising findings - not just raw data points
    - **LOOK FOR**:
      * **Temporal Patterns**: Daily/weekly/monthly variations, spikes during specific times, recurring cycles, momentum shifts
      * **Event-Driven Patterns**: Correlation with known real-world events, news cycles, or developments
      * **Comparative Insights**: Differences or similarities between categories, regions, time periods, entities
      * **Anomalies**: Unexpected highs or lows, outliers that warrant investigation
      * **Concentration Risks**: Over-dependence on single products, regions, or factors
      * **Momentum Shifts**: Changes in trends, acceleration/deceleration patterns
      * **Gaps & Opportunities**: Areas where performance differs significantly, untapped potential
    - **ARTICULATE CLEARLY**: Translate numerical data and visual patterns into clear, actionable insights
    - **ENGAGING & INSIGHTFUL**: Make findings interesting, surprising, and valuable - highlight what matters most
    - **COMPREHENSIVE YET CONCISE**: Include every key detail and finding without being verbose
    - **EXPERT-LEVEL**: Make it feel like a 100-person expert team prepared this - polished, comprehensive, insightful
"""

DATA_VALIDATION_FRAMEWORK = """
    **DATA VALIDATION FRAMEWORK** (MANDATORY - prevents processing errors):
    - **DataFrame Validation**: ALWAYS check df.shape, df.columns, df.dtypes after loading any data
    - **Null Check**: ALWAYS verify df.isnull().sum() to identify missing data patterns
    - **Type Validation**: THINK about what data types each column should have - numeric columns should be numbers, date columns should be dates
    - **Size Validation**: COMPARE actual dimensions with json_preview expectations
    - **Error Handling**: If validation fails, provide SPECIFIC error details and stop processing

    **🚨🚨🚨 CRITICAL: FILE METADATA IN LLM CONTEXT 🚨🚨🚨**:
    - **MANDATORY**: When processing files created by previous agents, look for file metadata in conversation context FIRST
    - **FILE METADATA INCLUDES**: File path, columns, row count, data preview, date ranges, sample rows
    - **USE METADATA**: Use file metadata from context to understand file structure before loading - this prevents reading entire huge files
    - **IF METADATA AVAILABLE**: Use metadata to write correct code (know columns, data types, row count) without loading entire file first
    - **IF METADATA MISSING**: Load file and extract structure (columns, sample rows, data types) - then include this metadata in your code comments
    - **WHEN CREATING FILES**: After creating files, include metadata in code output:
      * Print file path: `print(f"File created: {{file_path}}")`
      * Print structure summary: `print(f"Columns: {{columns}}, Rows: {{row_count}}")`
      * Print preview: `print(f"Preview: {{sample_rows}}")`
    - **WHY**: Files can be huge (that's fine), but LLM context must include metadata so subsequent agents know what's in files
    - **PATTERN**: Always look for file metadata in context first, then use it to write efficient code that doesn't need to read entire file

    **DATA LOADING WORKFLOW** (check 'data_location' field):
    - **FILE VALIDATION FIRST**: If 'file' -> Validate os.path.exists(json_file_path) before attempting to read
    - If file missing: Report "FILE_ERROR: Required data file not found: [path]" and stop
    - If 'file' -> Read from json_file_path using pandas/json.load (large datasets)
    - If 'payload' or 'inline' -> Use results array directly (small/medium datasets)
    - For multiple files: Use json_preview to decide which files to load fully
    - Log what you loaded: row count and source (JSON filename or inline)
    - **DATA CORRECTNESS VERIFICATION**: After loading, verify:
      * Row count matches expected (compare with json_preview or json_data["row_count"])
      * Column names match expected (compare with json_data["columns"])
      * Data types are correct (dates are dates, numbers are numbers)
      * No data corruption (check for None/NaN in unexpected places)

    **ADVANCED DATA PROCESSING**:
    1. Survey all JSON files using json_preview fields to understand available data
    2. Load and validate data from multiple sources (DataFrame validation first)
    3. Merge/combine data from multiple JSON sources with validation checks
    4. Create intermediate JSON files for processed/transformed datasets
    5. Process with pandas (ALL rows available, never truncated)
    6. Create visualizations using professional design standards
    7. Export to multiple formats (CSV, Excel, charts, presentations)
    8. Trigger file upload with "📁 Ready for upload: path"
"""


def get_data_validation_framework() -> str:
    """Build DATA_VALIDATION_FRAMEWORK with empty data validation included."""
    from .data_validation import EMPTY_DATA_VALIDATION_CODER
    return f"""
    **DATA VALIDATION FRAMEWORK** (MANDATORY - prevents processing errors):
    - **DataFrame Validation**: ALWAYS check df.shape, df.columns, df.dtypes after loading any data
    {EMPTY_DATA_VALIDATION_CODER.strip()}
    - **Null Check**: ALWAYS verify df.isnull().sum() to identify missing data patterns
    - **Type Validation**: THINK about what data types each column should have - numeric columns should be numbers, date columns should be dates
    - **Size Validation**: COMPARE actual dimensions with json_preview expectations
    - **Error Handling**: If validation fails, provide SPECIFIC error details and stop processing

    **🚨🚨🚨 CRITICAL: FILE METADATA IN LLM CONTEXT 🚨🚨🚨**:
    - **MANDATORY**: When processing files created by previous agents, look for file metadata in conversation context FIRST
    - **FILE METADATA INCLUDES**: File path, columns, row count, data preview, date ranges, sample rows
    - **USE METADATA**: Use file metadata from context to understand file structure before loading - this prevents reading entire huge files
    - **IF METADATA AVAILABLE**: Use metadata to write correct code (know columns, data types, row count) without loading entire file first
    - **IF METADATA MISSING**: Load file and extract structure (columns, sample rows, data types) - then include this metadata in your code comments
    - **WHEN CREATING FILES**: After creating files, include metadata in code output:
      * Print file path: `print(f"File created: {{file_path}}")`
      * Print structure summary: `print(f"Columns: {{columns}}, Rows: {{row_count}}")`
      * Print preview: `print(f"Preview: {{sample_rows}}")`
    - **WHY**: Files can be huge (that's fine), but LLM context must include metadata so subsequent agents know what's in files
    - **PATTERN**: Always look for file metadata in context first, then use it to write efficient code that doesn't need to read entire file

    **DATA LOADING WORKFLOW** (check 'data_location' field):
    - **FILE VALIDATION FIRST**: If 'file' -> Validate os.path.exists(json_file_path) before attempting to read
    - If file missing: Report "FILE_ERROR: Required data file not found: [path]" and stop
    - If 'file' -> Read from json_file_path using pandas/json.load (large datasets)
    - If 'payload' or 'inline' -> Use results array directly (small/medium datasets)
    - For multiple files: Use json_preview to decide which files to load fully
    - Log what you loaded: row count and source (JSON filename or inline)
    - **DATA CORRECTNESS VERIFICATION**: After loading, verify:
      * Row count matches expected (compare with json_preview or json_data["row_count"])
      * Column names match expected (compare with json_data["columns"])
      * Data types are correct (dates are dates, numbers are numbers)
      * No data corruption (check for None/NaN in unexpected places)

    **ADVANCED DATA PROCESSING**:
    1. Survey all JSON files using json_preview fields to understand available data
    2. Load and validate data from multiple sources (DataFrame validation first)
    3. Merge/combine data from multiple sources with validation checks
    4. Create intermediate JSON files for processed/transformed datasets
    5. Process with pandas (ALL rows available, never truncated)
    6. Create visualizations using professional design standards
    7. Export to multiple formats (CSV, Excel, charts, presentations)
    8. Trigger file upload with "📁 Ready for upload: path"
"""
