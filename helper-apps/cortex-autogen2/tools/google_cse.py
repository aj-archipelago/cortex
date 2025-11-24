"""
Google Custom Search (CSE) tool.

Provides `google_cse_search` async function that agents can call as a FunctionTool.
It reads API credentials from environment variables:
  - GOOGLE_CSE_KEY
  - GOOGLE_CSE_CX

Parameters mirror the CSE REST API where practical. Returns a JSON string.
"""

import os
import json
import requests
from typing import Any, Dict, Optional


def _get_env_or_error() -> Dict[str, str]:
    api_key = os.getenv("GOOGLE_CSE_KEY")
    cx_env = os.getenv("GOOGLE_CSE_CX")
    if not api_key:
        raise RuntimeError("GOOGLE_CSE_KEY is not set in the environment variables!")
    if not cx_env:
        raise RuntimeError("GOOGLE_CSE_CX is not set in the environment variables!")
    return {"key": api_key, "cx": cx_env}


def _build_params(text: Optional[str], parameters: Optional[Dict[str, Any]], env_cx: str) -> Dict[str, Any]:
    parameters = parameters or {}
    # Required
    q = (parameters.get("q") or text or "").strip()
    if not q:
        raise ValueError("Query text is required (provide 'text' parameter or 'parameters.q')")
    cx = parameters.get("cx") or env_cx

    params: Dict[str, Any] = {
        "q": q,
        "cx": cx,
    }

    # Optional passthroughs
    if "num" in parameters and parameters["num"] is not None:
        params["num"] = parameters["num"]
    if "start" in parameters and parameters["start"] is not None:
        params["start"] = parameters["start"]
    if parameters.get("safe"):
        params["safe"] = parameters["safe"]
    if parameters.get("dateRestrict"):
        params["dateRestrict"] = parameters["dateRestrict"]
    if parameters.get("siteSearch"):
        params["siteSearch"] = parameters["siteSearch"]
    if parameters.get("siteSearchFilter"):
        params["siteSearchFilter"] = parameters["siteSearchFilter"]
    if parameters.get("searchType"):
        params["searchType"] = parameters["searchType"]
    # Image-specific filters
    if parameters.get("imgSize"):
        params["imgSize"] = parameters["imgSize"]
    if parameters.get("imgType"):
        params["imgType"] = parameters["imgType"]
    if parameters.get("imgColorType"):
        params["imgColorType"] = parameters["imgColorType"]
    if parameters.get("imgDominantColor"):
        params["imgDominantColor"] = parameters["imgDominantColor"]
    if parameters.get("imgAspectRatio"):
        params["imgAspectRatio"] = parameters["imgAspectRatio"]
    if parameters.get("rights"):
        params["rights"] = parameters["rights"]
    if parameters.get("gl"):
        params["gl"] = parameters["gl"]
    if parameters.get("hl"):
        params["hl"] = parameters["hl"]
    if parameters.get("lr"):
        params["lr"] = parameters["lr"]
    if parameters.get("sort"):
        params["sort"] = parameters["sort"]
    if parameters.get("exactTerms"):
        params["exactTerms"] = parameters["exactTerms"]
    if parameters.get("excludeTerms"):
        params["excludeTerms"] = parameters["excludeTerms"]
    if parameters.get("orTerms"):
        params["orTerms"] = parameters["orTerms"]
    if parameters.get("fileType"):
        params["fileType"] = parameters["fileType"]

    return params


async def google_cse_search(
    text: Optional[str] = None,
    parameters: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Perform a Google Custom Search.

    Args:
        text: query text (used if `parameters.q` not provided)
        parameters: optional extra parameters per CSE API (e.g., num, start, safe, dateRestrict, etc.)

    Returns:
        JSON string of the raw CSE API response.
    """
    try:
        creds = _get_env_or_error()
        api_key = creds["key"]
        cx = creds["cx"]

        params = _build_params(text, parameters, cx)
        params["key"] = api_key

        url = "https://www.googleapis.com/customsearch/v1"
        resp = requests.get(url, params=params, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        return json.dumps(data)
    except Exception as exc:
        return json.dumps({"error": f"google_cse_search failed: {str(exc)}"})




# Export FunctionTool-wrapped version
from autogen_core.tools import FunctionTool
google_cse_search_tool = FunctionTool(
    google_cse_search,
    description="Google Custom Search. Returns raw JSON from CSE API."
)
