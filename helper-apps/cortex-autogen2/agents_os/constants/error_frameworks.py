# Error handling and recovery framework constants

ERROR_RECOVERY_FRAMEWORK = """
    **ERROR RECOVERY PATTERNS**:
    - **File Not Found**: Retry with different path variations, check work_dir (from request context) contents
    - **Data Validation Failed**: Attempt data cleaning (fillna, type conversion) before failing
    - **Data Structure Mismatch**: If downloaded file structure doesn't match expectations:
      * DO NOT fail with "MISSING_STATE_DATA" or similar - instead inspect actual structure and adapt
      * Process available data even if incomplete (e.g., 45 states instead of 51 - process the 45)
      * Print diagnostic: `print(f"Found {len(available_data)} items, expected {expected_count}")`
      * Create files with available data and document any gaps clearly
    - **Parsing Errors (ParserError, ValueError, BadZipFile, JSONDecodeError, etc.)** (UNIVERSAL PRINCIPLE):
      * **PRINCIPLE: RE-DETECT ON ERROR**: When ANY parsing error occurs, inspect file content to detect actual format before retrying
      * **PRINCIPLE: ADAPT TO DETECTED FORMAT**: If format mismatch detected (e.g., HTML saved as .xlsx/.zip), adapt processing to match actual format
      * **PRINCIPLE: COMMON PATTERN**: BadZipFile/ValueError "Excel format cannot be determined" usually means file is HTML - extract tables accordingly
      * **PRINCIPLE: USE AVAILABLE CONTENT**: Check conversation history for HTML from `fetch_webpage` - extract immediately
      * Applies to ANY parsing error, ANY file format, ANY data source
      * **PRINCIPLE: ADAPT TO ACTUAL FORMAT** (Applies to ANY format mismatch):
        * If expected CSV but got HTML → use `pandas.read_html()`
        * If expected ZIP but got HTML → extract data from HTML instead
        * If expected JSON but got HTML/CSV → try alternative parsing
        * If wrong delimiter → detect and use correct one
        * DO NOT retry same parsing method - adapt based on actual file content
        * This applies to ANY format mismatch, ANY error type
      * **PRINCIPLE: INSPECT STRUCTURE** (Applies to ANY structure issue):
        * Print file content sample: `print('\n'.join(open(file).readlines()[:20]))` to see actual structure
        * Check delimiter, headers, metadata rows, column structure
        * This applies to ANY structure mismatch, ANY file format
      * **PRINCIPLE: GRACEFUL FALLBACK** (Applies to ANY parsing failure):
        * Try alternative parsing methods (different delimiter, skip header rows, extract from HTML tables)
        * Try different libraries (pandas → BeautifulSoup → manual parsing)
        * Try different data sources if current source consistently fails
        * This applies to ANY parsing failure, ANY task type
    - **Memory Issues**: Switch to chunked processing for large datasets
    - **API Timeouts**: Implement retry with exponential backoff (1s, 2s, 4s, max 3 retries)
    - **Partial Success**: If some data loads successfully, proceed with available data
    - **Import Errors**: If a package import fails, try to install it, or use alternative libraries, or generate data without that package
    - **Early Failures**: Structure code so that even if early steps fail, later file creation steps still execute
    - **CRITICAL**: Never let ANY error prevent file creation - always have a fallback path that creates files

    **FINANCIAL DATA API FAILURES** (financial data APIs, economic data sources, etc.):
    - **NEVER use sys.exit()** - This aborts execution and prevents fallback strategies
    - **NEVER let API failures abort entire script** - Always create files with fallback data
    - **API Download Failures**: If data download APIs fail, generate realistic synthetic data based on historical patterns and expected data structure
    - **API Parameter Errors**:
      * **CRITICAL**: Pay attention to API parameter requirements - some APIs use singular forms (e.g., 'country'), others use plural (e.g., 'countries')
      * Always check API documentation for correct parameter names and types
      * Some APIs require specific parameter formats (strings vs lists, required vs optional)
      * Wrap all API calls in try/except blocks with fallback data generation
    - **Retry Logic**: Try 3 times with exponential backoff, then switch to fallback data generation
    - **Fallback Data**: Generate realistic synthetic data that matches expected patterns (trends, volatility, ranges, distributions)
    - **Error Handling**: Use try/except blocks around ALL API calls, catch specific exceptions, log errors clearly
    - **Continue Execution**: Even if primary data source fails, continue with fallback data to complete the task
    - **GUARANTEED FILE CREATION**: Structure code so that file creation happens OUTSIDE try/except blocks or in finally blocks - files must ALWAYS be created
    - **KEY PRINCIPLES**:
      * Wrap API calls in try/except blocks that catch exceptions and fall back to synthetic data generation
      * Place file creation code outside the try/except block or in a finally block to ensure it always executes
      * Check if data is empty after fetching and raise exception to trigger fallback if needed
      * Generate realistic fallback data that matches expected structure and patterns
      * Always verify file creation with os.path.exists() and print confirmation message
      * Never let API failures prevent file creation - always have a fallback path

    **IMAGE DOWNLOAD FAILURES** (CRITICAL):
    - **Primary Source Fails**: If any image fails from primary source, switch ALL images to fallback source (maintain consistency)
    - **HTTP Errors**: Check status code, validate Content-Type is image/*, handle 404/403/429 gracefully
    - **Network Timeouts**: Retry with exponential backoff, then try fallback source
    - **Validation**: After download, verify file exists AND has minimum size (>100 bytes), check file is valid image
    - **NEVER use assert statements** - use if/else with clear error messages and fallback logic
    - **Single-Domain Consistency**: If fallback is used, use it for ALL images to maintain visual consistency
    - **Error Reporting**: Report specific failures (which entity/item failed, which source, HTTP status) for debugging
"""

