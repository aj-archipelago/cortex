"""
Message processing utilities for task processing.
"""
import json
import logging
from typing import Any, List

logger = logging.getLogger(__name__)


def _stringify_content(content: Any) -> str:
    """Convert various content types to a plain string for OpenAI API compatibility."""
    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                # Normal typed text part - extract text value only
                parts.append(str(item.get("text", "")))
            elif isinstance(item, dict) and "request_id" in item and "message_id" in item:
                # Nested message structure from queue (assistant) - extract ONLY content as plain text, NEVER JSON-dump it
                nested_content = item.get("content", "")
                if nested_content:
                    # Recursively stringify the nested content in case it's complex
                    parts.append(_stringify_content(nested_content))
                logger.debug(f"🧽 Extracted nested content from queue message: {nested_content}")
            elif isinstance(item, dict) and "message" in item:
                # Nested message structure from incoming user message - extract ONLY message field as plain text
                message_content = item.get("message", "")
                if message_content:
                    parts.append(_stringify_content(message_content))
                logger.debug(f"🧽 Extracted message content from user message: {message_content}")
            elif isinstance(item, dict):
                # Check if this is a structured tool result without "type" field (needs to be wrapped)
                if "type" not in item:
                    # This is likely a tool result or structured data that needs proper typing for OpenAI API
                    # Convert the dict to JSON string and wrap as a proper content part
                    try:
                        json_str = json.dumps(item, ensure_ascii=False)
                        # Create properly typed content: {"type": "text", "text": "json_string"}
                        typed_item = {"type": "text", "text": json_str}
                        parts.append(json.dumps(typed_item))
                    except Exception as e:
                        logger.warning(f"Failed to JSON encode dict item: {e}, falling back to string")
                        parts.append(str(item))
                else:
                    # Dict already has type field, keep as-is but stringify
                    try:
                        parts.append(json.dumps(item, ensure_ascii=False))
                    except Exception:
                        parts.append(str(item))
            else:
                parts.append(str(item))
        return "\n".join(parts)

    if isinstance(content, dict):
        # If it's a nested message dict (queue format), extract content not JSON
        if "request_id" in content and "message_id" in content and "content" in content:
            return _stringify_content(content.get("content", ""))
        # If it's a nested message dict (user message format), extract message not JSON
        if "message" in content:
            return _stringify_content(content.get("message", ""))
        # Otherwise JSON-dump it
        try:
            return json.dumps(content, ensure_ascii=False)
        except Exception:
            return str(content)

    return str(content)

