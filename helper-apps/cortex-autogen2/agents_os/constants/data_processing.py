# Data Processing and Analysis constants

DATA_COMPLETENESS_ACCURACY = """
**DATA COMPLETENESS & ACCURACY**:
- **Time Series**: When asked for "last 6 months", ensure you have data for the FULL period (e.g., ~26 weeks). Do NOT truncate to 10 weeks.
- **Filtering**: When creating specific data files, FILTER the data to include ONLY matching records. Do not dump unrelated data.
- **Data Queries**: When collecting data, ensure date ranges cover the ENTIRE requested period. Avoid arbitrary limits that cut off required data.
- **Missing optional fields**: If essential data exists but optional fields are unavailable, proceed with essential data. Missing optional enhancements does NOT invalidate essential data.
"""

INPUT_VALIDATION_RULES = """
**MANDATORY INPUT VALIDATION BEFORE CODING**:
- List the exact files/JSON blobs you expect from upstream agents (e.g., `headlines_last30days.json`, `top_authors.csv`, etc.).
- For each requirement, check `os.path.exists` (or verify keys inside JSON) internally. Validate internally - do NOT output validation status messages to users.
- **If ANY required input is missing or empty** (e.g., you only find reference data when the task expects specific inputs), STOP immediately and emit a clear diagnostic. Do **not** proceed with placeholder data or unrelated files.
- NEVER use reference datasets for unrelated tasks. Before loading ANY file, verify it's semantically related to the user's request.
- Never reuse generic reference datasets as substitutes for task-specific inputs. If the only available files don't match the request, indicate which agent should be selected to provide the correct data instead of fabricating results.
- Before generating charts/CSVs that compare multiple sources, validate each source independently; if one side is missing, fail fast with instructions to collect the missing data.
- **Data collection**: Use appropriate methods to collect required data based on task needs.
"""

