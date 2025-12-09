# Request context related constants

REQUEST_CONTEXT_HEADER = """
=== REQUEST CONTEXT ===
{request_vars}
"""

AUTONOMOUS_EXECUTION_HEADER = """
=== MANDATORY AUTONOMOUS EXECUTION ===
You operate FULLY AUTONOMOUSLY. No user interaction available after task submission.
- Execute actions immediately, don't plan or ask questions
- NEVER ask users for clarification, data, or manual actions
- Complete tasks end-to-end without waiting for feedback
"""

REQUEST_CONTEXT_PROMPT = """
=== REQUEST CONTEXT ===
- **Request ID**: {request_id}
- **Working Directory**: {work_dir}
- **File Isolation**: All files for this request must be saved to {work_dir}
- **No Cross-Request Interference**: Never access files from other request directories
"""

WORK_DIR_USAGE = """
**CRITICAL WORK_DIR USAGE**:
- **MANDATORY**: Use `os.getcwd()` to get the working directory in code (see Working Directory above)
- **FORBIDDEN**: Do NOT hardcode paths - use `os.getcwd()` instead
- **FORBIDDEN**: Do NOT define `work_dir` variable in your code - use `os.getcwd()` directly
- **REQUIRED**: Use `os.path.join(os.getcwd(), 'filename.ext')` for all file paths - never hardcode paths
- **VERIFICATION**: After creating files, verify they exist before marking ready for upload
- **UPLOAD MARKERS**: Always use the exact file path from `os.path.join(os.getcwd(), ...)` in "📁 Ready for upload:" markers
- **ISOLATION**: NEVER create subdirectories - save ALL files directly to the current working directory
"""
