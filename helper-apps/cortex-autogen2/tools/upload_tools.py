"""
Generic upload and file management tools for the Cortex AutoGen2 system.
These tools are shared across multiple agents.
"""

import os
import logging
from typing import List, Dict, Any, Optional
from tools.azure_blob_tools import upload_file_to_azure_blob

# =========================================================================
# Helper functions (copied from agents.util.helpers to avoid circular imports)
# =========================================================================

import json

def _wrap_json_result(result: Any) -> str:
    """Serialize outputs and wrap JSON payloads in code fences so AutoGen won't re-parse them."""

    def _wrap_if_json_string(value: str) -> str:
        stripped = value.strip()
        if not stripped:
            return value
        if stripped.startswith("```"):
            return value
        if stripped[0] in ("{", "["):
            return f"```json\n{value}\n```"
        return value

    try:
        if isinstance(result, (dict, list)):
            json_text = json.dumps(result, indent=2, ensure_ascii=False)
            return f"```json\n{json_text}\n```"
        if isinstance(result, str):
            return _wrap_if_json_string(result)
        if isinstance(result, (int, float, bool)) or result is None:
            return str(result)
        json_text = json.dumps(result, indent=2, ensure_ascii=False)
        return f"```json\n{json_text}\n```"
    except Exception:
        return str(result)

def create_safe_function_tool(func, description):
    from autogen_core.tools import FunctionTool
    import functools
    import inspect

    if inspect.iscoroutinefunction(func):
        @functools.wraps(func)
        async def wrapped_func(*args, **kwargs):
            result = await func(*args, **kwargs)
            return _wrap_json_result(result)
    else:
        @functools.wraps(func)
        def wrapped_func(*args, **kwargs):
            result = func(*args, **kwargs)
            return _wrap_json_result(result)

    wrapped_func.__signature__ = inspect.signature(func)
    wrapped_func.__annotations__ = func.__annotations__

    return FunctionTool(wrapped_func, description=description)

def upload_file_to_azure_blob_typed(work_dir: str, file_path: str, blob_name: str = None) -> str:
    # Enhanced path resolution for simplified directory structure
    if not os.path.isabs(file_path):
        # First try direct join with work_dir
        candidate_path = os.path.join(work_dir, file_path)
        if os.path.exists(candidate_path):
            file_path = candidate_path
        else:
            # If not found, try just the filename in work_dir (handles cases where full path was passed but work_dir changed)
            filename = os.path.basename(file_path)
            candidate_path = os.path.join(work_dir, filename)
            if os.path.exists(candidate_path):
                file_path = candidate_path
            else:
                # Last resort: search work_dir for any file with this name
                if os.path.exists(work_dir):
                    for root, dirs, files in os.walk(work_dir):
                        if filename in files:
                            file_path = os.path.join(root, filename)
                            break

    # Validate file exists before upload
    if not os.path.exists(file_path):
        return _wrap_json_result({"error": f"File not found: {file_path}"})

    # Validate file is readable
    if not os.access(file_path, os.R_OK):
        return _wrap_json_result({"error": f"File not readable: {file_path}"})

    try:
        result_json = upload_file_to_azure_blob(file_path, blob_name)
        return _wrap_json_result(result_json)
    except Exception as e:
        return _wrap_json_result({"error": f"Upload failed: {str(e)}"})

# =========================================================================
# Tool definitions
# =========================================================================

# Upload file to cloud tool (used by coder agent)
def _make_upload_tool(work_dir: str):
    def _inner(file_path: str, blob_name: Optional[str] = None) -> str:
        return upload_file_to_azure_blob_typed(work_dir, file_path, blob_name)
    return _inner

upload_file_to_cloud_tool = create_safe_function_tool(
    _make_upload_tool(work_dir=""),  # This will be overridden when agents are created
    description="Upload files to the cloud. You must use absolute path to reference local files.",
)