DATA_PROCESSING_GUIDANCE = """
**ABSOLUTELY FORBIDDEN - NEVER GENERATE SYNTHETIC DATA**:
- **NO SYNTHETIC DATA**: NEVER generate fake, random, or simulated data using np.random, faker, or any other generation method
- **NO RANDOM VALUES**: NEVER create data with random numbers, normal distributions, or artificial patterns
- **FAIL CLEANLY**: If real data sources are unavailable, declare clear failure: "FAILED: No real data sources found for this task"
- **REAL DATA ONLY**: Only collect and process data from actual web sources - NEVER create artificial datasets
- **NO FALLBACK GENERATION**: Do not create "fallback" data generation code - fail with clear error message instead

**CONSISTENT DATA PROCESSING PRINCIPLES**:
- **VALIDATION FIRST**: Always validate data completeness, numeric validity, and scope coverage before processing
- **QUALITY ASSESSMENT**: Official sources preferred; external sources clearly cited with timestamps
- **STRUCTURE PRESERVATION**: Maintain data integrity through all transformation steps
- **ERROR TRANSPARENCY**: Report any data quality issues or transformations applied
- **SOURCE DOCUMENTATION**: Include data source, access date, and any processing notes

**DATA PROCESSING GUIDANCE**:
- **COMPLETE ANALYSIS PREFERRED**: Use full datasets when practical for accurate statistics
- **TRANSPARENT SAMPLING**: If using samples for large datasets, clearly indicate this in analysis
- **DATA INTEGRITY**: Ensure statistical calculations reflect the actual data being analyzed
- **APPROPRIATE METHODS**: Use head(), sample(), or full dataset as appropriate for the task requirements

**ADAPTIVE PROCESSING PRINCIPLE**: When handling structured information, use intelligent identification:
- Auto-detect structural elements using multiple recognition strategies
- Progress through fallback identification methods systematically
- Validate structural integrity before further processing

# ============================================================================
# CRITICAL: UNIVERSAL DATA COLLECTION PRINCIPLES (WORKS FOR ANY TASK)
# ============================================================================

# PRINCIPLE 1: DETECT FILE TYPE BEFORE PROCESSING (MANDATORY FOR ALL FILES)
"""
"MANDATORY DETECTION: Before ANY file processing, detect actual format by inspecting content"
"INSPECT FIRST BYTES: Read first 100 bytes to detect ZIP headers, Excel signatures"
"INSPECT FIRST LINES: Read first 1000 characters to detect HTML tags, JSON brackets, CSV delimiters"
"COMMON MISIDENTIFICATIONS: HTML saved as ZIP/Excel/CSV, Excel saved as ZIP, JSON saved as HTML"
"ADAPT PROCESSING: When detected format differs from filename, adapt parsing strategy accordingly"
"APPLIES TO ALL FILES: Any downloaded file from any source must be format-detected before processing"
"""

# PRINCIPLE 2: ROBUST HTML TABLE EXTRACTION (WORKS FOR ANY WEBSITE)
"""
"MANDATORY EXTRACTION: Use proper HTML table extraction patterns for any website"
"FILE-BASED EXTRACTION: Always use pandas.read_html() on saved HTML files, never on live URLs"
"MULTIINDEX HANDLING: Use header=[0,1] parameter when tables have complex multi-row headers"
"TABLE INSPECTION: Always inspect all tables returned by read_html() to select the correct data table"
"COLUMN SELECTION: After identifying the right table, select appropriate columns by name or position"
"CLEANUP: Remove aggregate rows, convert string numbers to numeric, handle missing data"
"APPLIES TO ALL HTML: Any website with data tables, regardless of structure or complexity"
"""

# PRINCIPLE 3: PROPER HTTP HEADERS (MANDATORY FOR ALL WEB REQUESTS)
"""
"MANDATORY HEADERS: Use complete browser-like headers for ALL web requests"
"USER-AGENT: Include realistic browser User-Agent string to avoid 403 Forbidden errors"
"ACCEPT HEADERS: Include Accept, Accept-Language, Accept-Encoding headers"
"CONNECTION HEADERS: Include Connection and Upgrade-Insecure-Requests headers"
"TIMEOUT HANDLING: Use reasonable timeouts (30 seconds) for all requests"
"APPLIES TO ALL REQUESTS: Any HTTP request for data collection, file downloads, or web scraping"
"""

# PRINCIPLE 4: ROBUST FALLBACK STRATEGY (MANDATORY FOR ALL DATA TASKS)
"""
"MANDATORY FALLBACK: Implement systematic fallback hierarchy for any data collection task"
"PRIMARY SOURCES FIRST: Try official government/authoritative sources first"
"FALLBACK HIERARCHY: Official, Reputable public, Knowledge bases (Wikipedia, etc.)"
"SOURCE VALIDATION: Verify each source contains required data before declaring success"
"ATTEMPT TRACKING: Keep list of all sources attempted for error reporting"
"CIRCUIT BREAKER: Stop after reasonable attempts to avoid infinite loops"
"APPLIES TO ALL TASKS: Any data collection requiring external sources"
"""

# PRINCIPLE 5: CONTENT VALIDATION (MANDATORY FOR ALL DATA)
"""
"MANDATORY VALIDATION: Validate extracted data meets requirements before declaring success"
"EXISTENCE CHECK: Verify data was actually extracted (not None/empty)"
"ROW COUNT VALIDATION: Check minimum expected rows for the dataset type"
"COLUMN PRESENCE: Verify required columns exist in extracted data"
"DATA TYPE VALIDATION: Ensure numeric columns contain valid numbers, not text"
"COMPLETENESS CHECK: Verify no critical columns are entirely null/missing"
"APPLIES TO ALL DATA: Any extracted dataset, regardless of source or format"
"""
"""

FILE_DISCOVERY_LOGIC = """
**CHECK EXISTING FILES FIRST - MANDATORY BEFORE DECLARING RESOURCES UNAVAILABLE**:
- **MANDATORY FIRST STEP**: Before declaring "no data available" or "resources unavailable", check workspace for existing files
- Use `bound_list_files` tool to discover all files in work_dir
- Check for files matching task requirements (CSV, JSON, HTML, Excel, ZIP, etc.)
- Use existing CSV/JSON/HTML/Excel files from web_search_agent or previous agents
- Don't re-fetch data that's already downloaded - process existing files first
- **PROGRESSIVE DISCOVERY**: Check workspace → check context memory → check conversation history → only then declare failure
- **GENERIC PRINCIPLE**: Applies to ANY task requiring files/data - always check workspace state first
"""

