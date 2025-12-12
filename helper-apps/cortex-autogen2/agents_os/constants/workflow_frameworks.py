# Workflow coordination and circuit breaker guidance

CIRCUIT_BREAKER_GUIDANCE = """
**CRITICAL: CIRCUIT BREAKER & FAIL-FAST RULES**

1. **File Dependency Validation**:
   - Before starting work that requires upstream files, CHECK if they exist using list_files
   - If required files are missing after 2 checks (10s apart), STOP and report clear error
   - DO NOT loop indefinitely waiting for files that may never arrive
   - Example: If expecting data.csv from upstream agent, check twice then fail with specific error

2. **Maximum Retry Limits**:
   - Code execution failures: Max 3 retries with error feedback to agent
   - File generation failures: Max 3 attempts before failing
   - Tool call failures: Max 3 retries per tool
   - File availability checks: Max 2 retries before failing
   - Agent handoff timeouts: Fail after 120s of no response
   - After max retries exceeded, FAIL with clear error message

3. **Clear Error Reporting**:
   - State exactly what file/resource is missing (include filename)
   - State which upstream agent or step should have created it  
   - State what action you tried and why it failed
   - Include actionable next steps
   - DO NOT use vague errors like "something went wrong" or "process failed"

4. **No Silent Failures**:
   - If you cannot complete your work, explicitly state so
   - Tag critical errors with ⛔ emoji for visibility
   - Log failure reason to accomplishments.log
   - Report to completion verifier that task cannot proceed

**Example Bad Error**:
Error: Required inputs missing. Cannot continue.
"""

FILE_CONTRACT_GUIDANCE = """
**FILE CONTRACTS & DELIVERABLE TRACKING**

1. **Declare Your Outputs at Start** (internal logging only):
   - When beginning work, track internally what files you are creating
   - Include file format, approximate structure/content
   - Log this declaration to accomplishments.log (internal only, NOT user-facing)
   - Example internal log: "Creating: [filename].csv (columns: date, headline, url, ~1000 rows)" - do NOT output this to users

2. **Verify Your Work Upon Completion**:
   - After finishing work, use list_files to enumerate what you created
   - Report file names AND sizes to prove files exist and are non-empty
   - Log verification to accomplishments.log
   - Example: "Created files: ✅ data.csv (45KB), ✅ chart.png (128KB), ✅ report.pdf (2.1MB)"

3. **Validate Inputs Before Processing**:
   - Don't assume upstream files exist - always check first
   - Verify file exists AND is non-empty (size > 0 bytes)
   - If missing or empty, fail fast with clear error (see Circuit Breaker rules)
   - Example: Check os.path.exists(file) and os.path.getsize(file) > 0

4. **Dependency Declaration**:
   - At start of work, list what files you NEED from upstream
   - Validate all dependencies exist before proceeding
   - If any missing, fail immediately with specific error
   - Example: "Required inputs: headlines.csv, sentiment.json (from web_search)"
"""

WORKFLOW_COORDINATION_GUIDANCE = """
**AGENT WORKFLOW COORDINATION**

1. **Handoff Clarity**:
   - When transferring to another agent, state what you accomplished
   - List what files you created for downstream agents
   - State what the next agent should do
   - Example: "Completed SQL query. Created [filename].csv. Transfer to coder_agent for chart generation."

2. **Progress Logging vs User Reporting**:
   - Log detailed technical progress to logs/accomplishments.log (include agent names, file paths, errors)
   - Report clean user-facing messages via progress updates (no internal details, agent names, or error codes)
   - User message: "📊 Analyzing headline data"

3. **Completion Verification**:
   - Before reporting task complete, verify ALL required deliverables exist
   - Check files are non-empty and contain expected content
   - If any deliverable missing, do NOT report complete - investigate and fix
   - Log final deliverable checklist to accomplishments.log

4. **Error Escalation**:
   - Recoverable errors: Retry with fallback strategy, don't report to user
   - Unrecoverable errors: Fail fast, report clear error to completion verifier
   - Never hide failures - surface them quickly for proper handling
   - Log all errors (even recovered ones) to logs/accomplishments.log
"""

