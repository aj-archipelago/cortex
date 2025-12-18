# File Operations and Upload Management constants

UPLOAD_TASK_DEFINITION = """
**YOUR TASK**:
- **MANDATORY**: Intelligently select and upload final deliverable files
- **MANDATORY**: Skip temporary and intermediate files
- **MANDATORY**: Return structured upload results with download URLs
- **MANDATORY**: Handle file selection logic automatically
"""

FILE_SELECTION_LOGIC = """
**FILE SELECTION LOGIC**:
- **MANDATORY**: Only upload final deliverable files (CSVs, PDFs, PPTX, PNGs, etc.)
- **MANDATORY**: Skip temporary files (tmp_*, ._*, cache files)
- **MANDATORY**: Skip intermediate processing files
- **MANDATORY**: Skip system files and directories
- **MANDATORY**: Prioritize files in the work directory root
"""

CRITICAL_RETURN_FORMAT = """
**CRITICAL - RETURN FORMAT**:
- **MANDATORY**: Return JSON object with uploads array
- **MANDATORY**: Include local_filename and download_url for each file
- **MANDATORY**: Provide total_uploaded count
- **MANDATORY**: Handle errors gracefully with error fields
"""

UPLOAD_VALIDATION_CHECKS = """
**UPLOAD VALIDATION CHECKS**:
- **MANDATORY**: Verify files exist before attempting upload
- **MANDATORY**: Check file sizes are reasonable (>0 bytes)
- **MANDATORY**: Validate file formats are supported
- **MANDATORY**: Confirm upload success and URL accessibility
- **MANDATORY**: Handle partial upload failures appropriately
"""

FILE_PROCESSING_PRIORITIES = """
**FILE PROCESSING PRIORITIES**:
- **MANDATORY**: Process files in logical order (data first, then visuals)
- **MANDATORY**: Group related files together when possible
- **MANDATORY**: Handle large files appropriately to avoid timeouts
- **MANDATORY**: Provide progress feedback for batch operations
"""

UPLOAD_ERROR_HANDLING = """
**UPLOAD ERROR HANDLING**:
- **MANDATORY**: Implement retry logic for transient failures
- **MANDATORY**: Provide detailed error messages for debugging
- **MANDATORY**: Continue processing other files when one fails
- **MANDATORY**: Maintain partial success reporting
- **MANDATORY**: Clean up failed uploads appropriately
"""
