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


OUTPUT_EVALUATION_PROMPT = """You are an expert evaluator assessing the quality of outputs from an AI agent system that creates presentations, reports, and data files.

**Original Task:**
{task}

**Final Result Data:**
{final_result}

**Files Created:**
{files_created}

**Test Run Summary:**
{test_summary}

**Evaluation Criteria (0-100 points):**

1. **Completeness (25 points)**
   - Excellent: All requested deliverables present and correct
   - Good: Most deliverables present, minor omissions
   - Fair: Some deliverables missing
   - Poor: Major deliverables missing

2. **Quality (25 points)**
   - Excellent: Professional design, polished, publication-ready
   - Good: Good quality but minor design issues
   - Fair: Basic quality, looks unfinished
   - Poor: Placeholder content, dummy data, unprofessional

3. **Correctness (25 points)**
   - Excellent: Accurate data, no hallucinations, factually correct
   - Good: Mostly accurate with minor issues
   - Fair: Some incorrect information
   - Poor: Significant errors, hallucinated content, dummy data

4. **Presentation (25 points)**
   - Excellent: SAS URLs provided, preview images generated, clear results, BONUS for proactive visualizations
   - Good: Files uploaded but missing previews
   - Fair: Files created but not uploaded properly
   - Poor: No proper file delivery or presentation
   - BONUS: Award +5-10 extra points if system proactively creates helpful visualizations (charts, graphs, word clouds) even when not explicitly requested. Users love visuals!

**Special Considerations:**
- **Images**: Check if images were actually collected (not placeholders/shapes)
- **Data**: Check if data is realistic (not "Product1", "Product2" or all zeros)
- **Design**: Check for professional styling (colors, fonts, layout)
- **Preview Images**: For PPTX/PDF, check if preview images were generated
- **Preview Links**: If progress updates or final result mentions "preview" or "preview image", verify actual preview files with SAS URLs are provided. Penalize heavily if previews are mentioned but not delivered.
- **Charts/Visualizations vs Data-Only**: If task asks for "chart", "graph", "plot", "visualization", "trend", or "comparison chart", verify actual image files (.png, .jpg) exist. CSV/data files alone do NOT satisfy a chart request. Score must be ≤40 if charts requested but only CSV delivered.

**Instructions:**
1. Analyze all aspects of the output
2. Calculate a score from 0-100 based on criteria above
3. Provide specific reasoning
4. List specific strengths and weaknesses

**Return JSON format:**
```json
{{
  "score": 92,
  "reasoning": "Excellent Pokemon presentation with 12 high-quality images collected. Professional slide design with themed colors. Progress updates mentioned 'preview images generated' and all preview files with SAS URLs were actually provided in deliverables. Only minor issue: one slide had slightly cramped layout.",
  "strengths": [
    "12 Pokemon images successfully collected (exceeded minimum of 10)",
    "Professional themed design with consistent colors",
    "Preview slide images mentioned AND actually delivered with SAS URLs",
    "All SAS URLs provided correctly"
  ],
  "weaknesses": [
    "Slide 4 layout slightly cramped with overlapping text",
    "Could use more variety in slide layouts"
  ]
}}
```

**Example with bonus for proactive visualizations:**
```json
{{
  "score": 98,
  "reasoning": "Task asked for sales data CSV. System delivered CSV AND proactively created a beautiful sales trend chart and category breakdown pie chart without being asked. This shows excellent initiative and user-focused design. Bonus +8 points for proactive visualizations that add significant value.",
  "strengths": [
    "All requested CSV data delivered correctly",
    "Proactively created sales trend line chart (not requested but very helpful!)",
    "Proactively created category pie chart (excellent initiative!)",
    "Professional chart design with clear labels",
    "All files with SAS URLs provided"
  ],
  "weaknesses": []
}}
```

**Example of penalty for missing preview links:**
```json
{{
  "score": 45,
  "reasoning": "Progress updates claimed 'preview images generated and uploaded' but no preview files found in deliverables. This is misleading and reduces output quality score significantly.",
  "strengths": [
    "Main PPTX file was created"
  ],
  "weaknesses": [
    "Progress updates mentioned preview images but none were delivered",
    "No SAS URLs for previews despite claiming they were uploaded",
    "Misleading status updates reduce trust in system output"
  ]
}}
```

**Example of penalty for missing charts when requested:**
```json
{{
  "score": 35,
  "reasoning": "Task explicitly requested 'comparison chart showing AJE vs AJA article counts' but only CSV file was delivered. CSV data alone does not fulfill the visualization requirement. This is a critical missing deliverable.",
  "strengths": [
    "CSV data file was created with correct columns",
    "Data appears accurate for the 30-day period"
  ],
  "weaknesses": [
    "No chart/visualization provided despite explicit request in task",
    "Task asked for 'comparison chart' but only raw CSV delivered",
    "Missing critical visual deliverable significantly reduces utility"
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