DATA_FILE_PARSING = """
**DATA FILE PARSING PRIORITY** (simplest first):
1. CSV/JSON - simplest format, try first
2. HTML files - use pandas.read_html() which returns list of DataFrames, iterate to find correct table
3. Simple Excel - single sheet files work easily
4. Complex Excel - may have merged cells, multi-row headers, multiple sheets - handle carefully

**CRITICAL: DETECT FILE TYPE BEFORE ASSUMING FORMAT** (UNIVERSAL PRINCIPLE):
- **PRINCIPLE: DETECT BEFORE ASSUME**: Inspect file content (first bytes/lines) to determine actual format - filename extension is NOT reliable
- **PRINCIPLE: ADAPT TO DETECTED FORMAT**: When format mismatch detected (HTML saved as .xlsx/.zip/.csv), adapt processing strategy to match actual format
- **PRINCIPLE: CHECK CONVERSATION HISTORY**: Before downloading files, check if HTML content is already available from `fetch_webpage` tool results - extract immediately
- **PRINCIPLE: ERROR-BASED DETECTION**: When BadZipFile/ValueError "Excel format cannot be determined" occurs, re-detect format - likely HTML, extract tables accordingly
- Applies to ANY file, ANY format, ANY task

- **PRINCIPLE: ADAPT TO ACTUAL FORMAT** (Applies to ANY format mismatch):
  * When expected format doesn't match actual format, adapt processing strategy:
    * HTML detected but expected CSV/ZIP/JSON → Use `pandas.read_html()` to extract tables, then process as DataFrame
    * CSV parsing fails → Check delimiter (comma, pipe, tab), check for header rows, inspect structure
    * ZIP extraction fails → Detect actual format (likely HTML), extract data from HTML instead
    * JSON parsing fails → Check if HTML/CSV, try alternative parsing
    * Excel file but wrong sheet → List all sheets, inspect each, select correct one
    * JSON structure differs → Inspect keys/structure, adapt extraction logic
  * This principle applies to ANY format mismatch scenario, ANY data source, ANY task

- **PRINCIPLE: INSPECT STRUCTURE WHEN PARSING FAILS** (Applies to ANY parsing error):
  * When parsing fails, inspect actual file structure before retrying:
    * Print first 20 lines: `print('\n'.join(open(file).readlines()[:20]))`
    * Check delimiter: Count separators in sample lines
    * Check for metadata headers: Look for non-data rows at start
    * Identify actual column structure: Find where real data starts
    * **MANDATORY**: Re-detect format after ANY parsing error - don't retry same approach
  * This principle applies to ANY parsing error, ANY file format, ANY data source

- **PRINCIPLE: GRACEFUL DEGRADATION** (Applies to ANY incomplete data scenario):
  * Process available data even if incomplete:
    * If only partial data found, process what's available and document the gap
    * Print diagnostic: `print(f"Found {len(data)} items, expected {expected_count}, processing available data")`
    * DO NOT fail completely - create deliverables with available data and note limitations
  * This principle applies to ANY data completeness scenario, ANY task type

**CRITICAL: INSPECT FILE STRUCTURE BEFORE PROCESSING**:
- **MANDATORY FIRST STEP**: After downloading a file, ALWAYS inspect its structure before writing processing code:
  * For Excel/CSV: Load file and print `df.columns.tolist()`, `df.head()`, `df.shape` to see actual structure
  * For ZIP files: List contents with `zipfile.ZipFile()`, then inspect the extracted file structure
  * For JSON: Load and print `list(data.keys())` or `data[0].keys()` to see structure
- **ENCODING DETECTION FOR CSV**: When CSV parsing fails with UnicodeDecodeError or ParserError:
  * Try encodings in order: `utf-8`, `ISO-8859-1`, `latin1`, `cp1252`, `utf-16`
  * Inspect first 10 lines with each encoding: `with open(file, 'r', encoding=enc) as f: print(f.readlines()[:10])`
  * Detect delimiter by counting separators in sample lines
  * Check for metadata headers (skiprows parameter)
  * Only after inspection, write parsing code matching actual structure
- **ADAPT CODE TO ACTUAL STRUCTURE**: Write processing code based on what you actually find, not what you assume
- **HANDLE STRUCTURE MISMATCHES**: If file structure doesn't match expectations:
  * Print clear diagnostic: `print(f"File structure: columns={df.columns.tolist()}, rows={len(df)}")`
  * Adapt column names/processing logic to match actual structure
  * Process available data even if incomplete (e.g., if only 45 states found, process those 45)
  * DO NOT fail with "MISSING_STATE_DATA" - instead process what's available and document gaps
- **VALIDATION AFTER INSPECTION**: Only validate data completeness AFTER you've inspected and understood the actual file structure

**HTML TABLE EXTRACTION**:
- pandas.read_html() returns list of ALL tables from HTML file
- Iterate through tables and check each for expected columns/row count
- If pandas.read_html() fails, use BeautifulSoup as fallback
- IMPORTANT: When using `max(candidate_tables, ...)` or picking a table by 'largest rows', ALWAYS check if `candidate_tables` is non-empty first.
  * Example safe pattern: `if not candidate_tables: raise ValueError("No candidate tables found - replan")` before calling `max(...)`.
  * This prevents `ValueError: max() arg is an empty sequence` and makes failures explicit for replanning.
- Avoid inserting raw text tokens like `VISUAL PROGRESS: ...` or `PDF PROGRESS:` directly into the generated Python code (it breaks syntax). Use `print("VISUAL PROGRESS: ...")` or `# comment` instead.

**COMPLEX FILE HANDLING**:
- If Excel parsing fails after 2 attempts, request simpler source from web_search_agent
- HTML tables from Wikipedia-style sites are often easier than complex government Excel files
"""

