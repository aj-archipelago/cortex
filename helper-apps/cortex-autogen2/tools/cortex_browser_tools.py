"""
CortexBrowser tool for fetching web pages with screenshots.

Integrates with the Cortex Browser service to fetch web pages
and optionally capture screenshots for GPT-4 Vision models.
"""

import logging
import os
import aiohttp
import json
import base64
import re
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Get Cortex Browser URL from environment
CORTEX_BROWSER_URL = os.getenv("CORTEX_BROWSER_URL", "")


def _safe_filename_from_url(url: str, extension: str = ".png") -> str:
    """Generate a safe filename from URL."""
    parsed = urlparse(url)
    host = parsed.netloc.replace('www.', '').replace('.', '_')
    safe_path = parsed.path.strip('/').replace('/', '_') or 'index'
    # Remove unsafe characters
    safe_path = re.sub(r'[^\w\-_]', '_', safe_path)
    if len(safe_path) > 100:
        safe_path = safe_path[:100]
    filename = f"{host}_{safe_path}{extension}"
    return filename


def _save_screenshot_to_workdir(work_dir: str, url: str, screenshot_base64: str) -> str:
    """Save base64 screenshot to PNG file in work directory."""
    os.makedirs(work_dir, exist_ok=True)
    filename = _safe_filename_from_url(url, extension=".png")
    path = os.path.join(work_dir, filename)
    try:
        # Decode base64 and save as PNG
        image_data = base64.b64decode(screenshot_base64)
        with open(path, 'wb') as f:
            f.write(image_data)
        return path
    except Exception as e:
        logger.error(f"Failed to save screenshot: {e}")
        raise


