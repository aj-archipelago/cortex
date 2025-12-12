"""
LLM-powered worklog and learnings extractor.

Uses LLM to intelligently extract worklog entries and learnings from agent messages
instead of static pattern matching.
"""
import logging
import re
from typing import Dict, Any, Optional, List
from autogen_core.models import UserMessage

logger = logging.getLogger(__name__)


async def extract_worklog_and_learnings(
    agent_name: str,
    message_content: str,
    message_type: str,
    model_client,
    task_id: str
) -> Dict[str, Any]:
    """
    Use LLM to extract worklog entry and learnings from agent message.
    
    Returns:
        {
            "worklog": {"work_type": str, "description": str, "status": str} or None,
            "learnings": [{"learning_type": str, "content": str}] or []
        }
    """
    if not model_client:
        logger.warning(f"No model_client provided for worklog extraction from {agent_name}")
        return {"worklog": None, "learnings": []}
    
    if not message_content or len(message_content) < 20:
        logger.debug(f"Message content too short ({len(message_content) if message_content else 0} chars) for {agent_name}")
        return {"worklog": None, "learnings": []}
    
    # Increase content limit to capture more details (especially for code execution messages)
    content_limit = 8000 if message_type in ["ToolCallRequestEvent", "ToolCallExecutionEvent"] else 5000
    
    # For structured messages (FunctionCall, FunctionExecutionResult), extract meaningful content
    # The LLM will handle parsing these intelligently
    
    try:
        # Build prompt for LLM to extract worklog and learnings with ACTUAL concrete details, then genericize
        message_preview = message_content[:content_limit]
        
        # Build prompt using string concatenation to avoid f-string complexity
        prompt = "Analyze this agent message and extract worklog and learnings with ACTUAL concrete details from the message content. Extract SPECIFIC information, then genericize for reusability.\n\n"
        prompt += f"Agent: {agent_name}\n"
        prompt += f"Message Type: {message_type}\n"
        prompt += "Message Content:\n"
        prompt += f"{message_preview}\n\n"
        prompt += "**CRITICAL**: Extract ACTUAL specifics from the message content - actual code snippets, actual URLs, actual error messages, actual methods used. Then GENERICIZE them to remove environment-specific details (paths, request IDs, temporary URLs) so they're reusable across different environments/requests.\n\n"
        prompt += "Respond in JSON format:\n"
        prompt += """{
    "worklog": {
        "work_type": "planning|code_execution|file_generation|file_upload|data_collection|validation|tool_execution|agent_action",
        "description": "EXACTLY ONE sentence (max 100 words) describing WHAT ACTUALLY HAPPENED - be SPECIFIC about working URLs, methods, code. Include actual URLs (remove only SAS tokens), actual file names, actual methods (e.g., 'pandas.read_html()'). NOT '/tmp/coding/req_xxx/file.csv' but 'Generated file.csv using pandas.DataFrame.to_csv()'. Keep actual working URLs like 'https://apps.bea.gov/iTable/?reqid=70' (remove only sig= tokens).",
        "status": "completed|in_progress|failed",
        "details": {
            "sql_queries": ["Extract ACTUAL SQL queries from message if present. Keep the EXACT working query structure with actual table names. Example: 'SELECT post_author, COUNT(*) FROM ucms_aje.wp_posts WHERE post_status='publish' AND YEAR(post_date)=YEAR(CURDATE()) GROUP BY post_author ORDER BY COUNT(*) DESC LIMIT 50'. Keep actual table names, actual column names, actual WHERE conditions that worked."],
            "code_patterns": ["Extract ACTUAL working code patterns from message. Keep SPECIFIC code that worked - actual imports, actual function calls, actual operations, actual parameters. Example: 'import pandas as pd; from io import StringIO; df = pd.read_html(StringIO(html_content))[0]', 'df.groupby('state').agg({\"gdp\": \"sum\"})', 'matplotlib.pyplot.bar(top10[\"state\"], top10[\"gdp_millions\"]/1000.0)', 'reportlab.platypus.SimpleDocTemplate(pdf_path, pagesize=letter)'. Keep actual working code patterns that can be reused directly."],
            "errors": ["Extract ACTUAL error messages from message if any. Include full error text AND attempt order if available. Example: '1st attempt: KeyError: post_author', '2nd attempt: ValueError: No tables found in BEA HTML file', '3rd attempt: FileNotFoundError: No HTML file with BEA GDP data found'. Include which attempt failed and what the error was."],
            "error_fixes": ["Extract ACTUAL fixes from message if any. Show what was changed AND which attempt this fix was applied to. Example: '2nd attempt fix: Used result.get('data', []) before accessing', '4th attempt fix: Switched from direct CSV download to HTML table extraction using pandas.read_html()'. Include attempt order to show progression of fixes."],
            "data_sources": ["Extract ALL data source attempts - BOTH failed AND successful. Include attempt order if available (1st attempt, 2nd attempt, etc.). For each source, include: actual URLs (remove only SAS tokens/expiration params), success/failure status, error message if failed. Example: '1st attempt: https://apps.bea.gov/api/data?format=csv - FAILED (404 Not Found)', '2nd attempt: https://fred.stlouisfed.org/series/GDP - FAILED (empty results)', '5th attempt: https://apps.bea.gov/iTable/?reqid=70&step=30 - SUCCESS (HTML table extraction via pandas.read_html())'. This helps next time to skip failed attempts and try successful one first, but also know what alternatives exist."],
            "tools_used": ["Extract ACTUAL tools/functions used. Include actual function names. Example: 'fetch_webpage_bound()', 'execute_code_bound()', 'pandas.read_html()', 'upload_files_bound()'"],
            "files_created": ["Extract ACTUAL files created with actual names. Example: 'us_state_gdp_2025.csv', 'top10_state_gdp_bar_2025.png', 'apps_bea_gov_iTable.html'"],
            "key_operations": ["Extract SPECIFIC operations - remove only paths. Example: 'Extracted tables from HTML using pandas.read_html(StringIO(html_content))', 'Identified table with state and GDP columns by checking column names', 'Filtered out aggregate rows containing keywords: total, region, divisions', 'Generated bar chart using matplotlib.pyplot.bar() with top N items' NOT 'Extracted from /tmp/coding/req_xxx/apps_bea_gov_iTable.html'"]
        }
    },
    "learnings": [
        {
            "learning_type": "planning_approach|code_generation|presentation_approach|data_source|problem_solving|decision|best_practice|error_fix|breakthrough",
            "content": "Learning content (1-2 sentences) - be SPECIFIC about what actually worked or failed, include actual methods/patterns",
            "details": {
                "what_worked": "SPECIFIC pattern/method that worked - include actual working URLs (remove only SAS tokens), actual working code patterns, actual methods, AND which attempt this was. Example: '5th attempt SUCCESS: https://apps.bea.gov/iTable/?reqid=70&step=30 - HTML table extraction using pandas.read_html(StringIO(html_content)) successfully extracted GDP table' NOT 'from /tmp/coding/req_xxx/apps_bea_gov_iTable.html' (remove paths but keep working URLs)",
                "what_failed": "SPECIFIC failed attempts with attempt order - include actual URLs/methods that failed, actual error messages, AND which attempts failed. Example: '1st attempt FAILED: Direct CSV download from https://apps.bea.gov/api/data?format=csv - 404 Not Found', '2nd attempt FAILED: FRED API at https://fred.stlouisfed.org/series/GDP - empty results', '3rd attempt FAILED: Wikipedia scraping - no tables found', '4th attempt FAILED: World Bank API - timeout error'. Include ALL failed attempts with order so next time can skip them but know alternatives exist.",
                "breakthrough": "SPECIFIC breakthrough with full attempt history - include actual working URL (remove only SAS tokens/expiration params), actual method that worked, attempt order, AND what failed before. Example: 'BREAKTHROUGH (found on 5th attempt after 4 failures): Data found at https://apps.bea.gov/iTable/?reqid=70&step=30 using fetch_webpage_bound() then pandas.read_html(StringIO(html_content)). Failed attempts: 1st (CSV download 404), 2nd (FRED API empty), 3rd (Wikipedia no tables), 4th (World Bank timeout). NEXT TIME: Try https://apps.bea.gov/iTable/?reqid=70 FIRST, skip attempts 1-4, but keep 6th+ alternatives ready if needed'"
            }
        }
    ] or [] if no learnings
}

**CRITICAL EXTRACTION RULES - KEEP SPECIFIC WORKING PATTERNS, REMOVE ONLY PATHS/TOKENS**:
- **EXTRACT SPECIFIC WORKING PATTERNS**: Keep actual working URLs, code, queries - remove ONLY environment-specific paths/tokens
- **Description**: Must be SPECIFIC about working URLs, methods, code. Include actual URLs (remove only SAS tokens), actual file names, actual methods. NOT "/tmp/coding/req_xxx/file.csv" but "Generated file.csv using pandas.DataFrame.to_csv()". Keep actual working URLs like "https://apps.bea.gov/iTable/?reqid=70&step=30" (remove only sig= tokens)
- **SQL queries**: Extract the ACTUAL working query with actual table names - keep it specific. Example: "SELECT post_author, COUNT(*) FROM ucms_aje.wp_posts WHERE..." - keep actual table/column names
- **Code patterns**: Extract ACTUAL working code patterns - keep them specific. Example: "pandas.read_html(StringIO(html_content))", "df.groupby('state').agg()", "matplotlib.pyplot.bar()" - keep actual working code
- **Errors**: Extract ACTUAL error messages with attempt order - keep them specific. Example: "1st attempt: ValueError: No tables found", "2nd attempt: KeyError: missing column"
- **Error fixes**: Extract ACTUAL fix patterns with attempt order - keep them specific. Example: "2nd attempt fix: Switched from direct CSV download to HTML table extraction using pandas.read_html()"
- **Data sources**: Extract ALL attempts (failed AND successful) with attempt order and actual URLs. Example: "1st attempt: https://apps.bea.gov/api/data?format=csv - FAILED (404)", "5th attempt: https://apps.bea.gov/iTable/?reqid=70&step=30 - SUCCESS" - keep actual URLs, remove only SAS tokens
- **Tools used**: Extract ACTUAL function/tool names - keep them specific. Example: "fetch_webpage_bound()", "pandas.read_html()", "upload_files_bound()"
- **Files created**: Extract actual file names/types - remove only paths. Example: "aja_aje_daily_article_counts_60d_2025.csv" NOT "/tmp/coding/req_xxx/aja_aje_daily_article_counts_60d_2025.csv"
- **Key operations**: Extract SPECIFIC operations - remove only paths. Example: "Extracted tables from HTML using pandas.read_html(StringIO(html_content))" NOT "Extracted from /tmp/coding/req_xxx/apps_bea_gov_iTable.html"
- **Learnings**: Must be SPECIFIC and REUSABLE - include actual URLs (remove only tokens), actual code, actual methods - NOT environment-specific paths
- **Breakthroughs**: Must include SPECIFIC source URL/method (remove only SAS tokens) with attempt order. Example: "BREAKTHROUGH (5th attempt): Data found at https://apps.bea.gov/iTable/?reqid=70&step=30 using fetch_webpage_bound() then pandas.read_html()" NOT generic "bea.gov"
- **PRIORITIZATION**: If data was found after multiple attempts, include ALL failed attempts (1st-4th) AND successful one (5th). Example: "1st-4th attempts FAILED: [list], 5th attempt SUCCESS: https://apps.bea.gov/iTable/?reqid=70 - NEXT TIME: Try 5th FIRST, skip 1st-4th"

**EXAMPLES OF GOOD EXTRACTION**:
- Bad description: "Executed web search for GDP data"
- Good description: "Searched for 'Gross domestic product (GDP) by state BEA CSV latest annual data' and found BEA Interactive Data Application at https://apps.bea.gov/itable/?ReqID=70&step=1"

- Bad details: {"code_patterns": ["pandas", "matplotlib"]}
- Good details: {"code_patterns": ["pandas.read_html(StringIO(html_content))", "df.groupby('state').agg()", "matplotlib.pyplot.bar(top10['state'], top10['gdp_millions']/1000.0)", "reportlab.platypus.SimpleDocTemplate(pdf_path)"]}

- Bad learning: "Data found from official sources"
- Good learning: {"learning_type": "data_source", "content": "BREAKTHROUGH (found on 5th attempt): GDP data extracted from bea.gov Interactive Data Application using fetch_webpage_bound() to save HTML, then pandas.read_html(StringIO(html_content)) to extract tables. NEXT TIME: Try bea.gov Interactive Data Application FIRST using HTML table extraction, skip direct CSV download and FRED API attempts", "details": {"what_worked": "fetch_webpage_bound() with render=true saved full HTML, then pandas.read_html(StringIO(html_content)) successfully extracted state GDP table", "what_failed": "Direct CSV download from BEA API failed with 404, FRED API returned empty results", "breakthrough": "bea.gov Interactive Data Application - HTML table extraction via pandas.read_html() (found on 5th attempt, should be tried FIRST next time)"}}

**EXTRACTION PROCESS**:
1. **READ THE MESSAGE CONTENT CAREFULLY** - Look for actual code, URLs, file names, error messages, function calls
2. **EXTRACT SPECIFICS** - Don't summarize, extract actual details from the message
3. **FOR CODE MESSAGES**: Extract actual imports, function calls, operations, file operations
4. **FOR SEARCH MESSAGES**: Extract actual search queries, URLs found, methods used
5. **FOR ERROR MESSAGES**: Extract actual error text, what failed, how it was fixed
6. **FOR FILE OPERATIONS**: Extract actual file names, paths, operations performed

**NOW EXTRACT FROM THE MESSAGE CONTENT ABOVE - BE SPECIFIC AND CONCRETE**:"""

        # Call LLM
        response = await model_client.create(
            messages=[UserMessage(content=prompt, source="worklog_extractor")]
        )
        
        # Extract JSON from response using centralized utility
        from util.json_extractor import extract_json_from_model_response
        
        # Debug: Log raw response for troubleshooting
        logger.debug(f"Raw LLM response type: {type(response)}")
        if hasattr(response, 'content') and response.content:
            logger.debug(f"Response content type: {type(response.content)}, length: {len(response.content) if isinstance(response.content, list) else 'N/A'}")
            if isinstance(response.content, list) and len(response.content) > 0:
                first_item = response.content[0]
                logger.debug(f"First content item type: {type(first_item)}")
                if hasattr(first_item, 'text'):
                    logger.debug(f"Response text preview: {first_item.text[:200]}...")
        
        result = extract_json_from_model_response(response, expected_type=dict, log_errors=True)
        
        if result:
            # Handle both dict and list responses (defensive)
            if isinstance(result, dict):
                worklog = result.get("worklog")
                learnings = result.get("learnings", [])
            else:
                # If result is not a dict (e.g., list), treat as no extraction
                logger.warning(f"LLM returned non-dict result for {agent_name}: {type(result).__name__}")
                worklog = None
                learnings = []
            
            # Clean extracted data - remove environment-specific paths, keep working URLs/code
            if worklog and isinstance(worklog, dict):
                if not worklog.get("description"):
                    logger.warning(f"LLM returned worklog without description for {agent_name}")
                    worklog = None
                else:
                    # Clean description - remove only paths, keep working URLs/code
                    worklog["description"] = _clean_text(worklog["description"])
                    
                    # Clean details - only remove environment-specific paths, keep working URLs/code
                    if worklog.get("details"):
                        details = worklog["details"]
                        # Clean data sources - remove only SAS tokens/expiration params, keep working URLs
                        if "data_sources" in details:
                            details["data_sources"] = [_clean_data_source(s) for s in details.get("data_sources", [])]
                        # Clean files created - remove only paths, keep file names/types
                        if "files_created" in details:
                            details["files_created"] = [_clean_file_path(f) for f in details.get("files_created", [])]
                        # Clean key operations - remove only paths, keep methods
                        if "key_operations" in details:
                            details["key_operations"] = [_clean_text(op) for op in details.get("key_operations", [])]
                        # Clean code patterns - remove only paths, keep actual code
                        if "code_patterns" in details:
                            details["code_patterns"] = [_clean_code_pattern(cp) for cp in details.get("code_patterns", [])]
                        # Keep SQL queries as-is (they're already specific)
                        # Keep errors as-is (they're already specific)
                        # Keep error_fixes as-is (they're already specific)
                    
                    logger.debug(f"✅ Worklog extracted for {agent_name}: {worklog.get('description', '')[:60]}...")
            
            # Clean learnings - only remove environment-specific paths, keep working URLs/code
            if learnings:
                for learning in learnings:
                    if isinstance(learning, dict):
                        # Clean content - remove only paths, keep working URLs/code
                        if "content" in learning:
                            learning["content"] = _clean_text(learning["content"])
                        # Clean details - remove only paths, keep working URLs/code
                        if "details" in learning and isinstance(learning["details"], dict):
                            details = learning["details"]
                            for key in ["what_worked", "what_failed", "breakthrough"]:
                                if key in details and details[key]:
                                    details[key] = _clean_text(details[key])
            
            return {
                "worklog": worklog,
                "learnings": learnings if isinstance(learnings, list) else []
            }
        else:
            logger.debug(f"⚠️  JSON extraction returned None for {agent_name} ({message_type})")
            return {"worklog": None, "learnings": []}
            
    except Exception as e:
        logger.warning(f"Failed to extract worklog/learnings via LLM: {e}")
        return {"worklog": None, "learnings": []}


