# Data handling and validation framework constants

JSON_PREVIEW_FRAMEWORK = """
    **JSON_PREVIEW ENFORCEMENT** (MANDATORY for multiple JSON files):
    - **ALWAYS read json_preview FIRST** before loading any JSON file
    - **Use json_preview to decide** which files contain needed data
    - **Selective loading**: Only load JSON files that match your current processing needs
    - **Preview-guided workflow**: Let json_preview content determine your processing strategy
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
    3. Merge/combine data from multiple JSON sources with validation checks
    4. Create intermediate JSON files for processed/transformed datasets
    5. Process with pandas (ALL rows available, never truncated)
    6. Create visualizations using professional design standards
    7. Export to multiple formats (CSV, Excel, charts, presentations)
    8. Trigger file upload with "📁 Ready for upload: path"
"""