DATA_QUALITY_GUIDANCE = """
# DATA QUALITY & RESILIENCE FRAMEWORK

## 1. INPUT VALIDATION (FAIL FAST)
- **NEVER** process empty or invalid data.
- **Coder Agent**: Before generating charts/reports, VALIDATE input CSV/JSON.
    - Check for `NaN`, `null`, or empty lists.
    - Check for missing columns or zero rows.
    - If data is invalid: STOP and report "INVALID_DATA: [Reason]". Do NOT generate empty charts.

## 2. ALTERNATIVE SOURCE STRATEGIES (NO SYNTHETIC DATA)
- **Planner Agent**: Always include alternative data sources, but NEVER plan for synthetic/fallback data.
- **MANDATORY MULTI-SOURCE EXHAUSTION**: Plan to try ALL available REAL authoritative sources before declaring failure:
  * **Source Hierarchy**: Primary source → Alternative source 1 → Alternative source 2 → Alternative source 3 → etc.
  * **Per-Source Methods**: For each source, try multiple methods (direct download, API call, HTML extraction, web scraping)
  * **Extraction Methods**: For HTML sources, try: pandas.read_html() → BeautifulSoup → fetch_webpage(render=True) → manual parsing
  * **Minimum Attempts**: Try at least 3-5 different real data sources with multiple extraction methods each
- **Web Search Agent**: If direct URL fails, search for alternative sources (other authoritative sites, data portals, APIs).
- **CRITICAL**: Exhaust ALL real data sources before declaring data unavailable. Each source should be tried with multiple extraction methods.
- **NEVER GIVE UP EARLY**: Only declare failure after trying multiple different real data sources with multiple extraction methods each.

## 3. OUTPUT INTEGRITY
- **No Placeholders**: Never output "TBD" or "Placeholder" in final files.
- **Self-Correction**: If you detect `NaN` in your output, DELETE the file and try again or report failure.
"""

ERROR_RECOVERY_GUIDANCE = """
# ERROR RECOVERY & SELF-CORRECTION FRAMEWORK

## 0. CORE PRINCIPLE - MANDATORY FIRST
**ABSOLUTE RULE**: Errors are fixable. Your job is to fix them, not declare failure.
- **FORBIDDEN**: Declaring "⛔ Cannot proceed" or routing to planner_agent after first error
- **REQUIRED**: Fix the error and retry (up to 3 attempts with different approaches)
- **ONLY AFTER 3 ATTEMPTS**: If all attempts with different approaches fail, then route to planner_agent
- **GENERIC APPLICATION**: This applies to ALL errors (missing dependencies, code bugs, file format issues, data extraction failures)

## 1. CLEAR ERROR LOGGING (MANDATORY)
When ANY operation fails (code execution, file generation, API call):
- Log the FULL error message including traceback
- Log the operation that failed (code snippet, file path, API endpoint)
- Log expected vs actual outcome
- Format: "❌ ERROR ATTEMPT {N}/3: {operation} failed - {error_message}"
- Example: "❌ ERROR ATTEMPT 1/3: PPTX generation failed - ModuleNotFoundError: No module named 'pptx'"

## 2. ERROR FEEDBACK LOOP (FOR AGENTS)
After execution error:
1. **Agent receives**: Full error details in next message
2. **Agent analyzes**: Root cause (missing import? wrong path? bad data?)
3. **Agent fixes**: Generate corrected code/approach
4. **Retry**: Execute fixed version (up to 3 total attempts)
5. **Success or Final Fail**: After 3 attempts, either succeed or report failure

## 3. COMMON ERROR PATTERNS & FIXES
**Missing Import**:
- Error: "ModuleNotFoundError: No module named 'X'"
- Fix: Add "import X" or "from X import Y"

**File Not Found**:
- Error: "FileNotFoundError: [path]"
- Fix: Create parent directories with "os.makedirs(os.path.dirname(path), exist_ok=True)"
- **ALTERNATIVE FORMAT CHECK**: If expected format (e.g., CSV) is missing, check workspace for alternative formats (JSON, Excel, HTML) with same/similar data
- **FORMAT CONVERSION**: If alternative format exists, convert it to required format (e.g., load JSON → create CSV) instead of declaring failure
- **GENERIC PRINCIPLE**: Applies to ANY missing file - check for alternative formats before declaring "cannot proceed"

**Permission Error**:
- Error: "PermissionError: [Errno 13]"
- Fix: Check file permissions, use correct paths

**Library Method Error**:
- Error: "AttributeError: 'X' object has no attribute 'Y'"
- Fix: Check documentation, use correct method name/API

**Data Type Error**:
- Error: "TypeError: expected str, got None"
- Fix: Add validation, handle None cases

## 4. SELF-CORRECTION PROTOCOL
For coder_agent specifically:
1. **First attempt**: Generate code based on requirements
2. **If error**: Analyze root cause and fix it (install dependency, fix bug, use alternative library/method)
3. **Second attempt**: Execute fixed code
4. **If error**: Try different approach (alternative library, simplified method, manual processing)
5. **Third attempt**: Execute alternative approach
6. **ONLY AFTER 3 ATTEMPTS**: If all 3 attempts with different approaches fail, route to planner_agent
7. **FORBIDDEN**: Declaring "⛔ Cannot proceed" or routing to planner_agent before attempting fixes

## 5. PROGRESS TRANSPARENCY
- During retries, update progress: "🔄 Refining approach (Attempt 2/3)"
- Don't show raw errors to user
- Show professional status: "Optimizing solution" instead of "Error occurred"
- Only show failure if all 3 attempts exhausted
"""

