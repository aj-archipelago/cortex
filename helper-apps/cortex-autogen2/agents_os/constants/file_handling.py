# File handling and upload related constants

UPLOAD_MARKER_INSTRUCTIONS = """
**INTERNAL UPLOAD MARKER REQUIREMENT** (for system detection only):
- After saving EACH deliverable file, immediately print: print(f"📁 Ready for upload: {{absolute_file_path}}")
- This marker is for INTERNAL SYSTEM DETECTION ONLY - do NOT output "Ready for upload" messages as user-facing text
- The print() statement signals the system to detect files for upload, but this is NOT visible to users
- Without these markers, files will not be uploaded to the user
- Format: print(f"📁 Ready for upload: {{absolute_file_path}}")
- **CRITICAL**: Mark files internally using print() for system detection. Do NOT output 'Ready for upload' messages as user-facing text. System handles upload detection automatically.
"""

FILE_VERIFICATION_INSTRUCTIONS = """
**FILE VERIFICATION - MANDATORY BEFORE UPLOAD MARKER** (UNIVERSAL PRINCIPLE):
- **PRINCIPLE: VERIFY BEFORE DECLARE** (Applies to ANY file type, ANY task):
  * Always verify file existence after saving: Use if/else error handling, NOT assertions
  * Check file size to ensure it was written correctly: if os.path.exists(file_path) and os.path.getsize(file_path) > 0
  * Report file paths explicitly after creation
  * **CRITICAL**: For external resource downloads (images, APIs), use try/except with fallback logic
  * **NEVER use assert statements** - they abort execution and prevent fallback strategies
  * **Image Download Pattern**: Try primary source, catch exceptions, fallback to secondary source, report errors clearly
  * **Example**: Use error handling patterns (try/except) with fallback logic rather than assertions that abort execution
  * This principle applies to ANY file creation, ANY file format, ANY task type

**ENHANCED FILE VALIDATION** (Applies to ANY file format):
- **Universal Validation Pattern**:
  * Verify file exists at declared path
  * Verify file size > 0 (not empty)
  * Verify file format is valid (not corrupted)
  * Verify file name matches task requirements (if specified)
  * Only proceed after all verifications pass
- **Format-Specific Validation** (applies to ANY file format):
  * **PPTX Files**: Verify slide count > 0 and file size > 50KB before marking for upload
    * Example: `if len(prs.slides) == 0: raise ValueError("No slides created!")`
    * Example: `if os.path.getsize(output_path) < 50000: raise ValueError("PPTX file too small, likely empty")`
  * **PDF Files**: Verify file size > 10KB (empty PDFs are typically < 5KB)
  * **Image Files**: Verify file size > 1KB (very small images are likely corrupted or empty)
  * **CSV/JSON Files**: Verify file has content (check row count > 0 or JSON is parseable)
  * **ZIP Files**: Verify can be opened and contains files
  * **Excel Files**: Verify can be opened and contains data
  * **Any Other Format**: Verify file is not empty and can be opened/read
- **Requirement Matching Verification** (Applies to ANY file creation task):
  * **PRINCIPLE: MATCH REQUIREMENTS**: Verify created files match task requirements - names, formats, content structure
  * Extract file requirements from task (names, formats, structure)
  * Verify created files match requirements exactly
  * If mismatch detected → adapt file creation to match requirements (rename or recreate)
  * Only mark complete when requirements met
- **CRITICAL**: If validation fails, print clear error message and retry file creation - DO NOT mark invalid files for upload
- **ONLY mark "📁 Ready for upload" internally (print() for system detection) after ALL validations pass - this is NOT user-facing output**
- This applies to ANY file creation task, ANY naming requirement, ANY format requirement
"""

BASE64_FORBIDDEN = """
**NEVER RETURN BASE64-ENCODED FILES**:
- FORBIDDEN: Printing base64-encoded file contents to stdout
- FORBIDDEN: Returning JSON with {"base64": "..."} as the only output
- FORBIDDEN: Using print(json.dumps({"filename": "x.pdf", "base64": "..."}))
- REQUIRED: Save actual files to disk that can be uploaded to Azure Blob Storage
- **WHY**: Presenter needs physical file paths to upload - base64 strings cannot be uploaded
"""

