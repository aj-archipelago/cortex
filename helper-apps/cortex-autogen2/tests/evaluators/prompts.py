"""
Evaluation prompts for LLM-based scoring.

These prompts define the criteria and rubrics for scoring
progress updates and final outputs.
"""

from typing import List

PROGRESS_EVALUATION_PROMPT = """You are an expert evaluator assessing the quality of progress updates from an AI agent system.

**Progress Updates to Evaluate:**
{progress_updates}

**Task Being Executed:**
{task}

**Evaluation Criteria (0-100 points):**

1. **Message Quality & User-Friendliness (30 points)**
   - Excellent: Professional, engaging messages that tell users exactly what's happening with their task
   - Good: Clear messages but could be more engaging
   - Fair: Generic messages like "Processing task files" without specifics, OR repetitive heartbeat messages at same progress %
   - Poor: Technical error messages, internal system messages, or confusing content
   - IMPORTANT: Do NOT penalize for repetitive messages that are heartbeat updates at the same percentage - these are INTENTIONAL and DESIRABLE
   - CRITICAL DEDUCTIONS: -20 points for error messages shown to users, -15 points for internal technical messages

2. **Emoji Usage & Variety (20 points)**
   - Excellent: Diverse emojis that match content, different emojis for different actions
   - Good: Consistent emoji usage but some repetition, OR same emoji for heartbeat updates at same progress %
   - Fair: Same emoji used repeatedly for different task types, or inappropriate emojis
   - Poor: No emojis or wrong emojis (e.g., ⚡ for everything)
   - IMPORTANT: Heartbeat updates at same progress % may legitimately use the same emoji - do not penalize this
   - CRITICAL DEDUCTIONS: -10 points for using same emoji repeatedly across different task types, -15 points for inappropriate emoji choices

3. **Frequency & Timing (20 points)**
   - Excellent: Frequent updates (1-5 seconds) acting as heartbeat - EVEN IF at same percentage
   - Good: Regular updates every 5-10 seconds
   - Fair: Updates >10 seconds apart but no major gaps
   - Poor: Large gaps (>30s) with no updates indicating system may be stuck
   - CRITICAL: Repeated updates at the same percentage are INTENTIONAL heartbeats to show the system is alive and working - this is EXCELLENT behavior

4. **Progress Accuracy & Coverage (30 points)**
   - Excellent: Progress % increases logically when tasks complete, all important steps communicated
   - Good: Progress advances steadily, most steps covered
   - Fair: Some irregular jumps or missing steps
   - Poor: Progress goes backwards, never reaches completion, or very sparse updates

**Instructions:**
1. Analyze the progress updates carefully for message quality, emoji variety, and user-friendliness
2. Calculate a score from 0-100 based on the criteria above
3. Provide specific reasoning for your score
4. CRITICALLY evaluate message quality - deduct heavily for technical errors, internal messages, or poor user experience
5. Check emoji variety - same emoji repeatedly should result in significant deductions
6. Only flag gaps >30 seconds as timing issues, not frequent heartbeat updates
7. List specific examples of bad messages and their issues

**Return JSON format:**
```json
{{
  "score": 85,
  "reasoning": "Updates were frequent (avg 2.1s interval) acting as heartbeats, which is excellent. Progress percentage advanced logically through major phases. All major steps were communicated clearly with good emoji usage.",
  "issues": [
    "One gap of 35 seconds between updates during image download phase"
  ],
  "strengths": [
    "Excellent heartbeat frequency (1-3 second intervals)",
    "Excellent use of emojis for clarity",
    "Clear descriptions of what's happening at each step",
    "Progress advanced logically when tasks completed"
  ]
}}
```

Now evaluate the progress updates above and return ONLY the JSON response."""


