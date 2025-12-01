"""
File download tools.
"""
import requests
import os
import mimetypes
from urllib.parse import urlparse
from typing import Optional
from autogen_core.tools import FunctionTool

# Use same User-Agent as search_tools for consistency
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

def download_file(url: str, filename: str = None, work_dir: str = None) -> str:
    """
    Downloads a file from a URL and saves it to the specified working directory.

    Args:
        url: The URL of the file to download.
        filename: The desired filename. If not provided, it will be inferred from the URL.
        work_dir: Working directory to save the file. Defaults to CORTEX_WORK_DIR or /tmp/coding.

    Returns:
        A success or error message string.
    """
    try:
        headers = {"User-Agent": USER_AGENT}
        response = requests.get(url, headers=headers, stream=True, timeout=30)
        response.raise_for_status()

        if not filename:
            parsed_url = urlparse(url)
            filename = os.path.basename(parsed_url.path)
            if not filename:
                # Guess filename from content type
                content_type = response.headers.get('content-type')
                if content_type:
                    extension = mimetypes.guess_extension(content_type)
                    if extension:
                        filename = f"downloaded_file{extension}"
                if not filename:
                    filename = "downloaded_file"

        # Use work_dir if provided, otherwise use environment variable or default
        if not work_dir:
            work_dir = os.getenv('CORTEX_WORK_DIR', '/tmp/coding')
        
        # Ensure work_dir exists
        os.makedirs(work_dir, exist_ok=True)
        
        filepath = os.path.join(work_dir, filename)
        
        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        # Validate image file size to catch corrupted downloads
        file_ext = os.path.splitext(filename)[1].lower()
        image_exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']
        if file_ext in image_exts:
            file_size = os.path.getsize(filepath)
            if file_size < 1000:  # Images should be at least 1KB
                os.remove(filepath)  # Clean up corrupted file
                return f"Error downloading image: File '{filename}' is too small ({file_size} bytes). The download may have failed or returned an error page instead of image data."
        
        return f"Successfully downloaded '{url}' and saved as '{filename}' in {work_dir}"

    except requests.exceptions.RequestException as e:
        return f"Error downloading file: {e}"
    except Exception as e:
        return f"An unexpected error occurred: {e}" 


# Factory function to create download tool with work_dir bound
def get_download_file_tool(work_dir: Optional[str] = None) -> FunctionTool:
    """
    Create a FunctionTool for file downloads with work_dir bound.
    
    Args:
        work_dir: Working directory to save downloaded files
        
    Returns:
        FunctionTool configured for the specified work directory
    """
    from autogen_core.tools import FunctionTool
    
    def download_file_bound(url: str, filename: str = None) -> str:
        return download_file(url, filename, work_dir)
    
    return FunctionTool(
        download_file_bound,
        description="Download a file from a URL and save it to the working directory with automatic filename detection."
    )

# Legacy export (uses environment variable for work_dir)
from autogen_core.tools import FunctionTool
download_file_tool = FunctionTool(
    download_file,
    description="Download a file from a URL and save it with automatic filename detection."
)