FILE_HANDLING_GUIDANCE = """
**FILE HANDLING GUIDANCE**:
- Always extract needed information from tool responses
- Parse structured data appropriately to get required fields
- Format extracted information for user consumption
- Verify information exists before referencing it
- Use clean identifiers derived from actual file information
- Remove system artifacts like timestamps, hashes, prefixes
"""

FILE_HANDLING_RULES = """
    ═══════════════════════════════════════════════════════════════════════════════
    CRITICAL CRITICAL - MANDATORY PHYSICAL FILE SAVING RULES CRITICAL
    ═══════════════════════════════════════════════════════════════════════════════

    **ABSOLUTE REQUIREMENTS - ZERO TOLERANCE FOR VIOLATIONS**:

    1. **ALWAYS SAVE PHYSICAL FILES TO DISK**:
       - ALL deliverable files MUST be saved as actual files on disk
       - Use Python's file I/O (open(), write(), etc.) to create real files
       - Use work_dir from request context, never assume paths or use environment variables

    2. **NEVER RETURN BASE64-ENCODED FILES AS OUTPUT**:
       - FORBIDDEN: Printing base64-encoded file contents to stdout
       - FORBIDDEN: Returning JSON with {"base64": "..."} as the only output
       - FORBIDDEN: Using print(json.dumps({"filename": "x.pdf", "base64": "..."}))
       - REQUIRED: Save actual files to disk that can be uploaded to Azure Blob Storage
       - **WHY**: Presenter needs physical file paths to upload - base64 strings cannot be uploaded

    3. **ALWAYS PRINT UPLOAD MARKERS INTERNALLY** (for system detection only):
       - After saving EACH deliverable file, immediately print: print(f"📁 Ready for upload: {{absolute_file_path}}")
       - This marker is for INTERNAL SYSTEM DETECTION ONLY - do NOT output "Ready for upload" messages as user-facing text
       - The print() statement signals the system to detect files for upload, but this is NOT visible to users
       - Without these markers, files will not be uploaded to the user
       - **CRITICAL**: Mark files internally using print() for system detection. Do NOT output 'Ready for upload' messages as user-facing text.

    4. **GENERIC FILE CREATION INTELLIGENCE**:
       - **SMART LIBRARY SELECTION**: Choose the most appropriate libraries for each requested file format based on content type and requirements
       - **TECHNICAL ADAPTATION**: Handle format-specific technical requirements (encoding, compatibility, etc.) dynamically
       - **FALLBACK STRATEGIES**: If preferred libraries aren't available, use alternative approaches
       - **DATA STRUCTURE ADAPTATION**: Format data appropriately for each target file format
       - **COMPATIBILITY HANDLING**: Address encoding, font, and format limitations intelligently
       - Data files (.json) - Use json module, save with json.dump()

    **WORKFLOW PRINCIPLES** (understand these, don't copy code):
    - **File Creation**: Always use work_dir from request context, never assume paths or use environment variables
    - **Immediate Saving**: Save files to disk immediately after creation, don't keep in memory
    - **Existence Verification**: Always validate file creation with os.path.exists() and print confirmation message
    - **MANDATORY PREVIEW GENERATION**: For ALL PDF creation tasks, you MUST generate a preview thumbnail image. This is required for clickable previews. Use pdf2image to convert the first page to PNG format. Save as "filename_preview.png" and print upload marker. Example: "quote_of_the_day.pdf" → "quote_of_the_day_preview.png"
    - **Internal Upload Signaling**: Mark files internally using print() for system detection: "📁 Ready for upload: path" - this is NOT user-facing output
    - **Error Handling**: Wrap preview generation in try/catch, don't fail if preview fails
    - **Metadata Logging**: Log file size and basic info for debugging

    **AVOID THESE ANTI-PATTERNS**:
    - Base64 encoding files (creates context bloat)
    - Keeping files in memory (causes memory issues)
    - Assuming file paths exist (always validate)

    **CRITICAL CONTEXT**:
    - Users are REMOTE - they can only access files via Azure Blob Storage SAS URLs
    - Presenter agent uploads physical files and provides SAS URLs to users
    - Base64 strings in JSON cannot be uploaded to blob storage
    - Without physical files, presenter has nothing to upload -> task fails
"""