HTML_DATA_EXTRACTION = """
**CRITICAL: EXTRACT FROM EXISTING HTML FILES**: When HTML files already exist in the working directory:
  * **DO NOT** just copy or recreate the HTML file - EXTRACT DATA FROM IT IMMEDIATELY
  * **IMMEDIATE EXTRACTION**: Use pandas.read_html() directly on the file path - this extracts ALL tables automatically
  * **TABLE SELECTION**: After extraction, identify the correct table by checking row counts and column names that match task requirements (use LLM reasoning to determine which table contains the needed data)
  * **VERIFY DATA**: After extraction, verify you got the required data (check row counts and data completeness match task requirements)
  * **PROCESS IMMEDIATELY**: Once data is extracted, process it to create required deliverables - DO NOT wait or create placeholder files
  * **NO DUPLICATE HTML FILES**: If an HTML file already exists, extract data from it - do not create another HTML file
  * **WORKFLOW**: HTML file exists → Extract tables with pandas.read_html(file_path) → Find correct table → Process data → Create deliverables → Mark files ready for upload
  * **CRITICAL**: pandas.read_html() works on FILE PATHS, not URLs when custom headers are needed. Always read from saved HTML files that web_search_agent created.
  * **CHECK HTML FIRST**: Before waiting for CSV files or other data formats, check if HTML files exist in the working directory - HTML often contains the data you need

**GENERIC HTML TABLE EXTRACTION**: Many data sources provide data in HTML tables. Try pandas.read_html(url) first - it automatically extracts all tables from HTML pages. This works for most government sites, data portals, and official sources.

**EXTRACT FROM FETCHED HTML**: When `fetch_webpage` tool results show a "saved_html" field:
  * **CRITICAL**: The JSON response does NOT contain HTML content (kept minimal to save context) - use the "saved_html" file path instead
  * **USE SAVED FILE**: Use pandas.read_html(saved_html_path) directly on the file path - it contains the complete, untruncated HTML
  * **VERIFY COMPLETENESS**: After extraction, verify you got all required rows based on task requirements (use LLM reasoning to determine expected row count)
  * **MULTIPLE TABLES**: HTML pages often have multiple tables - extract ALL of them and find the one with the data you need
  * **TABLE SELECTION**: Look for tables with the most rows and columns matching your requirements (check column names against task requirements)
  * If pandas.read_html() fails or returns incomplete data, use BeautifulSoup to parse and extract table data manually
  * **COMPLETE EXTRACTION**: Ensure you extract ALL rows required by the task - don't stop at first row or partial data
  * Save extracted data as CSV/JSON immediately with ALL rows
  * **NOTE**: If "saved_html" field is missing (backward compatibility), the JSON may contain truncated HTML in "html" field - but prefer using saved files when available

**FALLBACK HTML PARSING**: If pandas.read_html() fails (missing dependencies, parsing errors), ALWAYS use requests + BeautifulSoup to parse HTML and extract table data manually:
  * **PRINCIPLE: USE BROWSER-LIKE HEADERS**: When making HTTP requests, always include User-Agent header to avoid 403/blocking errors - many sites block requests without proper headers
  * Fetch HTML with requests.get(url, headers=dict with User-Agent set to browser-like string like "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36")
  * Parse with BeautifulSoup(html, 'html.parser')
  * Find tables with soup.find_all('table')
  * Extract rows and cells manually
  * Convert to pandas DataFrame or save directly as CSV

**JAVASCRIPT-RENDERED PAGES**: For FRED, World Bank, and other modern sites with JavaScript-rendered tables:
  * **MANDATORY**: Use `fetch_webpage(url, render=True)` to get fully rendered HTML with tables
  * **CRITICAL**: If pandas.read_html() on saved HTML returns empty list, the page likely needs JavaScript rendering
  * **WORKFLOW**: fetch_webpage(render=True) → save HTML → pandas.read_html(saved_file) → if empty, use BeautifulSoup fallback
  * **DETECTION**: If HTML file exists but pandas.read_html() finds no tables, re-fetch with render=True

**DEPENDENCY INDEPENDENCE**: BeautifulSoup works without html5lib/lxml - use it as reliable fallback when pandas.read_html() fails

**PROACTIVE BATCHING FOR NETWORK OPERATIONS**: For network operations (scraping, API calls) with 10+ items, ALWAYS batch into groups of 5-8 with checkpoint files. Create checkpoint CSV/JSON after each batch. Never attempt all items in single execution.
"""

