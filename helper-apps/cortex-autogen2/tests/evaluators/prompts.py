"""
Evaluation prompts for LLM-based scoring.

These prompts define the criteria and rubrics for scoring
progress updates and final outputs.
"""

PROGRESS_EVALUATION_PROMPT = """You are an expert evaluator assessing the quality of progress updates from an AI agent system.

**Progress Updates to Evaluate:**
{progress_updates}

**Task Being Executed:**
{task}

**Evaluation Criteria (0-100 points):**

1. **Frequency & Timing (25 points)**
   - Excellent: Frequent updates (1-5 seconds) acting as heartbeat - EVEN IF at same percentage
   - Good: Regular updates every 5-10 seconds
   - Fair: Updates >10 seconds apart but no major gaps
   - Poor: Large gaps (>30s) with no updates indicating system may be stuck
   - NOTE: Repeated updates at the same percentage are INTENTIONAL heartbeats to show the system is alive

2. **Clarity & Informativeness (25 points)**
   - Excellent: Uses emojis, concise descriptions, tells what's happening
   - Good: Clear messages but lacks emojis or detail
   - Fair: Vague messages like "Processing..." without specifics
   - Poor: Confusing or misleading messages

3. **Progress Accuracy (25 points)**
   - Excellent: Progress % increases logically when tasks complete
   - Good: Progress advances steadily through major phases
   - Fair: Some irregular jumps (e.g., 17% → 95%) but reaches completion
   - Poor: Progress goes backwards or never reaches completion
   - NOTE: Progress staying at same % for extended periods is ACCEPTABLE (heartbeat behavior)

4. **Coverage (25 points)**
   - Excellent: All important steps communicated (planning, data fetching, processing, uploading)
   - Good: Most steps covered
   - Fair: Missing some key steps
   - Poor: Very sparse updates, missing most steps

**Instructions:**
1. Analyze the progress updates carefully
2. Calculate a score from 0-100 based on the criteria above
3. Provide specific reasoning for your score
4. List any ACTUAL issues found (NOT frequent updates at same percentage - those are heartbeats!)
5. Only flag gaps >30 seconds as issues, not frequent heartbeat updates

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

**Evaluation Criteria (0-100 points):**

1. **Answer Quality (25 points)**
   - Excellent: Directly answers user's question with clear insights, no file dumps
   - Good: Provides useful information but could be more focused on the question
   - Fair: Includes some answer but mostly lists files
   - Poor: Just dumps files without answering the question

2. **Insight & Analysis (25 points)**
   - Excellent: Extracts key findings, trends, surprises; explains "why it matters"
   - Good: Provides some analysis but could go deeper
   - Fair: Basic facts without interpretation
   - Poor: No analysis, just raw data or file lists

3. **Professional Presentation (25 points)**
   - Excellent: Structured like great article (hook→insights→evidence→next steps), strategic emojis, engaging tone
   - Good: Well-organized but could be more engaging
   - Fair: Basic structure, functional but not compelling
   - Poor: Disorganized, unprofessional, hard to read

4. **Deliverable Integration (25 points)**
   - Excellent: Primary deliverable prominently highlighted with hero treatment; preview images are clickable and link to main file; supporting files clearly separated; professional visual styling (borders, formatting)
   - Good: Primary deliverable identified but could be more prominent; preview images shown but not interactive; files somewhat organized
   - Fair: Files listed but primary deliverable not clearly distinguished from supporting files; preview images shown as regular images without download links
   - Poor: Files dumped without organization; no distinction between primary and supporting deliverables; preview images missing or not utilized

**Special Considerations:**
- **Answer First**: Prioritize how well it answers the original question over file completeness
- **Insight Focus**: Reward analysis, trends, surprises over raw data dumps
- **Professional Structure**: Executive summary → Key insights → Visual evidence → Clean deliverables → Next steps
- **Engagement**: Strategic use of formatting, emojis, clear confident language (avoid "I think", "maybe")
- **Chart Integration**: Charts should illustrate insights, not just be separate dumps
- **SAS URLs**: All files must have working SAS URLs for download
- **PRIMARY DELIVERABLE PROMINENCE**: When task requests specific file type (PPTX, PDF, Excel), that file must be prominently featured with hero treatment, clear download link, and preview images that link to the main file
- **PREVIEW IMAGE INTERACTIVITY**: Preview images for PPTX/PDF should be clickable and link to the main deliverable file with visual styling (borders, hover indication)
- **BONUS +5-10 points**: Award extra for proactive helpful visualizations or analysis not explicitly requested

**Instructions:**
1. Analyze all aspects of the output
2. Calculate a score from 0-100 based on criteria above
3. Provide specific reasoning
4. List specific strengths and weaknesses

**Return JSON format:**
```json
{{
  "score": 95,
  "reasoning": "Outstanding Pokemon presentation that directly answers the question with professional insights. Starts with executive summary highlighting 12 Pokemon collected, then provides specific design highlights and visual evidence woven throughout. Files are presented as supporting evidence, not the main event. Professional structure with strategic emojis and engaging tone.",
  "strengths": [
    "Directly answers user's request for 'Most Powerful Gen 1 Pokemon PowerPoint'",
    "Professional structure: summary → insights → evidence → deliverables",
    "Charts/images integrated into narrative (described before shown)",
    "Clear insights about design choices and image quality",
    "All SAS URLs provided with descriptive names",
    "Engaging, confident tone throughout"
  ],
  "weaknesses": []
}}
```

**Example of EXCELLENT new presentation style:**
```json
{{
  "score": 98,
  "reasoning": "Perfect example of insight-focused presentation with excellent primary deliverable highlighting. Task requested PowerPoint, and response features it prominently with hero treatment: dedicated section, clickable preview images linking to PPTX download, clear download button with file size. Preview images have professional styling (borders, rounded corners). Supporting files (PDF, data) clearly separated in 'Additional Resources' section. Provides meaningful insights before showing deliverables. Professional structure with executive summary, insights, evidence, and next steps. Bonus +5 points for proactive PDF version and additional charts.",
  "strengths": [
    "Primary deliverable (PPTX) prominently featured with hero treatment in dedicated section",
    "Preview images are clickable and link to main PPTX file for instant download",
    "Professional visual styling on previews (borders, rounded corners, cursor indication)",
    "Clear download button with file size (2.1 MB) for transparency",
    "Supporting files clearly separated in 'Additional Resources' section",
    "Answers question immediately with executive summary",
    "Provides meaningful insights before showing deliverables",
    "Professional structure: hook → insights → primary deliverable → supporting files → next steps",
    "Strategic use of emojis and formatting",
    "All files with working SAS URLs"
  ],
  "weaknesses": []
}}
```

**Example of POOR old-style file dump:**
```json
{{
  "score": 45,
  "reasoning": "Traditional file dump approach that doesn't answer the user's question. Just lists deliverables without insights or analysis. No attempt to explain what the data shows or why it matters. User asked for comparison but got file inventory instead.",
  "strengths": [
    "All requested files were created",
    "SAS URLs provided for downloads"
  ],
  "weaknesses": [
    "No answer to user's question about AJE vs AJA comparison",
    "No insights or analysis of the data",
    "Just dumps files without context or explanation",
    "No professional structure or engagement",
    "Missing opportunity to explain trends and findings"
  ]
}}
```

**Example of MEDIOCRE insight attempt:**
```json
{{
  "score": 72,
  "reasoning": "Makes some attempt at insights but lacks professional structure. Starts with basic facts but doesn't provide deep analysis or explain significance. Files are listed rather than integrated into narrative. Could be much more engaging and comprehensive.",
  "strengths": [
    "Provides some basic insights about article counts",
    "Files are uploaded with SAS URLs",
    "Attempts to answer the comparison question"
  ],
  "weaknesses": [
    "Insights are surface-level without deep analysis",
    "No professional structure (no executive summary, poor flow)",
    "Files dumped at end without integration into story",
    "Lacks engaging tone and strategic formatting",
    "Missing explanation of why findings matter"
  ]
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

        formatted.append(f"- {file_path} (type: {file_type}, SAS URL: {'yes' if sas_url else 'no'})")

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
