"""
Azure Cognitive Search tool.

Provides `azure_cognitive_search` async function that agents can call as a FunctionTool.
It reads API credentials from environment variables:
  - AZURE_COGNITIVE_API_KEY
  - AZURE_COGNITIVE_API_URL
  - AZURE_COGNITIVE_INDEXES (comma-separated list of default indexes)
"""

import os
import json
import asyncio
import requests
import concurrent.futures
from typing import List, Dict, Any, Optional

def _execute_search_sync(api_key, endpoint, index_name, query_text, payload):
    """Synchronous search execution using requests."""
    headers = {
        "Content-Type": "application/json",
        "api-key": api_key
    }
    
    # Construct URL
    base_url = endpoint.rstrip("/")
    url = f"{base_url}/indexes/{index_name}/docs/search?api-version=2021-04-30-Preview"
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        
        if response.status_code != 200:
            return {
                "index": index_name,
                "query": query_text,
                "error": f"Status {response.status_code}: {response.text}"
            }
        
        data = response.json()
        raw_results = data.get("value", [])
        normalized_results = []
        
        for doc in raw_results:
            # Normalize fields
            title = doc.get("title") or doc.get("headline") or "No Title"
            content = doc.get("content") or doc.get("body") or ""
            
            # URL/Path handling
            url = doc.get("url")
            if not url and "path" in doc:
                url = doc["path"]
            
            # Date handling
            date = doc.get("date") or doc.get("publishedDate") or doc.get("createdAt") or doc.get("lastModified")
            
            normalized_doc = {
                "title": title,
                "content": content[:500] + "..." if len(content) > 500 else content, # Truncate for token efficiency
                "url": url,
                "date": date,
                "score": doc.get("@search.score"),
                "source_index": index_name,
                "id": doc.get("id")
            }
            normalized_results.append(normalized_doc)

        return {
            "index": index_name,
            "query": query_text,
            "count": data.get("@odata.count"),
            "results": normalized_results
        }
            
    except Exception as e:
        return {
            "index": index_name,
            "query": query_text,
            "error": str(e)
        }

async def azure_cognitive_search(queries: List[Dict[str, Any]]) -> str:
    """
    Perform one or more searches on Azure Cognitive Search indexes in parallel.
    
    Args:
        queries: List of query dictionaries. Each dictionary should contain:
            - query (str): The search text.
            - index (str, optional): Specific index to search. If omitted, searches all configured indexes.
            - top (int, optional): Number of results to return (default 5).
            - select (str, optional): Comma-separated list of fields to retrieve.
            - filter (str, optional): OData filter expression.
            
    Returns:
        JSON string containing search results for all queries.
    """
    api_key = os.getenv("AZURE_COGNITIVE_API_KEY")
    endpoint = os.getenv("AZURE_COGNITIVE_API_URL")
    default_indexes_str = os.getenv("AZURE_COGNITIVE_INDEXES", "")
    
    if not api_key or not endpoint:
        return json.dumps({"error": "AZURE_COGNITIVE_API_KEY or AZURE_COGNITIVE_API_URL not set."})
    
    default_indexes = [idx.strip() for idx in default_indexes_str.split(",") if idx.strip()]
    
    if not default_indexes:
        return json.dumps({"error": "AZURE_COGNITIVE_INDEXES not set."})

    # Prepare search tasks
    search_tasks = []
    
    for q_obj in queries:
        query_text = q_obj.get("query")
        if not query_text:
            continue
            
        target_indexes = [q_obj.get("index")] if q_obj.get("index") else default_indexes
        
        for index_name in target_indexes:
            payload = {
                "search": query_text,
                "top": q_obj.get("top", 5),
                "count": True
            }
            
            if q_obj.get("select"):
                payload["select"] = q_obj.get("select")
            if q_obj.get("filter"):
                payload["filter"] = q_obj.get("filter")
                
            search_tasks.append((api_key, endpoint, index_name, query_text, payload))
    
    if not search_tasks:
        return json.dumps({"error": "No valid queries provided."})
        
    # Execute in parallel using ThreadPoolExecutor
    loop = asyncio.get_running_loop()
    
    # We use a ThreadPoolExecutor to run the synchronous requests in parallel
    # This avoids blocking the async event loop
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(search_tasks) + 2) as executor:
        futures = [
            loop.run_in_executor(
                executor, 
                _execute_search_sync, 
                api_key, endpoint, index_name, query_text, payload
            )
            for api_key, endpoint, index_name, query_text, payload in search_tasks
        ]
        results = await asyncio.gather(*futures)
            
    return json.dumps(results)


# Export FunctionTool-wrapped version
from autogen_core.tools import FunctionTool
azure_cognitive_search_tool = FunctionTool(
    azure_cognitive_search,
    description="Perform one or more searches on Azure Cognitive Search indexes in parallel."
)




