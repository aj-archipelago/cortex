"""
Labeeb GraphQL tool (sys_entity_agent) — minimal, question-first.
Uses CORTEX_API_BASE_URL (converts /v1 -> /graphql) and CORTEX_API_KEY as subscription key (query param).
Exposed param: query (text). Automatically wraps into a user message to avoid backend errors.
"""
import os
import json
import logging
from typing import Any, Dict, List, Optional
import requests
from autogen_core.tools import FunctionTool

logger = logging.getLogger(__name__)


def _graphql_url() -> str:
    base = os.getenv("CORTEX_API_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("CORTEX_API_BASE_URL is not set")
    if base.endswith("/v1"):
        base = base[:-3]
    return f"{base}/graphql"


def _subscription_key() -> str:
    key = os.getenv("CORTEX_API_KEY", "")
    if not key:
        raise RuntimeError("CORTEX_API_KEY is not set")
    return key


def _build_query() -> str:
    return """
    query SysEntityAgent(
      $messages: [Message]
      $text: String
      $stream: Boolean
      $async: Boolean
    ) {
      sys_entity_agent(
        messages: $messages
        text: $text
        stream: $stream
        async: $async
      ) {
        debug
        result
        resultData
        previousResult
        warnings
        errors
        contextId
        tool
      }
    }
    """


async def labeeb_sys_entity_start(query: str) -> str:
    """
    Call Labeeb GraphQL sys_entity_agent with a single user query.
    Internally wraps the query into a Message {role: user, content: query}.
    """
    url = _graphql_url()
    skey = _subscription_key()
    url = f"{url}?subscription-key={skey}"

    msgs = [{"role": "user", "content": query}]

    variables: Dict[str, Any] = {}
    if msgs:
        variables["messages"] = msgs
    variables["text"] = query
    variables["stream"] = False
    variables["async"] = False

    payload = {"query": _build_query(), "variables": variables}
    try:
        resp = requests.post(
            url,
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
    except Exception as e:
        logger.error(f"labeeb sys_entity_start request failed: {e}")
        return json.dumps({"error": f"request_failed: {e}"})

    try:
        data = resp.json()
    except Exception as e:
        logger.error(f"Failed to parse GraphQL response: {e}, text={resp.text[:400]}")
        return json.dumps({"error": f"parse_failed: {e}", "status": resp.status_code, "text": resp.text})

    if resp.status_code != 200:
        return json.dumps({"error": f"status_{resp.status_code}", "response": data})

    return json.dumps(data, indent=2)


labeeb_agent_tool = FunctionTool(
    labeeb_sys_entity_start,
    description=(
        "Ask Labeeb (sys_entity_agent) anything with a single text query. "
        "Returns result, resultData, warnings, errors, contextId, tool, debug."
    ),
)