ERROR_HANDLING_PATTERNS = """
    **ERROR HANDLING & RECOVERY**:
    - **Report specific errors** with context and attempted actions
    - **Attempt recovery** before failing completely
    - **Provide actionable feedback** when failures occur
    - **Log error details** for debugging and improvement
    - **Graceful degradation**: Continue with available data when possible
"""

UNIVERSAL_SELF_CORRECTION_FRAMEWORK = """
    **UNIVERSAL SELF-CORRECTION PROTOCOL (CRITICAL)** (Applies to ANY error, ANY task):
    - **DIAGNOSTIC FIRST**: If a tool call or operation fails, your FIRST action must be to DIAGNOSE the state.
      * For SQL: Check table schema (`DESCRIBE table`) or sample data (`SELECT * LIMIT 5`) before retrying complex queries.
      * For Search: Check if your query was too specific. Try broader terms.
      * For Code: Print data structures (`print(df.head())`) before processing.
      * For File Parsing: Inspect file type first - read first 10-20 lines (`print('\n'.join(open(file).readlines()[:20]))`) to detect HTML/CSV/JSON/Excel/ZIP format, then adapt parsing method accordingly.
      * **MANDATORY FORMAT RE-DETECTION**: After ANY parsing error, re-detect file format before retrying.
    - **ASSUMPTION RESET**: Assume your previous understanding was WRONG. Do not blindly retry the same parameters.
    - **ALTERNATIVE PATHS**: If a specific tool or method fails, try a SIMPLER alternative.
      * SQL: If complex JOIN fails, query tables separately and join in python/pandas.
      * Search: If specific site search fails, try general keyword search.
      * File Parsing: If primary parsing fails, detect format and try alternative method.
      * **EXECUTE**: Don't just plan the alternative, **CALL THE TOOL** to execute it.
    - **INCREMENTAL FIXING**: Fix one issue at a time. Verify the fix before moving to the next step.
    - **FAIL SAFE ARTIFACTS**: If you cannot produce the perfect result, produce the BEST POSSIBLE result (e.g., partial data, placeholder file) to keep the workflow moving. NEVER loop indefinitely.
    
    **CIRCUIT BREAKER PATTERN** (Applies to ANY retry scenario, ANY error type):
    - **PRINCIPLE: BREAK LOOPS**: Detect when stuck in retry loops and force alternative strategy:
      * **Loop Detection**: If same error repeats 3+ times, detect loop immediately
      * **Force Format Detection**: When loop detected, MANDATORY format re-detection must occur
      * **Force Alternative Strategy**: Switch to fallback approach immediately when loop detected
      * **Prevent Timeout**: Break loops before timeout occurs
      * **EXECUTE IMMEDIATELY**: Do not describe the circuit breaker action, JUST DO IT. Call the tool.
    - **Generic Circuit Breaker Pattern**:
      * Track error count for each operation
      * When error count >= 3 for same operation → trigger circuit breaker
      * Circuit breaker forces: format detection → alternative method → different source
      * This applies to ANY retry scenario, ANY error type, ANY task
"""
