"""
File download tools.
"""
import requests
import os
import mimetypes
from urllib.parse import urlparse

def download_file(url: str, filename: str = None) -> str:
    """
    Downloads a file from a URL and saves it to the current working directory.

    Args:
        url: The URL of the file to download.
        filename: The desired filename. If not provided, it will be inferred from the URL.

    Returns:
        A success or error message string.
    """
    try:
        response = requests.get(url, stream=True, timeout=30)
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

        filepath = os.path.join(os.getcwd(), filename)
        
        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        return f"Successfully downloaded '{url}' and saved as '{filename}'"

    except requests.exceptions.RequestException as e:
        return f"Error downloading file: {e}"
    except Exception as e:
        return f"An unexpected error occurred: {e}" 