OUTPUT_EVALUATION_PROMPT = """You are an expert evaluator assessing the quality of outputs from an AI agent system that creates professional, insightful presentations and deliverables.

**Original Task:**
{task}

**Final Result Data:**
{final_result}

**Files Created:**
{files_created}

**Test Run Summary:**
{test_summary}

**Global Expectations (apply to ALL tests):**
{global_expectations}

**Test Case Specific Quality Criteria (CRITICAL - SCORE=0 IF VIOLATED):**
{test_case_quality_criteria}

**CRITICAL FAILURE CHECK**: If ANY of the test case specific quality criteria above are violated, return score=0 immediately. These are mandatory requirements that cannot be overridden by other scoring factors. Examples of critical failures include:
- Incorrect data analysis (e.g., claiming AJE > AJA when data shows AJA > AJE)
- Missing required deliverables
- Hallucinated or incorrect information
- Violation of specific test constraints
- PDF/Report files containing error messages like "generation failed" or "contact admin" instead of actual content
- Files that exist but contain failure/error content rather than the requested deliverables

If you detect any critical quality criteria violations, set score=0 and clearly explain the violation in the reasoning.

**Generic Quality Expectations (VISUALISTIC, ENGAGING, PROFESSIONAL, FUN):**

1. **VISUALISTIC (Visual Richness):**
   - Outputs should be visually rich with charts, images, previews, and visual elements that enhance understanding
   - Visuals should be well-integrated, properly sized, and add value to the content
   - Preview images should be shown for presentations and reports when available
   - Charts and graphs should be clear, informative, and professionally designed
   - Visual elements should support and clarify the narrative, not distract

2. **ENGAGING (User Engagement):**
   - Content should be interesting, compelling, and hold user attention
   - Use data insights, surprising findings, and clear narratives to engage users
   - Present information in a way that makes users want to explore further
   - Highlight interesting patterns, trends, or unexpected results
   - Create a sense of discovery and value in the content

3. **PROFESSIONAL (Quality Standards):**
   - All deliverables must meet professional standards
   - Proper formatting, high-quality visuals, clear structure, polished presentation
   - Consistent styling and branding throughout
   - Error-free content with proper grammar and clear communication
   - Files should be well-organized and properly named

4. **FUN (Delightful Experience):**
   - While maintaining professionalism, outputs should be enjoyable and delightful
   - Creative visualizations, interesting data patterns, engaging storytelling
   - Use of appropriate emojis, colors, and visual elements that enhance the experience
   - Make complex data accessible and interesting through creative presentation
   - Balance professionalism with approachability and enjoyment

**Evaluation Criteria (0-100 points) - PRIORITY: DELIVERABLE FIRST (if requested), PRESENTATION SECOND:**

**TASK TYPE DETECTION:**
- **FILE DELIVERY TASKS**: User explicitly requests a file (PPTX, PDF, CSV, Excel, etc.) → File with SAS URL is MANDATORY
- **INFORMATION TASKS**: User asks questions, wants explanations, analysis, or information → No file required, evaluate answer quality

**CRITICAL PRIORITY #1: MAIN DELIVERABLE (Only for FILE DELIVERY TASKS)**
- **IF user asks for a file** (PPTX, PDF, CSV, Excel, etc.) and NO file with SAS URL is delivered → Score = 0/100
- **IF user asks for information** (questions, explanations, analysis) → No file required, skip this check
- Main deliverable MUST exist and have working SAS URL - this is non-negotiable ONLY when file is requested
- **HOW TO DETECT DELIVERABLES**: Look for SAS URLs in both "Files Created" list AND in the HTML/Markdown content in "Final Result Data" (href="https://...blob.core.windows.net...se=..." or src="https://...blob.core.windows.net...se=...")
- **SAS URL FORMAT**: Must contain "blob.core.windows.net" domain and SAS parameters like "?se=", "?sp=", "?sv=", "?sr=", "?sig="
- No amount of great visuals or explanations can compensate for missing main deliverable (when file was requested)

**PRIORITY #2: PRESENTATION QUALITY (Evaluated for ALL tasks)**

1. **Clear Delivery & Conversation Completion (30 points)**
   - Excellent: Directly delivers what user asked for AND replies as if continuing conversation - completes the request with insightful response
   - Good: Provides what was asked but could be more conversational or insightful
   - Fair: Includes requested items but feels like file delivery, not conversation
   - Poor: Missing deliverables or feels like a dump, not a reply

2. **Visualistic Presentation (25 points)**
   - Excellent: Rich visuals (charts, images, previews) naturally integrated with explanations - visuals explain AND enhance
   - Good: Visuals present but could be better integrated with explanations
   - Fair: Visuals exist but feel separate from text/explanations
   - Poor: Missing visuals when needed or visuals without context

3. **Content Quality & Natural Flow (25 points)**
   - Excellent: NO "Insight:" prefixes, CONVERSATIONAL NATURAL FLOW (reads like explaining to colleague: "Looking at this chart...", "The data shows...", "Most interesting is..."), NO generic headers ("Key Insights Summary", "Visual Analytics & Data Findings"), NO filler text ("Explore the full dataset..."), NO raw filenames ("daily_aja_vs_aje_counts__20251114T061131Z_c433f3a3.csv"), SPECIFIC meaningful headers reflecting actual data findings (e.g., "AJE Outperforms AJA by 15%"), actual data-driven insights in every sentence
   - Good: Mostly specific content with some minor generic elements, mostly natural flow
   - Fair: Some generic headers, "Insight:" prefixes, or filler text present but not dominant, some conversational flow
   - Poor: Heavy use of generic headers, "Insight:" prefixes, filler text, raw filenames, or generic closing statements ("This presentation is designed for clarity...")
   - **CRITICAL CHECK**: NEVER use "Insight:" prefixes - content speaks for itself
   - **CRITICAL CHECK**: NO BIG GENERIC HEADERS - avoid "Summary", "Analysis", "Findings" headers that are just labels
   - **CRITICAL CHECK**: Headers must reflect SPECIFIC findings, not generic labels
   - **CRITICAL CHECK**: NO filler text like "For further details, consult the downloadable documents"
   - **CRITICAL CHECK**: Download links must use user-friendly names, never raw system filenames
   - **CRITICAL FAILURE**: "Insight:" prefixes = automatic -10 points
   - **CRITICAL FAILURE**: Generic headers or filler text = significant deduction
   - **CRITICAL FAILURE**: Raw filenames displayed to users = automatic -20 points

4. **Engaging & Fun (15 points)**
   - Excellent: Compelling, interesting, delightful - makes users want to explore, uses insights and storytelling
   - Good: Engaging with some interesting insights or creative presentation
   - Fair: Functional but lacks engagement or creative elements
   - Poor: Dry, boring, or uninteresting presentation

5. **Professional Quality (10 points)**
   - Excellent: Polished, error-free, professional presentation with consistent styling
   - Good: Mostly professional with minor issues
   - Fair: Functional but lacks polish or has formatting issues
   - Poor: Unprofessional appearance, errors, or poor formatting

**Special Considerations:**
- **COMPLETE THE CONVERSATION**: Response should feel like replying to user, not just delivering files
- **NO DUMPS**: Penalize text dumps, link dumps, or isolated file listings - everything must be integrated
- **CRITICAL: NO "DUMP OF IMAGES THEN DUMP OF TEXT" PATTERN**:
  * **FORBIDDEN**: Showing all images first, then all text below - this feels like a dump
  * **REQUIRED**: Natural flow - start with key insight → show image → immediate description → next image → immediate description → continue weaving
  * **CRITICAL CHECK**: Every image MUST have an insightful professional description immediately after it (1-3 sentences)
  * **CRITICAL CHECK**: If multiple images appear in a row without descriptions between them, this is a dump pattern - penalize heavily
  * **CRITICAL CHECK**: If descriptions are saved for the end after all images, this is a dump pattern - penalize heavily
- **START WITH KEY INSIGHT**: Response should begin with the most important finding or deliverable, not generic intro
- **EXPERT-LEVEL FORMATTING**: Use lists (bullet/numbered), bold text for emphasis, structured insights - make it feel like a 100-person expert team prepared this
- **VISUALS + EXPLANATIONS**: Visuals should enhance explanations, not replace them - combine both, with each visual followed immediately by its insight
- **MINIMAL BUT DETAILED**: Every word adds value, no fluff, but provide rich insights and details
- **PREVIEW TABLES**: Small summary files (<20 rows) should show data in markdown tables, not just download links
- **INTEGRATED LINKS**: File download links should be naturally integrated into narrative, not dumped at end
- **USER-FRIENDLY DOWNLOAD NAMES**: Never show raw filenames like "daily_aja_vs_aje_counts__20251114T061131Z_c433f3a3.csv" - use clean names like "Daily Article Comparison Data"
- **SAS URLs Required**: All files must have working download links
- **ENGAGING STORYTELLING**: Use data insights, surprising findings, clear narratives to engage users
- **NO FILLER TEXT PENALTY**: -15-25 points for generic headers ("Key Insights Summary"), filler text ("Explore the full dataset..."), or generic closing statements
- **RAW FILENAME PENALTY**: -20 points for showing raw system filenames to users
- **FUN BONUS**: +5-10 points for creative visualizations, interesting patterns, delightful presentation
- **NO DUMP PENALTY**: -10-20 points for text dumps, link dumps, isolated file listings, or "dump of images then dump of text" pattern
- **IMAGE DESCRIPTION PENALTY**: -5-10 points per image that lacks immediate insightful description after it
- **CONVERSATION COMPLETION BONUS**: +5-10 points for replying as if continuing conversation, not just delivering

**CRITICAL FAIL CHECKS - AUTOMATIC SCORE=0 (CHECK FIRST):**
These checks are MANDATORY and override all other scoring. **ONLY APPLY TO FILE DELIVERY TASKS**:

**STEP 1: Determine task type**
- Does user explicitly request a file? (Look for keywords: "create PPTX", "generate PDF", "make CSV", "Excel file", etc.)
- OR does user ask a question/request information? (Look for: "what is", "explain", "tell me", "analyze", "meaning of", etc.)

**STEP 2: Apply appropriate checks**

**FOR FILE DELIVERY TASKS** (if user requests a file):
- **MISSING MAIN DELIVERABLE**: If user asks for PPTX and NO PPTX file with SAS URL is delivered → Score = 0
- **MISSING MAIN DELIVERABLE**: If user asks for PDF and NO PDF file with SAS URL is delivered → Score = 0
- **MISSING MAIN DELIVERABLE**: If user asks for CSV and NO CSV file with SAS URL is delivered → Score = 0
- **MISSING MAIN DELIVERABLE**: If user asks for Excel and NO Excel file with SAS URL is delivered → Score = 0
- **MISSING MAIN DELIVERABLE**: If user asks for any specific file type and NO file of that type with SAS URL is delivered → Score = 0
- **NO SAS URL**: If file exists but has no working SAS URL/download link → Score = 0
- **INTERNAL FILES EXPOSED**: If output includes ANY internal system files like "Execution Plan.txt", "Accomplishments.txt", "Current Step.txt", or files ending with "_log.txt" or "_debug.txt" → Score = 0 (users should never see internal system files)

**FOR INFORMATION TASKS** (if user asks questions/wants information):
- **NO FILE REQUIRED**: Skip file checks - evaluate based on answer quality and presentation only
- User asked "what is 2+2?" → No file needed, evaluate answer quality
- User asked "meaning of everything" → No file needed, evaluate explanation quality
- User asked "explain X" → No file needed, evaluate explanation quality

**SCORING PRIORITY:**
1. **FIRST**: Determine task type (file delivery vs information)
2. **SECOND**: If file delivery task → Check if main deliverable exists with SAS URL → If NO, score = 0 (stop evaluation)
3. **THIRD**: If information task OR file exists → Evaluate presentation quality (nice, clean, visualistic) → Score 0-100 based on presentation criteria

**Instructions:**
1. **FIRST**: Determine task type - Does user request a FILE or ask for INFORMATION?
2. **SECOND**: 
   - **IF FILE DELIVERY TASK**: Check if main deliverable exists with SAS URL → If NO, return score=0 immediately with explanation
   - **IF INFORMATION TASK**: Skip file checks, proceed to presentation evaluation
3. **THIRD**: Evaluate presentation quality (nice, clean, visualistic) for all tasks
4. Calculate a score from 0-100 based on presentation criteria
5. Provide specific reasoning focusing on what was requested and how well it was delivered
6. List specific strengths and weaknesses in presentation

**Return JSON format:**
```json
{{
  "score": 95,
  "reasoning": "Perfect minimal delivery that gives exactly what was asked for. User wanted CSV files - got clear preview table for summary data and download link for main data. Concise, relevant, no fluff.",
  "strengths": [
    "Directly delivers what user asked for (CSV files)",
    "Summary data shown as preview table (not just download link)",
    "Clear download links with working SAS URLs",
    "Minimal words, maximum clarity",
    "No unnecessary verbose explanations or frameworks"
  ],
  "weaknesses": []
}}
```

**Example of INFORMATION TASK (no file required):**
```json
{{
  "score": 95,
  "reasoning": "User asked 'what is 2+2?' - this is an information task, no file required. Answer is correct (4) and presented clearly with engaging explanation. Visual elements could enhance but answer quality is excellent.",
  "strengths": [
    "Correct answer to user's question",
    "Clear, concise explanation",
    "Engaging presentation",
    "No unnecessary fluff"
  ],
  "weaknesses": [
    "Could include visual elements to enhance understanding"
  ]
}}
```

**Example of EXCELLENT file delivery (deliverable exists + great presentation):**
```json
{{
  "score": 98,
  "reasoning": "User requested PPTX file - this is a file delivery task. Main deliverable (PPTX) exists with working SAS URL ✓. Outstanding presentation: fun, engaging, professional delivery with rich visuals integrated naturally with explanations. Feels like continuing a conversation, not just delivering files.",
  "strengths": [
    "Main deliverable (PPTX) delivered with working SAS URL",
    "Completes user's request with insightful reply",
    "Rich visuals (charts, images, previews) integrated naturally with explanations",
    "No text/link dumps - everything integrated into engaging narrative",
    "Fun and delightful while maintaining professionalism"
  ],
  "weaknesses": []
}}
```

**Example of CRITICAL FAIL (file delivery task - missing file):**
```json
{{
  "score": 0,
  "reasoning": "User asked for PPTX file - this is a file delivery task. CRITICAL FAIL: NO PPTX file with SAS URL was delivered. Main deliverable is missing. Score=0 regardless of presentation quality.",
  "strengths": [],
  "weaknesses": [
    "CRITICAL: Main deliverable (PPTX) missing",
    "No SAS URL provided for requested file type",
    "Task incomplete - user requested file but got none"
  ]
}}
```

**Example of POOR presentation (file exists but poor presentation):**
```json
{{
  "score": 45,
  "reasoning": "User requested PDF file - this is a file delivery task. Main deliverable (PDF) exists with working SAS URL ✓. However, presentation is poor - just dumps files and links without integration. No conversation, no engagement, no integration.",
  "strengths": [
    "Main deliverable (PDF) delivered with working SAS URL"
  ],
  "weaknesses": [
    "Text/link dump - no integration into narrative",
    "No conversation completion - just delivers files",
    "Visuals exist but not integrated with explanations",
    "Feels like file delivery, not helpful reply"
  ]
}}
```

**Example of DUMP PATTERN (BAD - all images then all text):**
```json
{{
  "score": 30,
  "reasoning": "User requested data analysis - this is a file delivery task. Main deliverable (CSV) exists with working SAS URL ✓. However, presentation shows clear 'dump' pattern: all 6 charts shown first without descriptions, then all text explanations below. This violates natural flow requirement. Every image must have its description immediately after it.",
  "strengths": [
    "Main deliverable (CSV) delivered with working SAS URL",
    "Charts are present and relevant"
  ],
  "weaknesses": [
    "CRITICAL: Dump pattern - all images shown first, then all text below",
    "No immediate descriptions after images - descriptions saved for end",
    "Multiple images in a row without descriptions between them",
    "Does not start with key insight - starts with generic intro",
    "No natural flow - feels like separate dumps of visuals and text"
  ]
}}
```

**Example of EXCELLENT natural flow (GOOD - image → insight → image → insight):**
```json
{{
  "score": 98,
  "reasoning": "User requested data analysis - this is a file delivery task. Main deliverable (CSV) exists with working SAS URL ✓. Outstanding natural flow: starts with key insight, then shows first chart with immediate insightful description, then next chart with immediate description, continuing to weave visuals and insights together. Uses lists and formatting for expert feel. No dump pattern - everything flows naturally.",
  "strengths": [
    "Main deliverable (CSV) delivered with working SAS URL",
    "Starts with key insight (not generic intro)",
    "Perfect natural flow - image → insight → image → insight pattern",
    "Every image has insightful description immediately after it",
    "Uses lists and formatting for expert-level feel",
    "No dump pattern - visuals and insights woven together seamlessly",
    "Engaging, professional, comprehensive yet concise"
  ],
  "weaknesses": []
}}
```

Now evaluate the output above and return ONLY the JSON response."""