def _save_text_to_workdir(work_dir: str, url: str, text: str) -> str:
    """Save text content to file in work directory."""
    os.makedirs(work_dir, exist_ok=True)
    filename = _safe_filename_from_url(url, extension=".txt")
    path = os.path.join(work_dir, filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return path


async def cortex_browser(url: str, include_screenshot: bool = True, timeout: int = 30, work_dir: Optional[str] = None) -> str:
    """
    Fetch a webpage using the Cortex Browser service.
    
    Args:
        url: The URL to fetch (must start with http:// or https://)
        include_screenshot: Whether to include a screenshot in the response
        timeout: Request timeout in seconds
        work_dir: If provided, automatically saves screenshot and text to files (not in JSON)
        
    Returns:
        JSON string containing:
        - url: The final URL after redirects
        - text: Small text preview (<500 chars) if work_dir provided, else full text
        - screenshot: Base64-encoded screenshot (if include_screenshot=True and work_dir not provided)
        - saved_screenshot: File path to saved PNG (if work_dir provided and screenshot available)
        - saved_text: File path to saved text file (if work_dir provided)
        - error: Error message if any
        
    Example:
        result = await cortex_browser("https://google.com", work_dir="/tmp/coding")
        data = json.loads(result)
        screenshot_path = data.get("saved_screenshot")  # Use this file path
    """
    try:
        # Validate URL
        if not url:
            return json.dumps({"error": "URL parameter is required"})
        
        # Ensure URL has proper protocol
        if not url.startswith(("http://", "https://")):
            return json.dumps({
                "error": f"Invalid URL: must start with http:// or https://, got: {url}"
            })
        
        # Validate URL format
        try:
            parsed = urlparse(url)
            if not parsed.netloc:
                return json.dumps({
                    "error": f"Invalid URL format: {url}"
                })
        except Exception as e:
            return json.dumps({
                "error": f"Failed to parse URL: {str(e)}"
            })
        
        # Check if Cortex Browser URL is configured
        if not CORTEX_BROWSER_URL:
            return json.dumps({
                "error": "CORTEX_BROWSER_URL environment variable is not set"
            })
        
        # Build API URL
        api_url = f"{CORTEX_BROWSER_URL}/api/scrape"
        
        logger.info(f"[cortex_browser] Fetching URL: {url} (screenshot: {include_screenshot})")
        
        # Make request to Cortex Browser API
        async with aiohttp.ClientSession() as session:
            async with session.get(
                api_url,
                params={"url": url},
                timeout=aiohttp.ClientTimeout(total=timeout)
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    logger.error(f"[cortex_browser] API returned status {response.status}: {error_text}")
                    return json.dumps({
                        "error": f"Cortex Browser API error (status {response.status}): {error_text}"
                    })
                
                # Parse response
                try:
                    data = await response.json()
                except Exception as e:
                    logger.error(f"[cortex_browser] Failed to parse API response: {e}")
                    return json.dumps({
                        "error": f"Failed to parse API response: {str(e)}"
                    })
                
                # Check for error in response
                if "error" in data and data["error"]:
                    logger.warning(f"[cortex_browser] API returned error: {data['error']}")
                    return json.dumps({
                        "error": data["error"],
                        "url": data.get("url", url)
                    })
                
                # Get text and screenshot from API response
                text_content = data.get("text", "")
                screenshot_base64 = None
                if include_screenshot and "screenshot_base64" in data and data["screenshot_base64"]:
                    screenshot_base64 = data["screenshot_base64"]
                
                # When work_dir is provided, save files and return minimal JSON
                if work_dir:
                    saved_screenshot_path = None
                    saved_text_path = None
                    
                    # Save screenshot if available
                    if screenshot_base64:
                        try:
                            saved_screenshot_path = _save_screenshot_to_workdir(work_dir, data.get("url", url), screenshot_base64)
                            logger.info(f"[cortex_browser] Screenshot saved to: {saved_screenshot_path}")
                        except Exception as e:
                            logger.error(f"[cortex_browser] Failed to save screenshot: {e}")
                    
                    # Save text content
                    if text_content:
                        try:
                            saved_text_path = _save_text_to_workdir(work_dir, data.get("url", url), text_content)
                            logger.info(f"[cortex_browser] Text saved to: {saved_text_path}")
                        except Exception as e:
                            logger.error(f"[cortex_browser] Failed to save text: {e}")
                    
                    # Return minimal JSON with file paths
                    result = {
                        "url": data.get("url", url),
                        "text": text_content[:500],  # Small text preview (<1KB)
                        "note": "Full content saved to files. Use saved_screenshot and saved_text paths."
                    }
                    if saved_screenshot_path:
                        result["saved_screenshot"] = saved_screenshot_path
                    if saved_text_path:
                        result["saved_text"] = saved_text_path
                    
                    logger.info(f"[cortex_browser] Successfully fetched {url} (files saved, minimal JSON returned)")
                    return json.dumps(result, indent=2)
                
                # No work_dir: return full content in JSON (backward compatibility)
                result = {
                    "url": data.get("url", url),
                    "text": text_content
                }
                
                # Include screenshot if requested and available
                if screenshot_base64:
                    result["screenshot"] = screenshot_base64
                    logger.info(f"[cortex_browser] Screenshot included (length: {len(screenshot_base64)} chars)")
                elif include_screenshot:
                    logger.warning("[cortex_browser] Screenshot requested but not available in response")
                
                logger.info(f"[cortex_browser] Successfully fetched {url} (text length: {len(text_content)} chars)")
                
                return json.dumps(result, indent=2)
                
    except aiohttp.ClientError as e:
        logger.error(f"[cortex_browser] Network error: {e}")
        return json.dumps({
            "error": f"Network error: {str(e)}"
        })
    except Exception as e:
        logger.error(f"[cortex_browser] Unexpected error: {e}", exc_info=True)
        return json.dumps({
            "error": f"Unexpected error: {str(e)}"
        })


def get_cortex_browser_tool(work_dir: Optional[str] = None):
    """
    Factory function to create cortex_browser tool with work_dir bound.
    When work_dir is provided, cortex_browser automatically saves screenshot and text to files.
    """
    from autogen_core.tools import FunctionTool
    
    async def cortex_browser_bound(url: str, include_screenshot: bool = True, timeout: int = 30) -> str:
        """Bound version of cortex_browser with work_dir automatically set."""
        return await cortex_browser(url, include_screenshot=include_screenshot, timeout=timeout, work_dir=work_dir)
    
    return FunctionTool(
        cortex_browser_bound,
        description="Fetch a specific webpage by URL (not query) with screenshot. Takes URL as input, not search query. Use this AFTER search results to fetch visual pages. Automatically saves screenshot and text to files when work_dir is provided."
    )