DOWNLOAD_FAILURE_HANDLING = """
**DOWNLOAD_FILE TOOL FAILURE HANDLING**:
- **CRITICAL**: When download_file tool returns "Error downloading file: ... returned an HTML page", this is NOT necessarily a failure
- **HTML PAGES ARE VALID DATA SOURCES**: Many government and official data sources provide data in HTML tables, not direct file downloads
- **GENERIC HTML DATA EXTRACTION**: When download_file returns HTML page error, generate Python code that:
  * **PRINCIPLE: USE BROWSER-LIKE HEADERS**: Always include User-Agent header in HTTP requests to avoid 403/blocking errors
  * Uses requests.get(url, headers=dict with User-Agent set to browser-like string like "Mozilla/5.0...") to fetch the HTML page (or use the URL that was attempted)
  * Parses HTML with pandas.read_html() first (simplest - automatically extracts tables)
  * If pandas.read_html() doesn't work, use BeautifulSoup to parse HTML and extract table data
  * Extracts structured data from HTML tables (look for <table> tags, data tables, etc.)
  * Saves extracted data as CSV/JSON
- **CIRCUIT BREAKER**: After 2 failed download_file attempts with same URL, switch to HTML parsing approach - HTML pages often contain the data you need
- **RECOGNIZE ERROR STRINGS**: Tool results starting with "Error downloading file:" mean the URL returned HTML - extract data from that HTML instead
"""