def format_progress_updates_for_evaluation(updates: list) -> str:
    """Format progress updates for inclusion in evaluation prompt."""
    if not updates:
        return "No progress updates received"

    formatted = []
    for i, update in enumerate(updates, 1):
        timestamp = update.get('timestamp', 'unknown')
        progress = update.get('progress', 0)
        info = update.get('info', '')
        progress_pct = int(progress * 100) if isinstance(progress, float) else progress

        formatted.append(f"{i}. [{timestamp}] {progress_pct}% - {info}")

    return "\n".join(formatted)


def format_files_for_evaluation(files: list) -> str:
    """Format file list for inclusion in evaluation prompt."""
    if not files:
        return "No files created"

    formatted = []
    for file in files:
        file_path = file.get('file_path', 'unknown')
        file_type = file.get('file_type', 'unknown')
        sas_url = file.get('sas_url', 'none')

        # Include actual SAS URL if available - helps LLM verify file delivery
        if sas_url and sas_url != 'none':
            formatted.append(f"- {file_path} (type: {file_type}, SAS URL: {sas_url})")
        else:
            formatted.append(f"- {file_path} (type: {file_type}, SAS URL: none)")

    return "\n".join(formatted)


def format_test_summary_for_evaluation(summary: dict) -> str:
    """Format test run summary for evaluation."""
    lines = [
        f"Duration: {summary.get('duration_seconds', 0):.1f} seconds",
        f"Progress Updates: {summary.get('total_progress_updates', 0)}",
        f"Errors: {summary.get('errors_count', 0)}",
        f"Warnings: {summary.get('warnings_count', 0)}",
    ]

    return "\n".join(lines)


def format_global_expectations_for_evaluation(expectations: List[str]) -> str:
    """Format global expectations for inclusion in evaluation prompt."""
    if not expectations:
        return "No global expectations defined"
    
    formatted = []
    for expectation in expectations:
        formatted.append(f"- {expectation}")
    
    return "\n".join(formatted)
