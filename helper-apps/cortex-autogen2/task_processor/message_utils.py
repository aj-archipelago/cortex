"""
Message processing utilities and helpers for task processing.
"""
import json
import logging
from typing import Optional, Dict, Any, Tuple, List

logger = logging.getLogger(__name__)


def _message_to_dict(msg: Any) -> Optional[Dict[str, Any]]:
    """Best-effort conversion of chat message objects to a plain dict."""
    if isinstance(msg, dict):
        return dict(msg)
    try:
        if hasattr(msg, '__dict__'):
            return dict(msg.__dict__)
        elif hasattr(msg, 'model_dump'):
            return msg.model_dump()
        elif hasattr(msg, 'dict'):
            return msg.dict()
    except Exception:
        pass
    return None


def _stringify_content(content: Any) -> str:
    """Convert various content types to a plain string for OpenAI API compatibility."""
    import json
    import logging
    logger = logging.getLogger(__name__)

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


def _coerce_message_object(message: Any, first_user_seen: bool) -> Tuple[Any, bool]:
    """Convert raw message objects to proper AutoGen message types with content normalization."""
    from autogen_core.models import SystemMessage, UserMessage, AssistantMessage
    from autogen_agentchat.messages import TextMessage

    if isinstance(message, (SystemMessage, UserMessage, AssistantMessage)):
        # Already proper message type - just ensure content is stringified
        if hasattr(message, 'content'):
            message.content = _stringify_content(message.content)
        return message, first_user_seen

    if isinstance(message, TextMessage):
        # Convert TextMessage to appropriate AutoGen message
        content = _stringify_content(message.content) if hasattr(message, 'content') else ""
        source = getattr(message, 'source', None)

        if source == "system":
            return SystemMessage(content=content), first_user_seen
        elif source == "user" or not first_user_seen:
            first_user_seen = True
            return UserMessage(content=content), first_user_seen
        else:
            return AssistantMessage(content=content), first_user_seen

    if isinstance(message, dict):
        # Handle dict messages
        content = message.get('content', '')
        role = message.get('role', 'user')
        source = message.get('source', role)

        content = _stringify_content(content)

        if role == "system" or source == "system":
            return SystemMessage(content=content), first_user_seen
        elif role == "user" or source == "user" or not first_user_seen:
            first_user_seen = True
            return UserMessage(content=content), first_user_seen
        else:
            return AssistantMessage(content=content), first_user_seen

    # Fallback: convert to string and assume user message
    content = _stringify_content(message)
    if not first_user_seen:
        first_user_seen = True
        return UserMessage(content=content), first_user_seen
    else:
        return AssistantMessage(content=content), first_user_seen


def _wrap_json_if_needed(text: str) -> str:
    """Wrap text in JSON structure if it looks like it should be JSON."""
    text = text.strip()
    if not text:
        return text

    # If it already looks like JSON, return as-is
    if (text.startswith('{') and text.endswith('}')) or \
       (text.startswith('[') and text.endswith(']')):
        try:
            json.loads(text)
            return text
        except json.JSONDecodeError:
            pass

    # If it looks like tool calls, wrap in assistant message format
    if '"tool_calls"' in text or '"function_call"' in text:
        return json.dumps({
            "role": "assistant",
            "content": None,
            "tool_calls": []  # Will be populated by actual parsing
        })

    return text


def _normalize_single_message(raw_message: Any, first_user_seen: bool) -> Tuple[Any, bool]:
    """Normalize a single message to proper AutoGen format."""
    from autogen_core.models import SystemMessage, UserMessage, AssistantMessage

    if isinstance(raw_message, (SystemMessage, UserMessage, AssistantMessage)):
        # Already proper format
        return raw_message, first_user_seen

    if isinstance(raw_message, dict):
        content = raw_message.get('content', '')
        role = raw_message.get('role', 'user')
        source = raw_message.get('source', role)

        # Handle nested content structures
        if isinstance(content, dict):
            if "message" in content:
                # User message format
                content = content.get("message", "")
            elif "request_id" in content and "content" in content:
                # Queue message format
                content = content.get("content", "")

        content = _stringify_content(content)

        if role == "system" or source == "system":
            return SystemMessage(content=content), first_user_seen
        elif role == "user" or source == "user":
            first_user_seen = True
            return UserMessage(content=content), first_user_seen
        else:
            return AssistantMessage(content=content), first_user_seen

    # Handle TextMessage objects - extract content and source
    if hasattr(raw_message, 'content') and hasattr(raw_message, 'source'):
        content = _stringify_content(raw_message.content)
        source = raw_message.source

        if source == "system":
            return SystemMessage(content=content), first_user_seen
        elif source == "user":
            first_user_seen = True
            return UserMessage(content=content), first_user_seen
        else:
            return AssistantMessage(content=content), first_user_seen

    # Handle SystemMessage objects
    if hasattr(raw_message, 'content') and hasattr(raw_message, '__class__'):
        class_name = raw_message.__class__.__name__
        content = _stringify_content(raw_message.content)

        if "System" in class_name:
            return SystemMessage(content=content), first_user_seen
        elif "User" in class_name:
            first_user_seen = True
            return UserMessage(content=content), first_user_seen
        else:
            return AssistantMessage(content=content), first_user_seen

    # Handle autogen_core message types directly but ensure plain-text content
    if hasattr(raw_message, 'content') and hasattr(raw_message, 'type'):
        content = _stringify_content(raw_message.content)

        if hasattr(raw_message, 'role'):
            role = raw_message.role
            if role == "system":
                return SystemMessage(content=content), first_user_seen
            elif role == "user":
                first_user_seen = True
                return UserMessage(content=content), first_user_seen
            else:
                return AssistantMessage(content=content), first_user_seen

    # Fallback: treat any other payload as assistant text
    content = _stringify_content(raw_message)
    return AssistantMessage(content=content), first_user_seen

