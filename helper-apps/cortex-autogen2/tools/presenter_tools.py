"""
Presenter Tools for file reading and upload result parsing.

Provides read_file and parse_upload_results functions with FunctionTool exports.
"""

from autogen_core.tools import FunctionTool


def read_file(file_path: str) -> str:
    """
    Read a file and return its contents for data analysis.
    Supports various file formats including structured data files, documents, and text content.

    Args:
        file_path: Path to the file to read

    Returns:
        String content of the file
    """
    import os
    import json as json_module
    try:
        if not os.path.exists(file_path):
            return f"ERROR: File not found: {file_path}"

        # Additional security - check if path is reasonable
        if '..' in file_path or not any(work_dir in file_path for work_dir in ['/tmp/coding', '/tmp']):
            return f"ERROR: Invalid file path: {file_path}"

        file_ext = os.path.splitext(file_path)[1].lower()

        # Handle Excel files
        if file_ext in ['.xlsx', '.xls']:
            try:
                import pandas as pd
                df = pd.read_excel(file_path)
                return df.to_string()
            except ImportError:
                return "ERROR: pandas not available for reading Excel files"
            except Exception as e:
                return f"ERROR: Failed to read Excel file: {str(e)}"

        # Handle JSON files
        elif file_ext == '.json':
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json_module.load(f)
                return json_module.dumps(data, indent=2, ensure_ascii=False)

        # Handle DOCX files
        elif file_ext == '.docx':
            try:
                import docx2txt
                return docx2txt.process(file_path)
            except ImportError:
                return "ERROR: python-docx not available for reading DOCX files"
            except Exception as e:
                return f"ERROR: Failed to read DOCX file: {str(e)}"

        # Handle CSV and other text files
        else:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                return content

    except Exception as e:
        return f"ERROR: Failed to read file {file_path}: {str(e)}"


def parse_upload_results(upload_results_json: str) -> str:
    """
    Parse upload results JSON and create HTML download links.
    This tool extracts download URLs from the upload results.
    """
    import json
    import re

    try:
        # Clean up the input string if it contains markdown code blocks
        cleaned_json = upload_results_json
        # Remove markdown code block syntax
        if "```" in cleaned_json:
            # Try to extract content between ```json and ``` or just ``` and ```
            match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', cleaned_json)
            if match:
                cleaned_json = match.group(1)
            else:
                # Fallback: remove all backticks
                cleaned_json = cleaned_json.replace("```json", "").replace("```", "")
        
        # Try to find JSON object if it's mixed with text
        json_match = re.search(r'\{.*\}', cleaned_json, re.DOTALL)
        if json_match:
            try:
                potential_json = json_match.group(0)
                results = json.loads(potential_json)
                # Verify it has what we need
                if isinstance(results, dict) and 'uploads' in results:
                    cleaned_json = potential_json
            except:
                pass # Fallback to original cleanup

        # Parse the JSON
        results = json.loads(cleaned_json)

        if not isinstance(results, dict) or 'uploads' not in results:
            return "ERROR: Invalid upload results format - missing 'uploads' array"

        uploads = results['uploads']
        if not isinstance(uploads, list):
            return "ERROR: 'uploads' is not an array"

        links = []
        for upload in uploads:
            if isinstance(upload, dict) and 'download_url' in upload:
                url = upload['download_url']
                # Extract filename from blob_name or local_filename
                filename = upload.get('blob_name') or upload.get('local_filename') or 'file'
                # Create HTML link
                link = f'<a href="{url}" target="_blank" rel="noopener noreferrer">Download {filename}</a>'
                links.append(link)

        if not links:
            return "ERROR: No valid download URLs found in upload results"

        return '\n'.join(links)

    except json.JSONDecodeError as e:
        return f"ERROR: Failed to parse JSON: {str(e)}"
    except Exception as e:
        return f"ERROR: Failed to process upload results: {str(e)}"


# Export FunctionTool-wrapped versions
read_file_tool = FunctionTool(
    read_file,
    description="Read file content for data analysis. Supports various structured data formats and documents."
)

parse_upload_tool = FunctionTool(
    parse_upload_results,
    description="Parse upload results JSON to extract download URLs and create HTML links"
)
