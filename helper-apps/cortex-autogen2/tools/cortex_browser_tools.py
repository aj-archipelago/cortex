"""
CortexBrowser tool for fetching web pages with screenshots.

Integrates with the Cortex Browser service to fetch web pages
and optionally capture screenshots for GPT-4 Vision models.
"""

import logging
import os
import aiohttp
import json
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Get Cortex Browser URL from environment
CORTEX_BROWSER_URL = os.getenv("CORTEX_BROWSER_URL", "")


async def cortex_browser(url: str, include_screenshot: bool = True, timeout: int = 30) -> str:
    """
    Fetch a webpage using the Cortex Browser service.
    
    Args:
        url: The URL to fetch (must start with http:// or https://)
        include_screenshot: Whether to include a screenshot in the response
        timeout: Request timeout in seconds
        
    Returns:
        JSON string containing:
        - url: The final URL after redirects
        - text: Extracted text content from the page
        - screenshot: Base64-encoded screenshot (if include_screenshot=True)
        - error: Error message if any
        
    Example:
        result = await cortex_browser("https://google.com")
        data = json.loads(result)
        text = data.get("text")
        screenshot_b64 = data.get("screenshot")
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
                
                # Build result
                result = {
                    "url": data.get("url", url),
                    "text": data.get("text", "")
                }
                
                # Include screenshot if requested and available
                if include_screenshot and "screenshot_base64" in data and data["screenshot_base64"]:
                    result["screenshot"] = data["screenshot_base64"]
                    logger.info(f"[cortex_browser] Screenshot included (length: {len(data['screenshot_base64'])} chars)")
                elif include_screenshot:
                    logger.warning("[cortex_browser] Screenshot requested but not available in response")
                
                logger.info(f"[cortex_browser] Successfully fetched {url} (text length: {len(result['text'])} chars)")
                
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