LOOP_PREVENTION = """
**CRITICAL LOOP PREVENTION - FILE CHECKING**:
- **LOOP DETECTION**: Before checking for a file with bound_list_files, check conversation history for previous file checks
- **MAXIMUM 3 CHECKS**: If you've checked for the same file 3+ times and it's still missing, STOP checking
- **GENERATE CODE INSTEAD**: If a required data file is missing after 3 checks, generate Python code to:
  * Fetch data from URLs provided by web_search_agent (scrape HTML tables, use APIs, parse JSON)
  * Extract structured data from web pages or APIs
  * Create the required CSV/JSON file yourself
- **DO NOT WAIT**: Never wait for files to be "uploaded" - if web_search_agent provided URLs, generate code to fetch the data
- **ANTI-LOOP RULE**: If you see the same "⛔ Cannot proceed" or "⛔ Still blocked" message repeated 3+ times, acknowledge the loop and generate code to fetch data instead
- **DATA SOURCE PRIORITY**: When web_search_agent provides URLs (government sites, data portals, APIs, etc.), ALWAYS generate code to fetch data from those URLs rather than waiting for file uploads
- **CRITICAL: CHECK CONVERSATION HISTORY FOR SAVED HTML FILES**: Before waiting for file uploads, check conversation history for successful `fetch_webpage` tool calls
  * If `fetch_webpage` returned a "saved_html" field (file path), use that file path immediately for pandas.read_html()
  * DO NOT wait for CSV files - saved HTML files ARE data, extract from them immediately
  * Example: If conversation shows fetch_webpage returned JSON with "saved_html": "/path/to/file.html", extract tables from that file NOW
  * **DIRECT EXTRACTION FROM SAVED FILES**: If you see `fetch_webpage` tool results with "saved_html" field:
    1. Look for `"saved_html": "/path/to/file.html"` in previous tool results
    2. Use pandas.read_html(saved_html_path) directly on the file path
    3. Extract tables and save as CSV/JSON immediately - don't wait for files to be created
  * **NOTE**: The JSON response does NOT contain HTML content (kept minimal) - the full HTML is ONLY in the saved file
"""

GENERIC_DATA_STRATEGY = """
**GENERIC STRATEGY** (Applies to ANY data acquisition task):
  When direct file downloads aren't available:
  1. Check conversation history for fetched HTML first - extract from that
  2. If no HTML in history, fetch HTML page with requests
  3. Extract tables with pandas.read_html() or BeautifulSoup
  4. Clean and process extracted data
  5. Save as CSV/JSON for analysis

**UNIVERSAL FALLBACK HIERARCHY** (Applies to ANY data source, ANY file format):
  **PRINCIPLE: FALLBACK WHEN PRIMARY FAILS**: When primary approach fails, systematically try alternative approaches:
  1. **Primary approach** (e.g., direct file download, primary API endpoint)
  2. **Alternative format/method** (e.g., if ZIP fails, try CSV direct, if CSV fails, try HTML extraction)
  3. **Different parsing approach** (e.g., if pandas.read_csv fails, try pandas.read_html, if that fails, try BeautifulSoup)
  4. **Different data source** (e.g., if primary source fails, try alternative authoritative sources)
  5. **Maximum retry limit**: Each approach has max 3 retries to prevent infinite loops
  6. **Circuit breaker**: If same error repeats 3+ times, immediately switch to next fallback level

**MULTIPLE SOURCE ATTEMPTS**: If one source fails, try alternative authoritative sources (different sites, data portals, official sources)
  * This applies to ANY data acquisition task, ANY domain, ANY data type
"""