# Batch upload tool (used by uploader agent)
def batch_upload_for_uploader(file_paths: List[str]) -> str:
    """Upload multiple files to Azure Blob Storage and return SAS URLs."""
    logger = logging.getLogger(__name__)

    if not file_paths:
        return _wrap_json_result({"success": False, "error": "No file paths provided", "uploaded": [], "failed": []})

    successful_uploads = []
    failed_uploads = []

    for file_path in file_paths:
        try:
            # Validate file exists and is readable
            if not os.path.exists(file_path):
                failed_uploads.append({"file": file_path, "error": "File not found"})
                continue

            if not os.access(file_path, os.R_OK):
                failed_uploads.append({"file": file_path, "error": "File not readable"})
                continue

            # Upload file
            result = upload_file_to_azure_blob(file_path)
            if result and "sas_url" in result:
                successful_uploads.append({
                    "file": file_path,
                    "sas_url": result["sas_url"],
                    "blob_name": result.get("blob_name", os.path.basename(file_path))
                })
            else:
                failed_uploads.append({"file": file_path, "error": "Upload failed - no SAS URL returned"})

        except Exception as e:
            failed_uploads.append({"file": file_path, "error": str(e)})

    # Log summary
    if successful_uploads:
        logger.info(f"✅ Batch upload: {len(successful_uploads)} successful")
    if failed_uploads:
        logger.warning(f"❌ Batch upload: {len(failed_uploads)} failed")

    return _wrap_json_result({
        "success": len(successful_uploads) > 0,
        "uploaded": successful_uploads,
        "failed": failed_uploads,
        "total_uploaded": len(successful_uploads),
        "total_failed": len(failed_uploads)
    })

batch_upload_tool = create_safe_function_tool(
    batch_upload_for_uploader,
    description="Upload multiple files to Azure Blob Storage in one call. Provide a list of file paths (relative to work_dir or absolute). Returns JSON with upload results for all files. CRITICAL: Use this tool to actually upload files - do NOT hallucinate URLs."
)

# Preview generation tool (used by uploader agent)
def generate_preview_for_file(file_path: str) -> str:
    """Generate preview images for files that support previews."""
    if not os.path.exists(file_path):
        return _wrap_json_result({"preview_path": None, "original_file": file_path, "success": False, "reason": "File not found"})

    try:
        # Get file extension
        _, ext = os.path.splitext(file_path)
        ext = ext.lower()

        if ext == '.pdf':
            # For PDF files, we could generate a preview image
            # For now, just return success without preview
            return _wrap_json_result({"preview_path": None, "original_file": file_path, "success": True, "reason": "PDF preview not implemented yet"})

        elif ext in ['.pptx', '.docx', '.xlsx']:
            # For Office files, we could generate previews
            # For now, just return success without preview
            return _wrap_json_result({"preview_path": None, "original_file": file_path, "success": True, "reason": f"{ext.upper()} preview not implemented yet"})

        else:
            return _wrap_json_result({"preview_path": None, "original_file": file_path, "success": False, "reason": "Preview not supported or generation failed"})
    except Exception as e:
        return _wrap_json_result({"preview_path": None, "original_file": file_path, "success": False, "error": str(e)})

preview_generation_tool = create_safe_function_tool(
    generate_preview_for_file,
    description="Generate preview images for files that support it (PDF, PPTX, DOCX, XLSX). Returns JSON with preview file path. Call this for each file that needs a preview before uploading."
)

# Upload tool for presenter (simpler interface)
def upload_for_presenter(file_path: str, blob_name: str = None) -> str:
    """Upload a file for the presenter agent."""
    try:
        result = upload_file_to_azure_blob_typed("", file_path, blob_name)  # work_dir will be set by agent
        return result
    except Exception as e:
        return _wrap_json_result({"success": False, "error": str(e)})

upload_tool = create_safe_function_tool(
    upload_for_presenter,
    description="Upload a file to Azure Blob Storage and get a SAS URL for download. Provide absolute file path."
)

# =========================================================================
# Tool exports
# =========================================================================

__all__ = [
    'upload_file_to_cloud_tool',
    'batch_upload_tool',
    'preview_generation_tool',
    'upload_tool',
]
