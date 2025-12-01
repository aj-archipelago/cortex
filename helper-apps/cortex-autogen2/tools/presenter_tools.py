"""
Presenter Tools for file reading.

Provides read_file function with FunctionTool export.
"""

from autogen_core.tools import FunctionTool
from typing import Optional


def read_file(file_path: str, work_dir: Optional[str] = None) -> str:
    """
    Read a file and return its contents for data analysis.
    Supports various file formats including structured data files, documents, and text content.

    Args:
        file_path: Path to the file to read (relative paths resolved using work_dir)
        work_dir: Optional working directory for resolving relative paths

    Returns:
        String content of the file
    """
    import os
    import json as json_module
    try:
        # Resolve relative paths using work_dir if provided
        resolved_path = file_path
        if work_dir and not os.path.isabs(file_path):
            # Try different path resolution strategies
            candidate_path = os.path.join(work_dir, file_path)
            if os.path.exists(candidate_path):
                resolved_path = candidate_path
            else:
                # Try just the filename in work_dir
                filename = os.path.basename(file_path)
                candidate_path = os.path.join(work_dir, filename)
                if os.path.exists(candidate_path):
                    resolved_path = candidate_path
                else:
                    # Search work_dir for the file
                    if os.path.exists(work_dir):
                        for root, dirs, files in os.walk(work_dir):
                            if filename in files:
                                resolved_path = os.path.join(root, filename)
                                break

        if not os.path.exists(resolved_path):
            return f"ERROR: File not found: {file_path} (resolved to: {resolved_path})"

        # Additional security - check if path is reasonable
        if '..' in resolved_path or not any(allowed_dir in resolved_path for allowed_dir in ['/tmp/coding', '/tmp']):
            return f"ERROR: Invalid file path: {file_path} (resolved to: {resolved_path})"

        file_ext = os.path.splitext(resolved_path)[1].lower()

        # Handle Excel files
        if file_ext in ['.xlsx', '.xls']:
            try:
                import pandas as pd
                df = pd.read_excel(resolved_path)
                return df.to_string()
            except ImportError:
                return "ERROR: pandas not available for reading Excel files"
            except Exception as e:
                return f"ERROR: Failed to read Excel file: {str(e)}"

        # Handle JSON files
        elif file_ext == '.json':
            with open(resolved_path, 'r', encoding='utf-8') as f:
                data = json_module.load(f)
                return json_module.dumps(data, indent=2, ensure_ascii=False)

        # Handle DOCX files
        elif file_ext == '.docx':
            try:
                import docx2txt
                return docx2txt.process(resolved_path)
            except ImportError:
                return "ERROR: python-docx not available for reading DOCX files"
            except Exception as e:
                return f"ERROR: Failed to read DOCX file: {str(e)}"

        # Handle CSV and other text files
        else:
            with open(resolved_path, 'r', encoding='utf-8') as f:
                content = f.read()
                return content

    except Exception as e:
        return f"ERROR: Failed to read file {file_path}: {str(e)}"


# Export FunctionTool-wrapped versions
read_file_tool = FunctionTool(
    read_file,
    description="Read file content for data analysis. Supports various structured data formats and documents."
)

# Helper to create FunctionTool with work_dir bound
def get_read_file_tool(work_dir: Optional[str] = None) -> FunctionTool:
    """
    Create a FunctionTool for reading files with work_dir bound.
    
    Args:
        work_dir: Working directory for resolving relative file paths
        
    Returns:
        FunctionTool configured for the specified work directory
    """
    def read_file_bound(file_path: str) -> str:
        """Read file with work_dir pre-bound."""
        return read_file(file_path, work_dir)
    
    return FunctionTool(
        read_file_bound,
        description="Read file content for data analysis. Supports various structured data formats and documents. Relative paths are resolved relative to the work directory."
    )
