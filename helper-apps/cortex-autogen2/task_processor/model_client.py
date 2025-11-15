"""
Model client wrapper for ensuring OpenAI API compatibility.
"""
import json
import logging
from typing import Any, Dict, List
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import UserMessage, AssistantMessage

logger = logging.getLogger(__name__)


class RoleFixingModelClientWrapper:
    """
    Wrapper that intercepts create() calls to fix message roles and ensure content compatibility.

    This wrapper addresses OpenAI API issues where:
    1. Messages may have incorrect roles (e.g., 'system' when it should be 'user')
    2. Content may be in complex nested structures that OpenAI rejects
    3. Content may not be properly stringified for the API
    """

    def __init__(self, client: OpenAIChatCompletionClient):
        self.client = client

    def _coerce_message_object(self, message: Any) -> Any:
        """Convert raw message objects to proper AutoGen message types with content normalization."""
        from autogen_core.models import SystemMessage, UserMessage, AssistantMessage
        from autogen_agentchat.messages import TextMessage
        from .message_utils import _stringify_content

        if isinstance(message, (SystemMessage, UserMessage, AssistantMessage)):
            # Already proper message type - just ensure content is stringified
            if hasattr(message, 'content'):
                message.content = _stringify_content(message.content)
            return message

        if isinstance(message, TextMessage):
            # Convert TextMessage to appropriate AutoGen message
            content = _stringify_content(message.content) if hasattr(message, 'content') else ""
            source = getattr(message, 'source', None)

            if source == "system":
                return SystemMessage(content=content)
            elif source == "user":
                return UserMessage(content=content)
            else:
                return AssistantMessage(content=content)

        if isinstance(message, dict):
            # Handle dict messages
            content = message.get('content', '')
            role = message.get('role', 'user')
            source = message.get('source', role)

            content = _stringify_content(content)

            if role == "system" or source == "system":
                return SystemMessage(content=content)
            elif role == "user" or source == "user":
                return UserMessage(content=content)
            else:
                return AssistantMessage(content=content)

        # Fallback: convert to string and assume user message
        content = _stringify_content(message)
        return UserMessage(content=content)

    async def create(self, messages: List[Any], **kwargs) -> Any:
        """
        Intercept create calls to fix message roles and content before sending to OpenAI.

        Args:
            messages: List of message objects (may be raw dicts, TextMessage, etc.)
            **kwargs: Other arguments to pass to the underlying client

        Returns:
            The response from the underlying OpenAI client
        """
        # Fix each message to ensure proper format
        fixed_messages = []
        first_user_seen = False

        for i, msg in enumerate(messages):
            try:
                fixed_msg = self._coerce_message_object(msg)
                fixed_messages.append(fixed_msg)

                # Track if we've seen a user message (for role assignment)
                if isinstance(fixed_msg, UserMessage):
                    first_user_seen = True
            except Exception as e:
                logger.error(f"❌ Failed to coerce message {i}: {type(msg)} - {e}")
                logger.error(f"Message content: {str(msg)[:500]}...")
                # Try to create a basic message as fallback
                content = str(msg)[:1000]  # Limit size
                if first_user_seen:
                    fixed_messages.append(AssistantMessage(content=content, source="unknown"))
                else:
                    first_user_seen = True
                    fixed_messages.append(UserMessage(content=content, source="unknown"))

        logger.debug(f"🤖 Fixed {len(fixed_messages)} messages for OpenAI API")

        # Call the underlying client
        return await self.client.create(fixed_messages, **kwargs)

    # Delegate all other attributes/methods to the underlying client
    def __getattr__(self, name):
        return getattr(self.client, name)