TOOL_FAILURE_DETECTION_GUIDANCE = """
**CRITICAL: TOOL CALL FAILURE RECOGNITION & RETRY PREVENTION**

**FAILURE DETECTION**:
- Tool results starting with "Error", "Failed", "Cannot", "⛔" indicate FAILED tool calls
- When a tool returns an error message, treat it as a FAILURE, not success
- Acknowledge failures explicitly: "Tool [name] failed: [error message]"

**RETRY PREVENTION**:
- Before calling any tool, check conversation history for previous failures of the same tool with same parameters
- If tool X failed with error Y, do NOT retry X with identical parameters
- After 2 failed attempts with same tool/parameters, switch to alternative strategy
- Example: If download_file(url) failed twice, try search_for_files or fetch_webpage instead

**LOOP DETECTION**:
- **CRITICAL**: Before outputting any message, check conversation history for repeated patterns:
  * If you've said the same thing (same key phrases, same "cannot proceed" message) 2+ times, you're STUCK IN A LOOP
  * If you've attempted the same action (same tool call with same parameters) 2+ times, you're STUCK IN A LOOP
  * **CODE EXECUTION RETRY LOOP**: If `execute_code_bound` has failed 2+ times with different errors (ModuleNotFoundError, TypeError, ValueError, AttributeError, etc.), you're STUCK IN A LOOP - this indicates approach problem, not syntax issue. Route to planner_agent immediately.
  * If you've checked for the same file 3+ times, you're STUCK IN A LOOP
- **MANDATORY LOOP BREAKING**: When you detect a loop (same message/action repeated 2+ times):
  * STOP repeating the same message immediately
  * Acknowledge the loop explicitly: "I notice I've been repeating the same message. I'm stuck in a loop."
  * **ROUTE TO planner_agent FOR REPLANNING**: DO NOT continue the loop - route to planner_agent immediately for replanning with FORCED alternative approaches
  * Provide specific failure analysis to planner_agent: "Primary approach [X] failed. Need replanning with alternative strategies."
  * **BEFORE REPLANNING**: Check workspace for any available data/files. If partial data exists, create deliverables with available data first, then replan for missing parts. Only replan if workspace is completely empty.
- **GENERIC LOOP PREVENTION**: 
  * After 2 failed attempts with the same approach, you MUST route to planner_agent for replanning
  * DO NOT continue trying the same approach - we must never loop
  * Route to planner_agent to create a new plan with FORCED alternative approaches
- For execution_completion_verifier_agent: If you've output the same "TASK NOT COMPLETED" message before, route to planner_agent for replanning

**CIRCUIT BREAKER**:
- Maximum 2 retries per tool call with same parameters
- After 2 failures, switch to alternative tool or approach
- Document why you're switching: "Tool [X] failed twice, switching to [Y] because [reason]"
"""

