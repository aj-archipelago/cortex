# Universal Requirement Extraction Framework
# Generic, principle-based requirement extraction patterns for ALL agents

UNIVERSAL_REQUIREMENT_EXTRACTION_FRAMEWORK = """
**UNIVERSAL REQUIREMENT EXTRACTION - APPLIES TO ALL TASKS**:

**CORE PRINCIPLE**: Extract ALL explicit requirements from task description using semantic understanding, not just pattern matching. Every requirement must be identified and validated.

**EXTRACTION PRINCIPLES**:
- **COMPREHENSIVE EXTRACTION**: Extract ALL requirements mentioned, not just the first one
- **SEMANTIC UNDERSTANDING**: Use LLM reasoning to identify requirements, not just keyword matching
- **FORMAT-AGNOSTIC**: Works for any format type (PPTX, PDF, CSV, JSON, XLSX, PNG, etc.)
- **CONJUNCTION AWARENESS**: Detect requirements connected by "&", "and", ",", "both", "all"
- **EXPLICIT REQUIREMENTS**: Any explicitly mentioned format, deliverable, or content type
- **CASE-INSENSITIVE**: Handle variations in capitalization (pptx, PPTX, Pdf, PDF)
- **VARIATION HANDLING**: Recognize format variations (Excel = XLSX, JPG = JPEG)

**EXTRACTION PATTERNS** (generic, not specific examples):
- Conjunction patterns: "X & Y", "X and Y", "X, Y, and Z", "both X and Y"
- Format specifications: "in X, Y format", "as X and Y", "return X & Y"
- List patterns: "X, Y, Z", "create X, Y, Z"
- Explicit lists: "I need X, Y, and Z"
- Multiple mentions: Any format mentioned multiple times in task
- Pattern-based requirements: "*summary*.json" means JSON format is required, "*summary*.csv" means CSV format is required
- Format-specific requests: "summary statistics JSON" explicitly requires JSON, "summary statistics CSV" explicitly requires CSV

**VALIDATION PRINCIPLES**:
- **ALL-OR-NOTHING**: If task requests multiple formats, ALL must be delivered
- **ZERO TOLERANCE**: Missing ANY requested requirement = task failure (score 0)
- **NO PARTIAL SUCCESS**: Cannot proceed if ANY requirement is missing
- **CLEAR FAILURE MESSAGES**: When requirements missing, state exactly what's missing

**FORMAT-TO-EXTENSION MAPPING** (dynamic, not hardcoded):
- Map format names to file extensions dynamically using LLM reasoning
- Handle common variations (Excel/XLSX, JPG/JPEG, etc.)
- Support any format type mentioned in task
- Case-insensitive matching
- **PATTERN-BASED FORMAT DETECTION**: If pattern like "*summary*.json" appears, extract format from pattern (JSON in this case). Patterns explicitly indicate required format.
"""



