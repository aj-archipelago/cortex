"""
Simplified File Tools for Cortex-AutoGen2
Core file operations without excessive complexity.
"""

import asyncio
import logging
import os
import json
import mimetypes
from typing import List, Optional
from autogen_core.tools import FunctionTool

logger = logging.getLogger(__name__)


async def list_files_in_work_dir(work_dir: Optional[str] = None) -> str:
    """List files in the working directory."""
    try:
        if not work_dir:
            work_dir = os.getenv('CORTEX_WORK_DIR', '/tmp/coding')

        files = []
        for root, dirs, filenames in os.walk(work_dir):
            for filename in filenames:
                # Skip hidden and temp files
                if not filename.startswith('.') and not filename.startswith('tmp_'):
                    rel_path = os.path.relpath(os.path.join(root, filename), work_dir)
                    files.append(rel_path)

        return json.dumps({"files": files[:50]})  # Limit to 50 files
    except Exception as e:
        return json.dumps({"error": f"Failed to list files: {str(e)}"})


async def read_file_from_work_dir(filename: str, work_dir: Optional[str] = None, max_length: int = 5000) -> str:
    """Read a file from the working directory."""
    try:
        if not work_dir:
            work_dir = os.getenv('CORTEX_WORK_DIR', '/tmp/coding')

        file_path = os.path.join(work_dir, filename)
        if not os.path.exists(file_path):
            return json.dumps({"error": f"File not found: {filename}"})

        # Minimal security check - only block truly sensitive files
        ext = os.path.splitext(filename)[1].lower()
        blocked_exts = ['.key', '.pem', '.p12', '.pfx', '.keystore']  # Private key files only
        if ext in blocked_exts:
            return json.dumps({"error": f"Cannot read private key files: {ext}"})

        # Detect binary vs text files
        binary_exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
                       '.pdf', '.pptx', '.xlsx', '.docx', '.zip', '.tar', '.gz']
        if ext in binary_exts:
            # Binary file - return metadata only
            return json.dumps({"file": filename, "type": "binary", "size": os.path.getsize(file_path)})
        
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read(max_length)

        return json.dumps({"content": content, "truncated": len(content) >= max_length})
    except Exception as e:
        return json.dumps({"error": f"Failed to read file: {str(e)}"})


async def create_file(filename: str, content: str, work_dir: Optional[str] = None) -> str:
    """Create a new file with the given content."""
    try:
        if not work_dir:
            work_dir = os.getenv('CORTEX_WORK_DIR', '/tmp/coding')

        file_path = os.path.join(work_dir, filename)

        # Minimal security check - only block truly sensitive files
        ext = os.path.splitext(filename)[1].lower()
        blocked_exts = ['.key', '.pem', '.p12', '.pfx', '.keystore']  # Private key files only
        if ext in blocked_exts:
            return json.dumps({"error": f"Cannot create private key files: {ext}"})

        # Prevent misuse: reject image files with "DOWNLOADED_IMAGE:" prefix
        image_exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']
        if ext in image_exts and content.strip().startswith('DOWNLOADED_IMAGE:'):
            return json.dumps({"error": f"Cannot create image file '{filename}' with 'DOWNLOADED_IMAGE:' prefix. Use the 'download_file' tool with the image URL instead."})

        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)

        return json.dumps({"success": True, "file": filename, "size": len(content)})
    except Exception as e:
        return json.dumps({"error": f"Failed to create file: {str(e)}"})


def extract_pdf_text(file_path: str) -> str:
    """Extract text from PDF file (placeholder implementation)."""
    try:
        # Simple placeholder - in real implementation would use pypdf or similar
        return f"PDF text extraction not implemented for {file_path}"
    except Exception as e:
        return f"Error extracting PDF text: {str(e)}"

def extract_pptx_text(file_path: str) -> str:
    """Extract text from PPTX file (placeholder implementation)."""
    try:
        # Simple placeholder - in real implementation would use python-pptx
        return f"PPTX text extraction not implemented for {file_path}"
    except Exception as e:
        return f"Error extracting PPTX text: {str(e)}"

def get_file_tools(executor_work_dir: Optional[str] = None) -> List[FunctionTool]:
    """
    Get simplified file tools for any agent.

    Args:
        executor_work_dir: Working directory for file operations

    Returns:
        List of basic file management tools
    """
    tools = []

    # Create partial functions with work_dir bound
    def bound_list_files() -> str:
        return asyncio.run(list_files_in_work_dir(executor_work_dir))

    def bound_read_file(filename: str, max_length: int = 5000) -> str:
        return asyncio.run(read_file_from_work_dir(filename, executor_work_dir, max_length))

    def bound_create_file(filename: str, content: str) -> str:
        return asyncio.run(create_file(filename, content, executor_work_dir))

    # Add simplified tools
    tools.append(FunctionTool(
        bound_list_files,
        description="List files in the working directory"
    ))

    tools.append(FunctionTool(
        bound_read_file,
        description="Read text file content from the working directory"
    ))

    tools.append(FunctionTool(
        bound_create_file,
        description="Create a new text file with given content"
    ))

    return tools