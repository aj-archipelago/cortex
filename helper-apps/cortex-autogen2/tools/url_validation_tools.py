"""
URL validation tools for checking accessibility of download links.
"""

import requests
import logging
from typing import Dict, Any
from autogen_core.tools import FunctionTool

logger = logging.getLogger(__name__)

def validate_url_accessibility(url: str, timeout_seconds: int = 5) -> Dict[str, Any]:
    """
    Validate that a URL is accessible by making a HEAD request.

    Args:
        url: The URL to validate
        timeout_seconds: Timeout for the request in seconds

    Returns:
        Dict with validation results:
        - accessible: bool
        - status_code: int or None
        - error: str or None
        - url: the original URL
    """
    try:
        # Use HEAD request to check accessibility without downloading content
        response = requests.head(url, timeout=timeout_seconds, allow_redirects=True)

        result = {
            "url": url,
            "accessible": response.status_code == 200,
            "status_code": response.status_code,
            "error": None
        }

        if not result["accessible"]:
            result["error"] = f"HTTP {response.status_code}"
            logger.warning(f"❌ URL not accessible: {url} (HTTP {response.status_code})")

        return result

    except requests.exceptions.Timeout:
        logger.warning(f"❌ URL timeout: {url} ({timeout_seconds}s)")
        return {
            "url": url,
            "accessible": False,
            "status_code": None,
            "error": f"Timeout ({timeout_seconds}s)"
        }

    except requests.exceptions.RequestException as e:
        error_msg = str(e)[:100]  # Truncate long error messages
        logger.warning(f"❌ URL validation failed: {url} ({error_msg})")
        return {
            "url": url,
            "accessible": False,
            "status_code": None,
            "error": error_msg
        }

    except Exception as e:
        error_msg = str(e)[:100]
        logger.error(f"❌ URL validation error: {url} ({error_msg})")
        return {
            "url": url,
            "accessible": False,
            "status_code": None,
            "error": f"Validation error: {error_msg}"
        }

# Create the URL validation tool
url_validation_tool = FunctionTool(
    validate_url_accessibility,
    description="Validate URL accessibility with HEAD request. Returns dict with 'accessible' boolean, 'status_code', and 'error' fields. Use this to verify download URLs work before presenting them to users."
)

__all__ = ['url_validation_tool', 'validate_url_accessibility']