WORKSPACE_STATE_AWARENESS = """
**WORKSPACE STATE AWARENESS - MANDATORY BEFORE DECLARING RESOURCES UNAVAILABLE**:

**CRITICAL PRINCIPLE**: Before declaring "no data available", "resources unavailable", or "waiting for user upload", you MUST check workspace state and context memory.

**PROGRESSIVE RESOURCE DISCOVERY CHECKLIST** (execute in order):
1. **CHECK WORKSPACE FILES FIRST**:
   - Use `bound_list_files` tool to list all files in work_dir
   - Look for files matching task requirements (extensions: .csv, .xlsx, .json, .html, .zip, etc.)
   - Check file names for keywords related to task (e.g., "gdp", "state", "data", etc.)
   - If files exist, process them immediately - DO NOT wait for "user upload"
   - **GENERIC**: Applies to ANY task - always check workspace before declaring resources unavailable

2. **CHECK CONTEXT MEMORY**:
   - Review conversation history for file creation/download events
   - Look for "File created:", "Successfully downloaded", or file paths mentioned
   - Check for tool execution results that created files
   - If files were created/downloaded, locate and process them

3. **CHECK CONVERSATION HISTORY**:
   - Search for file paths mentioned by previous agents
   - Look for internal "Ready for upload" markers indicating files were created (these are system signals, NOT user-facing messages)
   - Check for agent accomplishments mentioning file creation
   - Extract file paths from previous agent outputs

4. **ONLY AFTER ALL CHECKS**: If workspace is empty AND context memory shows no files AND conversation history has no file references, then declare resources unavailable

**STATE DETECTION AND RECOVERY**:
- **Files exist but not processed**: Route to processing agent (e.g., coder_agent) with instruction to process existing files
- **Files processed but not uploaded/presented**: Route to presenter_agent (handles both upload and presentation)
- **Partial success detected**: Process available files, don't wait for missing ones

**BREAKING WAITING LOOPS**:
- If you see repeated "waiting for upload" or "no data available" messages, check workspace immediately
- If files exist in workspace, process them instead of waiting
- Use state detection to identify what's already done vs. what's missing
- Provide specific recovery guidance: "Files exist in workspace: [list files]. Route to [agent] to process them."

**GENERIC PRINCIPLE**: This applies to ANY task, ANY agent, ANY resource type. Always check workspace state before declaring resources unavailable.
"""

EMPTY_DATA_FILE_PREVENTION = """
**CRITICAL: EMPTY DATA FILE PREVENTION** (Applies to ANY data file creation):
- **MANDATORY VALIDATION**: Before creating any CSV/JSON/data file:
  1. **Check data exists**: Validate row count > 0 before creating file: `if len(df) == 0: raise ValueError("Cannot create CSV: No data rows available")`
  2. **Match task requirements**: Ensure created files match task intent (e.g., "CSV with headlines" means actual headlines, not empty file)
  3. **Fail cleanly on empty**: If validation fails, raise ValueError with clear message explaining why (e.g., "No published headlines found in requested date range: last 31 days")
- **FORBIDDEN**: Do NOT create empty CSVs/JSONs with only headers when task expects data
- **FORBIDDEN**: Do NOT create placeholder files with just column headers
- **GENERIC PRINCIPLE**: Applies to ANY data file creation task, ANY format (CSV, JSON, Excel), ANY data source
- **CLEAN FAILURE**: When data is unavailable, fail immediately with clear error - let system handle recovery, don't mask with empty files
"""

DATE_RANGE_FILTERING_CLEAN_FAILURE = """
**CRITICAL: DATE RANGE FILTERING - CLEAN FAILURE** (Applies to ANY date-filtered data task):
- **MANDATORY CHECK**: When filtering SQL query results by date range results in zero records:
  1. **Fail cleanly**: Raise ValueError with clear message: `raise ValueError("No data found in requested date range: [range]. Query returned [X] records from broader range [broader_range], but none match requested range.")`
  2. **No empty file creation**: Do NOT create empty CSVs/JSONs with only headers
  3. **Clear error context**: Include in error message: requested date range, why zero records, and what data exists (if any in broader query)
  4. **Let system handle**: Allow planner_agent or execution_completion_verifier_agent to detect failure and provide recovery guidance
- **GENERIC PRINCIPLE**: This applies to ANY date-filtered data processing task, ANY SQL query result, ANY CSV/JSON generation
- **TASK INTENT PRESERVATION**: If task explicitly requests data files (e.g., "CSV with headlines"), fail cleanly if no data exists rather than creating empty files
"""
