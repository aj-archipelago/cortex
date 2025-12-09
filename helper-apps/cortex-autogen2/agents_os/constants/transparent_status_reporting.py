# Transparent Status Reporting constants

TRANSPARENT_STATUS_REPORTING_FRAMEWORK = """
**INTERNAL STATUS TRACKING** (for agent coordination via context memory only):
- Status information is for internal agent coordination via context memory only
- Do NOT output status messages to users
- Output only final results

**INTERNAL AGENT COMMUNICATION** (system logs and context memory only):
- Track status internally for agent-to-agent communication via context memory
- Use structured status information internally (success elements, failure elements, partial results, metadata)
- Do NOT output status messages as user-facing text
- Status tracking helps agents coordinate but is NOT visible to users

**CRITICAL**: All status reporting is INTERNAL ONLY. Users see only final results.
"""

WEB_SEARCH_TRANSPARENT_REPORTING = """
**WEB_SEARCH_AGENT TRANSPARENT REPORTING**:
- **DOWNLOAD STATUS DETAILS**: Report exactly what was downloaded, what failed, and file locations
- **CONTENT ANALYSIS**: Describe the type and quality of collected content
- **EXTRACTION READINESS**: Indicate if data is ready for processing or needs further extraction
- **ALTERNATIVE OPTIONS**: Suggest specific fallback approaches if primary downloads failed
- **SOURCE METADATA**: Include URLs, timestamps, data vintages, and quality assessments
"""

CODER_AGENT_TRANSPARENT_REPORTING = """
**CODER_AGENT TRANSPARENT REPORTING**:
- **EXECUTION STATUS**: Report code execution success/failure with specific error details
- **FILE CREATION STATUS**: List all files created with paths, sizes, and validation results
- **DATA QUALITY METRICS**: Provide statistics about generated/processed data
- **PROCESSING DECISIONS**: Explain what approach was chosen and why
- **VALIDATION RESULTS**: Report data validation outcomes and any quality issues found
"""

UPLOAD_TRANSPARENT_REPORTING = """
**UPLOAD_AGENT TRANSPARENT REPORTING**:
- **UPLOAD STATUS**: Detail which files were uploaded successfully vs. failed
- **URL GENERATION**: Confirm SAS URL creation and accessibility
- **ERROR DETAILS**: Provide specific upload failure reasons and retry suggestions
- **BATCH RESULTS**: Summarize total files processed, uploaded, and any issues
"""