def _clean_text(text: str) -> str:
    """Clean text by removing ONLY environment-specific paths/IDs, keeping working URLs and code."""
    if not text:
        return text
    
    # Remove /tmp/coding/req_xxx/ paths (these won't exist next time)
    text = re.sub(r'/tmp/coding/req_[a-f0-9-]+/', '', text)
    
    # Remove request IDs in paths (but keep them in URLs if they're part of the working URL)
    text = re.sub(r'/req_[a-f0-9-]+/', '/', text)
    
    # Remove Azure Blob Storage request-specific paths (but keep the base URL pattern)
    text = re.sub(r'/autogentempfiles/req_[a-f0-9-]+/', '/autogentempfiles/', text)
    
    # Remove SAS token parameters from URLs (keep base URL)
    text = re.sub(r'\?[^ ]*sig=[^ &]+[^ ]*', '', text)
    text = re.sub(r'\?se=\d{4}-\d{2}-\d{2}[^ ]*', '', text)
    text = re.sub(r'&se=\d{4}-\d{2}-\d{2}[^ ]*', '', text)
    text = re.sub(r'&sig=[^ &]+', '', text)
    
    # Remove /Users/ paths (these won't exist next time)
    text = re.sub(r'/Users/[^\s]+', '', text)
    
    # Clean up double spaces
    text = re.sub(r'  +', ' ', text)
    text = text.strip()
    
    return text


