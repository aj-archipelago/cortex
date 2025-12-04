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
                output = df.to_string()
                
                # Truncate if too large (check both rows and output size)
                max_rows = 200
                max_output_size = 500 * 1024  # 500KB - maximum output size
                max_row_output = 200 * 1024  # 200KB max for first+last rows combined
                
                if len(df) > max_rows or len(output) > max_output_size:
                    # Return first 100 rows and last 100 rows
                    first_part = df.head(100).to_string()
                    last_part = df.tail(100).to_string()
                    
                    # Even after truncating to 100+100 rows, check total output size
                    combined_output = first_part + last_part
                    if len(combined_output) > max_row_output:
                        # If still too large, truncate each part to fit within limit
                        # Split roughly 50/50 between first and last
                        per_part_limit = max_row_output // 2
                        if len(first_part) > per_part_limit:
                            first_part = first_part[:per_part_limit] + '\n... [truncated - output too large]'
                        
                        if len(last_part) > per_part_limit:
                            # Keep the end of last_part
                            last_part = '... [truncated - output too large]\n' + last_part[-per_part_limit:]
                    
                    truncation_note = f"\n\n... [TRUNCATED: DataFrame has {len(df):,} total rows. Showing first 100 and last 100 rows only (output limited to {max_row_output//1024}KB) to prevent LLM context overflow] ...\n\n"
                    return first_part + truncation_note + last_part
                
                return output
            except ImportError:
                return "ERROR: pandas not available for reading Excel files"
            except Exception as e:
                return f"ERROR: Failed to read Excel file: {str(e)}"

        # Handle JSON files
        elif file_ext == '.json':
            file_size = os.path.getsize(resolved_path)
            max_size = 500 * 1024  # 500KB - maximum output size
            max_items = 200  # If array has > 200 items, truncate
            max_item_output = 200 * 1024  # 200KB max for first+last items combined
            
            with open(resolved_path, 'r', encoding='utf-8') as f:
                data = json_module.load(f)
                
                # Check if it's a large array first (before stringifying)
                if isinstance(data, list) and len(data) > max_items:
                    first_items = data[:100]
                    last_items = data[-100:]
                    first_output = json_module.dumps(first_items, indent=2, ensure_ascii=False)
                    last_output = json_module.dumps(last_items, indent=2, ensure_ascii=False)
                    
                    # Even after truncating to 100+100 items, check total output size
                    combined_output = first_output + last_output
                    if len(combined_output) > max_item_output:
                        # If still too large, truncate each part to fit within limit
                        # Split roughly 50/50 between first and last
                        per_part_limit = max_item_output // 2
                        if len(first_output) > per_part_limit:
                            # Truncate first part
                            first_output = first_output[:per_part_limit]
                            # Try to end at a complete JSON item if possible
                            last_bracket = first_output.rfind('}')
                            if last_bracket > per_part_limit * 0.8:  # If we're close to a complete item
                                first_output = first_output[:last_bracket + 1] + '\n  ...'
                        
                        if len(last_output) > per_part_limit:
                            # Truncate last part from the beginning
                            last_output = last_output[-per_part_limit:]
                            # Try to start at a complete JSON item if possible
                            first_bracket = last_output.find('{')
                            if first_bracket < per_part_limit * 0.2:  # If we're close to a complete item
                                last_output = '  ...\n' + last_output[first_bracket:]
                    
                    truncation_note = f"\n\n... [TRUNCATED: JSON array has {len(data):,} total items. Showing first 100 and last 100 items only (output limited to {max_item_output//1024}KB) to prevent LLM context overflow] ...\n\n"
                    return first_output + truncation_note + last_output
                
                # For non-arrays or small arrays, check output size
                output = json_module.dumps(data, indent=2, ensure_ascii=False)
                
                # Truncate if output is too large
                if len(output) > max_size:
                    # For other JSON structures, just truncate the string output
                    truncation_note = f"\n\n... [TRUNCATED: JSON file is {len(output):,} characters. Showing first {max_size//1024}KB only to prevent LLM context overflow] ...\n\n"
                    return output[:max_size] + truncation_note
                
                return output

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
            # Check file size first to avoid loading huge files into memory
            file_size = os.path.getsize(resolved_path)
            max_size = 500 * 1024  # 500KB - reasonable limit for LLM context
            max_lines = 200  # If file has <= 200 lines, return everything
            
            with open(resolved_path, 'r', encoding='utf-8') as f:
                # First, check if file is small enough to read fully
                if file_size <= max_size:
                    content = f.read()
                    # Double-check: if it's small but has many lines, still truncate
                    line_count = content.count('\n') + (1 if content and not content.endswith('\n') else 0)
                    if line_count <= max_lines:
                        return content
                    # Otherwise, need to truncate - reset file pointer
                    f.seek(0)
                
                # For large files, read first 100 and last 100 lines
                first_lines = []
                line_count = 0
                
                # Read first 100 lines
                for i, line in enumerate(f):
                    if i < 100:
                        first_lines.append(line)
                    line_count = i + 1
                    # Stop early if we've read enough to know it's large
                    if i >= 200:
                        break
                
                # If file has <= 200 lines, read and return everything
                if line_count <= max_lines:
                    f.seek(0)
                    return f.read()
                
                # For files with > 200 lines, get last 100 lines efficiently
                # Use a sliding window approach for very large files
                last_lines = []
                if line_count > 200:
                    # For efficiency with huge files, read from end in chunks
                    # Read last ~50KB to get last 100 lines (assuming ~500 chars/line average)
                    chunk_size = min(50 * 1024, file_size)
                    f.seek(max(0, file_size - chunk_size))
                    # Skip partial first line
                    f.readline()
                    # Read remaining and take last 100
                    remaining = f.readlines()
                    last_lines = remaining[-100:] if len(remaining) >= 100 else remaining
                else:
                    # Small enough to read all
                    f.seek(0)
                    all_lines = f.readlines()
                    last_lines = all_lines[-100:]
                
                # Combine first 100, truncation note, and last 100
                first_part = ''.join(first_lines)
                last_part = ''.join(last_lines)
                
                # Estimate total lines if we didn't count them all
                if line_count <= 200:
                    estimated_total = line_count
                else:
                    # Rough estimate based on file size and average line length
                    avg_line_len = len(first_part) / min(100, len(first_lines)) if first_lines else 100
                    estimated_total = int(file_size / avg_line_len) if avg_line_len > 0 else line_count
                
                truncation_note = f"\n\n... [TRUNCATED: File has approximately {estimated_total:,} total lines ({file_size:,} bytes). Showing first 100 and last 100 lines only to prevent LLM context overflow] ...\n\n"
                
                return first_part + truncation_note + last_part

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
