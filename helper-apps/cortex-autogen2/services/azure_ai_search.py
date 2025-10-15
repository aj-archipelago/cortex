import os
import logging
from typing import Any, Dict, List, Optional

import requests


logger = logging.getLogger(__name__)


API_VERSION = os.getenv("AZURE_COGNITIVE_API_VERSION", "2023-11-01")


def _get_base_url() -> Optional[str]:
    url = os.getenv("AZURE_COGNITIVE_API_URL")
    if not url:
        return None
    # normalize: strip trailing slashes
    return url.rstrip("/")


def _get_index_name() -> str:
    return os.getenv("AZURE_COGNITIVE_INDEX_WRITE", "index-autogen2")


def _get_headers() -> Optional[Dict[str, str]]:
    api_key = os.getenv("AZURE_COGNITIVE_API_KEY_WRITE")
    if not api_key:
        return None
    return {
        "Content-Type": "application/json",
        "api-key": api_key,
    }


def upsert_run_rest(doc: Dict[str, Any]) -> bool:
    """
    Best-effort upsert of a single run document into Azure Cognitive Search via REST.

    Expects index with fields: id (key), date (DateTimeOffset), task (String), content (String), owner (String), requestId (String)
    """
    try:
        base = _get_base_url()
        headers = _get_headers()
        index_name = _get_index_name()
        if not base or not headers:
            logger.debug("[Search] Missing base URL or API key; skipping upsert.")
            return False

        url = f"{base}/indexes/{index_name}/docs/index"
        params = {"api-version": API_VERSION}
        # Ensure @search.action on the document
        payload = {
            "value": [
                {"@search.action": "mergeOrUpload", **doc}
            ]
        }
        resp = requests.post(url, headers=headers, params=params, json=payload, timeout=20)
        try:
            resp.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"[Search] Upsert failed: {e} - status={resp.status_code} text={resp.text[:500]}")
            return False
    except Exception as e:
        logger.warning(f"[Search] Upsert error: {e}")
        return False


def search_similar_rest(query_text: str, top: int = 3) -> List[Dict[str, Any]]:
    """
    Full-text search for similar tasks using task/content fields.
    Returns a list of raw result documents (selected fields only).
    """
    try:
        base = _get_base_url()
        headers = _get_headers()
        index_name = _get_index_name()
        if not base or not headers:
            logger.debug("[Search] Missing base URL or API key; skipping search.")
            return []

        url = f"{base}/indexes/{index_name}/docs/search"
        params = {"api-version": API_VERSION}
        body = {
            "search": query_text or "",
            "top": int(top or 3),
            "searchFields": "task,content",
            "select": "id,task,content,date,requestId,owner",
        }
        resp = requests.post(url, headers=headers, params=params, json=body, timeout=20)
        try:
            resp.raise_for_status()
            data = resp.json() or {}
            # Azure returns { "value": [ {"@search.score": ..., ...fields } ] }
            vals = data.get("value") or []
            # Extract documents only
            docs: List[Dict[str, Any]] = []
            for v in vals:
                try:
                    # Remove score and return selected fields
                    v = dict(v)
                    v.pop("@search.score", None)
                    docs.append(v)
                except Exception:
                    continue
            return docs
        except Exception as e:
            logger.debug(f"[Search] Search failed: {e} - status={resp.status_code} text={resp.text[:500]}")
            return []
    except Exception as e:
        logger.debug(f"[Search] Search error: {e}")
        return []