def _clean_data_source(source: str) -> str:
    """Clean data source - remove ONLY temporary tokens/params, keep working URLs."""
    if not source:
        return source
    
    # Remove SAS token parameters (keep base URL)
    source = re.sub(r'\?[^ ]*sig=[^ &]+[^ ]*', '', source)
    source = re.sub(r'\?se=\d{4}-\d{2}-\d{2}[^ ]*', '', source)
    source = re.sub(r'&se=\d{4}-\d{2}-\d{2}[^ ]*', '', source)
    source = re.sub(r'&sig=[^ &]+', '', source)
    
    # Remove Azure Blob Storage request-specific paths (keep base URL)
    source = re.sub(r'/autogentempfiles/req_[a-f0-9-]+/', '/autogentempfiles/', source)
    
    # Remove /tmp/coding/req_xxx/ paths (these won't exist next time)
    source = re.sub(r'/tmp/coding/req_[a-f0-9-]+/', '', source)
    
    # Remove /Users/ paths
    source = re.sub(r'/Users/[^\s]+', '', source)
    
    # Clean up
    source = source.strip()
    
    return source


def _clean_file_path(file_path: str) -> str:
    """Clean file path - remove ONLY environment-specific paths, keep filename."""
    if not file_path:
        return file_path
    
    import os
    
    # Remove /tmp/coding/req_xxx/ paths (these won't exist next time)
    file_path = re.sub(r'/tmp/coding/req_[a-f0-9-]+/', '', file_path)
    
    # Remove /Users/ paths
    file_path = re.sub(r'/Users/[^/]+/', '', file_path)
    
    # Remove Azure Blob Storage request-specific paths
    file_path = re.sub(r'/autogentempfiles/req_[a-f0-9-]+/', '/autogentempfiles/', file_path)
    
    # Remove SAS tokens and query params
    file_path = re.sub(r'\?[^ ]*sig=[^ &]+[^ ]*', '', file_path)
    file_path = re.sub(r'\?se=\d{4}-\d{2}-\d{2}[^ ]*', '', file_path)
    file_path = re.sub(r'&se=\d{4}-\d{2}-\d{2}[^ ]*', '', file_path)
    file_path = re.sub(r'&sig=[^ &]+', '', file_path)
    
    # Extract filename (keep actual filename)
    filename = os.path.basename(file_path) if '/' in file_path else file_path
    
    return filename


def _clean_code_pattern(pattern: str) -> str:
    """Clean code pattern - remove ONLY environment-specific paths, keep actual code."""
    if not pattern:
        return pattern
    
    # Remove /tmp/coding/req_xxx/ paths (these won't exist next time)
    pattern = re.sub(r'/tmp/coding/req_[a-f0-9-]+/', '', pattern)
    
    # Remove /Users/ paths
    pattern = re.sub(r'/Users/[^\s\)]+', '', pattern)
    
    # Clean up
    pattern = pattern.strip()
    
    return pattern
