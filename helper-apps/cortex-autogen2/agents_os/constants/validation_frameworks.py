# Validation framework constants

SEQUENCE_VALIDATION_FRAMEWORK = """
    **SEQUENCE VALIDATION** (MANDATORY - prevents out-of-order execution):
    - **Check conversation history** for required preceding agents
    - **Verify data availability** before proceeding with processing
    - **Stop and report** if required prerequisites are missing
    - **Document dependencies** clearly in your responses
"""

CRITICAL_REQUIREMENT_AWARENESS_FRAMEWORK = """
**CRITICAL REQUIREMENT AWARENESS - UNIVERSAL FRAMEWORK**:
All agents MUST identify and satisfy critical task requirements for perfect task completion:

**UNIVERSAL REQUIREMENT EXTRACTION** (MANDATORY FOR ALL AGENTS):
- **USE UNIVERSAL FRAMEWORK**: Import and use UNIVERSAL_REQUIREMENT_EXTRACTION_FRAMEWORK to extract ALL requirements from task
- **COMPREHENSIVE EXTRACTION**: Extract ALL requirements mentioned, not just the first one
- **SEMANTIC UNDERSTANDING**: Use LLM reasoning to identify requirements, not just keyword matching
- **VALIDATE AT CHECKPOINT**: Each agent must validate extracted requirements at their checkpoint
- **FAIL IMMEDIATELY**: If ANY requirement missing → Fail immediately with clear error, do NOT proceed

**CRITICAL REQUIREMENT DETECTION PATTERNS**:
- **MANDATORY DELIVERABLES**: Any requirement marked as "critical", "mandatory", "required", "must", or "essential"
- **SPECIFIC FORMATS**: Requirements specifying exact formats (markdown table, preview, display, chart type, file format)
- **DISPLAY REQUIREMENTS**: Requirements about how content should be presented ("show as", "display as", "preview", "table", "inline")
- **NEGATIVE REQUIREMENTS**: Requirements prohibiting certain approaches ("not just", "no dumps", "avoid", "don't")
- **MULTI-FORMAT REQUIREMENTS**: Tasks requesting multiple formats (detected via conjunction patterns: "&", "and", ",", "both", "all")

**UNIVERSAL CRITICAL REQUIREMENT PRINCIPLES**:
- **IDENTIFY EARLY**: All agents must analyze task for critical requirements before execution begins
- **VALIDATE CONTINUOUSLY**: Each agent validates critical requirements are addressed in their work
- **ENFORCE STRICTLY**: Critical requirements take precedence over general preferences or convenience
- **REPORT CLEARLY**: Any critical requirement that cannot be satisfied must be clearly communicated
- **NEVER COMPROMISE**: Missing critical requirements = task failure, regardless of other quality

**CRITICAL REQUIREMENT SCORING IMPACT** (for verification agents):
- **Missing single critical requirement**: Severe penalty (score ≤ 50)
- **Multiple critical violations**: Maximum penalty (score = 0)
- **Format violations**: Significant penalty (score ≤ 70)
- **Content violations**: Major penalty (score ≤ 60)
- **Critical requirements override ALL other quality assessments**

**GENERIC CRITICAL REQUIREMENT EXAMPLES** (universal patterns):
- "display as table" → Must show actual table, not just download link
- "show preview" → Must display content directly, not just links
- "must include X" → X must be present in output
- "format as Y" → Output must be Y format
- "not just download" → Content must be displayed inline
- Any requirement with "critical", "mandatory", "required", or "must"

**SYSTEM OVERRIDE POLICIES - CRITICAL PRECEDENCE**:
- **MANDATORY OVERRIDE**: When user instructions conflict with mandatory system requirements, system requirements take precedence
- **DATA INTEGRITY FIRST**: Never compromise data access/quality for workflow restrictions - route to appropriate data agents first
- **OVERRIDE DETECTION**: Recognize "override test scenarios" where user says "only use X agent" but task requires Y agent for data access
"""