LOOP_DETECTION_GUIDANCE = """
🚨🚨🚨 CRITICAL: LOOP DETECTION & REPLANNING - CHECK THIS FIRST 🚨🚨🚨

**MANDATORY FIRST STEP - BEFORE ANY ACTION**:
- **BEFORE outputting any message**: Scan the last 10 messages in conversation history
- **BEFORE calling any tool**: Check if you've called this tool with same parameters before
- **BEFORE reporting status**: Check if you've said this before
- **IF YOU SEE REPETITION**: You are in a loop - STOP immediately and break it

**LOOP DETECTION PATTERNS** (detect after 2 repetitions):
- **Same message pattern**: You've said the same thing (same key phrases, same "cannot proceed" message) 2+ times → LOOP
- **Same tool pattern**: You've attempted the same action (same tool call with same parameters) 2+ times → LOOP
- **File check pattern**: You've checked for the same file 3+ times → LOOP
- **Ping-pong pattern**: Two agents alternating with same/empty content 3+ times → LOOP
- **No progress pattern**: Same agent selected 3+ times, no tool calls, no file creation, no state change → LOOP

**🚨 IMMEDIATE LOOP BREAKING - MANDATORY ACTION 🚨**:
- When you detect a loop (same message/action repeated 2+ times):
  * **STOP IMMEDIATELY**: Do not output another message, do not call another tool
  * **ACKNOWLEDGE LOOP**: "🚨 LOOP DETECTED: I've repeated [pattern] 2+ times. Breaking loop now."
  * **ROUTE TO planner_agent IMMEDIATELY**: DO NOT continue - route to planner_agent for replanning
  * **PROVIDE FAILURE ANALYSIS**: "Primary approach [X] failed. Need replanning with FORCED alternative approaches."
  * **STATE ATTEMPTS**: "Attempted [approach] 2+ times. Need new plan with different strategy."

**WE MUST NEVER LOOP - ZERO TOLERANCE**:
- After 2 failed attempts with the same approach, you MUST route to planner_agent for replanning
- DO NOT continue trying the same approach - we must never loop
- DO NOT wait for manual uploads or external intervention - route to planner_agent for alternative strategies
- planner_agent will create a new plan with FORCED alternative approaches that agents must follow
- **CRITICAL**: If you see yourself about to repeat an action, STOP and route to planner_agent instead

**GENERIC & TASK-AGNOSTIC**:
- Loop detection works for any task type (data collection, file generation, code execution, etc.)
- When stuck, always route to planner_agent - it will create a new execution plan with alternative strategies
- The new plan will FORCE agents to try different approaches, preventing loops
- **REMEMBER**: It's better to replan than to loop infinitely
"""

TIMEOUT_HANDLING_GUIDANCE = """
**CRITICAL: TIMEOUT HANDLING & RECOVERY**

**TIMEOUT RECOGNITION**:
- Timeout messages like "Request timed out after 120 seconds!" indicate transient backend issues, NOT task failures
- Timeouts occur when LLM API calls exceed time limits due to network latency, backend processing delays, or temporary service issues
- These are recoverable errors - the task itself is valid, but the backend communication timed out

**AUTOMATIC RECOVERY PROTOCOL**:
- When you encounter a timeout message in conversation history or receive one as your response:
  1. **Recognize it as transient**: Understand this is a backend issue, not a problem with your task or approach
  2. **Continue your workflow**: Do NOT treat timeout as task failure - proceed with your normal agent responsibilities
  3. **Retry automatically**: If your previous attempt timed out, retry the same operation with the same context
  4. **Maintain state**: Use the same inputs, parameters, and approach as before the timeout
  5. **Output normally**: After retry succeeds, output your normal response format (JSON scores, file paths, analysis results, etc.)

**TIMEOUT BEHAVIOR**:
- **DO**: Retry your operation immediately with the same context
- **DO**: Continue with your normal agent workflow after timeout
- **DO**: Output proper structured responses (JSON, file paths, analysis) after successful retry
- **DON'T**: Treat timeout as a task failure or error condition
- **DON'T**: Change your approach or strategy due to timeout
- **DON'T**: Output raw timeout messages - retry and output your normal response

**GENERIC RECOVERY**:
- Timeouts can happen to any agent for any task type
- The recovery protocol is the same regardless of task complexity or agent type
- Simply retry with the same context and continue your normal workflow
- Timeouts are backend infrastructure issues, not task-specific problems
"""
