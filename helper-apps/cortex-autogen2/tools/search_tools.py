"""
Generic Web Search tool.
"""

import logging
import os
import requests
import json
from typing import Dict, Any, List, Optional
import asyncio # Import asyncio
import matplotlib.pyplot as plt
import pandas as pd

# try:
# except ImportError:
#     logging.warning("matplotlib.pyplot not found. Plotting functionality will be disabled.")
#     plt = None

# try:
# except ImportError:
#     logging.warning("pandas not found. CSV/DataFrame functionality may be limited.")
#     pd = None

BING_SEARCH_V7_ENDPOINT = os.getenv("AZURE_BING_API_ENDPOINT", "https://api.bing.microsoft.com/v7.0/search")
BING_SUBSCRIPTION_KEY = os.getenv("AZURE_BING_KEY")


async def bing_web_search(query: str, count: int = 5, response_filter: str = "Webpages") -> str:
    """
    Search the web using Bing Search API. Returns a clean, summarized list of results.
    
    Args:
        query: Search query string. Tip: Use 'site:example.com' to search a specific website.
        count: Number of results to return (default: 5, max: 20)
        response_filter: Type of search results to return (default: "Webpages", can be "Images", "Webpages,Images", etc.)
    
    Returns:
        JSON string with a list of search results.
    """
    try:
        subscription_key = os.environ.get("AZURE_BING_KEY")
        if not subscription_key:
            return json.dumps({"error": "AZURE_BING_KEY environment variable not set"})
        
        search_url = "https://api.bing.microsoft.com/v7.0/search"
        headers = {"Ocp-Apim-Subscription-Key": subscription_key}
        params = {
            "q": query,
            "count": min(count, 20),
            "responseFilter": response_filter,
            "mkt": "en-US",
        }
        
        response = requests.get(search_url, headers=headers, params=params)
        response.raise_for_status()
        
        search_results = response.json()
        
        # Process and clean the results
        output = []

        # Handle web pages
        if "webPages" in search_results and "value" in search_results["webPages"]:
            for page in search_results["webPages"]["value"]:
                output.append({
                    "type": "webpage",
                    "title": page.get("name"),
                    "url": page.get("url"),
                    "snippet": page.get("snippet")
                })
        
        # Handle images (if response_filter includes Images, and images are found)
        if "images" in search_results and "value" in search_results["images"]:
            for image in search_results["images"]["value"]:
                output.append({
                    "type": "image",
                    "title": image.get("name"),
                    "url": image.get("contentUrl"),
                    "thumbnail_url": image.get("thumbnailUrl"),
                    "width": image.get("width"),
                    "height": image.get("height"),
                    "host_page_url": image.get("hostPageUrl")
                })

        if not output:
            return json.dumps({"status": "No relevant results found."})
            
        return json.dumps(output, indent=2)
        
    except requests.exceptions.RequestException as e:
        return json.dumps({"error": f"Error performing Bing search: {str(e)}"})
    except Exception as e:
        return json.dumps({"error": f"Unexpected error in Bing search: {str(e)}"})


async def bing_image_search(query: str, count: int = 5) -> str:
    """
    Search for images using Bing Search API. Returns a clean, summarized list of image results.
    
    Args:
        query: Search query string for images
        count: Number of results to return (default: 5, max: 20)
    
    Returns:
        JSON string with a list of image search results.
    """
    return await bing_web_search(query, count, "Images")


async def bing_combined_search(query: str, count: int = 5) -> str:
    """
    Search for both web pages and images using Bing Search API.
    
    Args:
        query: Search query string
        count: Number of results to return (default: 5, max: 20)
    
    Returns:
        JSON string with a list of combined search results.
    """
    return await bing_web_search(query, count, "Webpages,Images")


async def _perform_single_cognitive_search(
    query: str = "*",
    index_name: str = "indexwires",
    date_filter: Optional[str] = None,
    top: int = 50,
    select: Optional[str] = None,
    facets: Optional[List[str]] = None,
    orderby: Optional[str] = None, # Added orderby parameter
    requires_bi: bool = False,
    context_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Performs a single search query on Azure Cognitive Search. Internal helper.
    """
    API_URL = os.environ.get('AZURE_COGNITIVE_API_URL')
    API_KEY = os.environ.get('AZURE_COGNITIVE_API_KEY')

    if not API_URL or not API_KEY:
        return {"error": "AZURE_COGNITIVE_API_URL or AZURE_COGNITIVE_API_KEY environment variables not set"}

    headers = {
        'Content-Type': 'application/json',
        'api-key': API_KEY
    }

    search_url = f"{API_URL}indexes/{index_name}/docs/search?api-version=2024-07-01" # Updated API version

    payload = {
        'search': query,
        'orderby': 'date desc', # Changed to date for consistency with previous working examples
        'top': min(top, 100),
    }

    if select:
        payload['select'] = select
    if date_filter:
        # Removed explicit stripping of timezone as the agent is responsible for correct ISO 8601 Z format
        payload['filter'] = date_filter
    if facets:
        payload['facets'] = facets
    
    # Apply contextId filter for indexcortex
    if index_name == "indexcortex" and context_id:
        if 'filter' in payload:
            payload['filter'] += f" and owner eq '{context_id}'"
        else:
            payload['filter'] = f"owner eq '{context_id}'"

    print(f"DEBUG: Search URL: {search_url}") # Added debug print
    print(f"DEBUG: Payload: {json.dumps(payload, indent=2)}") # Added debug print

    try:
        response = requests.post(search_url, headers=headers, json=payload)
        response.raise_for_status() # Raise an exception for HTTP errors
        return {"index_name": index_name, "results": response.json()}
    except requests.exceptions.RequestException as e:
        return {"index_name": index_name, "error": f"Error performing Cognitive Search: {str(e)}"}
    except Exception as e:
        return {"index_name": index_name, "error": f"Unexpected error in Cognitive Search: {str(e)}"}


async def azure_cognitive_search(
    queries: List[Dict[str, Any]]
) -> str:
    """
    Perform one or more searches on Azure Cognitive Search indexes in parallel.

    Args:
        queries: A list of dictionaries, where each dictionary represents a single search query
                 with the following potential keys: `query` (str), `index_name` (str),
                 `date_filter` (str, optional), `top` (int, optional), `select` (str, optional),
                 `facets` (List[str], optional), `requires_bi` (bool, optional),
                 `context_id` (str, optional).

    Returns:
        JSON string with a list of results, each corresponding to an input query.
    """
    tasks = []
    for q_params in queries:
        tasks.append(_perform_single_cognitive_search(**q_params))
    
    results = await asyncio.gather(*tasks)
    return json.dumps(results, indent=2) 