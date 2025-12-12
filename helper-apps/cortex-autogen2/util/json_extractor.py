"""
LLM JSON Response Extractor

Centralized utility for extracting JSON from LLM responses.
Handles various formats: markdown code blocks, plain JSON, nested structures.

Used by all LLM-powered services for consistent JSON parsing.
"""

import json
import re
import logging
from typing import Any, Optional, Dict, List, Union

logger = logging.getLogger(__name__)


def extract_json_from_llm_response(
    response_text: str,
    expected_type: Optional[type] = None,
    log_errors: bool = True
) -> Optional[Union[Dict, List]]:
    """
    Extract JSON from LLM response text using multiple strategies.
    
    Handles:
    - Markdown code blocks (```json ... ```)
    - Plain JSON objects
    - JSON with surrounding text
    - Nested JSON structures
    - Malformed JSON with balanced braces
    
    Args:
        response_text: Raw text response from LLM
        expected_type: Expected type (dict or list). If None, auto-detects.
        log_errors: Whether to log extraction failures
        
    Returns:
        Parsed JSON object (dict or list) or None if extraction fails
    """
    if not response_text or not isinstance(response_text, str):
        if log_errors:
            logger.debug("extract_json_from_llm_response: Empty or invalid input")
        return None
    
    # Clean the response
    cleaned = response_text.strip()
    
    # Strategy 0: Try parsing entire cleaned response as JSON first (fastest, most common)
    # This handles the case where LLM returns clean JSON without markdown
    try:
        result = json.loads(cleaned)
        logger.debug("Parsed entire cleaned response as JSON")
        return _validate_type(result, expected_type)
    except json.JSONDecodeError:
        pass
    
    # Strategy 1: Extract from markdown code blocks (most common)
    # Extract everything between code block markers, then parse
    json_block_match = re.search(r'```(?:json)?\s*(.*?)\s*```', cleaned, re.DOTALL | re.MULTILINE)
    if json_block_match:
        json_str = json_block_match.group(1).strip()
        try:
            result = json.loads(json_str)
            logger.debug("Extracted JSON from markdown code block")
            return _validate_type(result, expected_type)
        except json.JSONDecodeError as e:
            if log_errors:
                logger.debug(f"Failed to parse JSON from code block: {e}")
    
    # Strategy 2: Try to extract by finding first { or [ and matching to end (handles nested structures)
    for start_char, end_char in [('{', '}'), ('[', ']')]:
        start_idx = cleaned.find(start_char)
        if start_idx >= 0:
            # Find matching closing brace/bracket
            depth = 0
            for i in range(start_idx, len(cleaned)):
                if cleaned[i] == start_char:
                    depth += 1
                elif cleaned[i] == end_char:
                    depth -= 1
                    if depth == 0:
                        try:
                            json_str = cleaned[start_idx:i+1]
                            result = json.loads(json_str)
                            logger.debug(f"Extracted JSON by matching {start_char}{end_char}")
                            return _validate_type(result, expected_type)
                        except json.JSONDecodeError:
                            break
            break
    
    # Strategy 3: Find JSON object/array with balanced braces/brackets (regex fallback)
    # Match complete JSON structures (handles nesting)
    # Try arrays first (they're less common but need explicit handling)
    json_patterns = [
        r'\[(?:[^\[\]]|(?:\[[^\[\]]*\])|(?:\{[^{}]*\}))*\]',  # Arrays with nested brackets and objects
        r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}',  # Objects with nested braces
    ]
    
    for pattern in json_patterns:
        json_match = re.search(pattern, cleaned, re.DOTALL)
        if json_match:
            try:
                result = json.loads(json_match.group(0))
                logger.debug(f"Extracted JSON using pattern: {pattern[:30]}...")
                return _validate_type(result, expected_type)
            except json.JSONDecodeError as e:
                if log_errors:
                    logger.debug(f"Failed to parse JSON from pattern match: {e}")
                continue
    
    # Strategy 4b: Try ast.literal_eval as fallback (handles Python dict syntax)
    try:
        import ast
        parsed = ast.literal_eval(cleaned)
        if isinstance(parsed, (dict, list)):
            logger.debug("Parsed using ast.literal_eval")
            return _validate_type(parsed, expected_type)
    except (ValueError, SyntaxError):
        pass
    
    # Strategy 5: Remove markdown formatting and try again
    markdown_cleaned = cleaned
    if markdown_cleaned.startswith('```json'):
        markdown_cleaned = markdown_cleaned[7:]
    elif markdown_cleaned.startswith('```'):
        markdown_cleaned = markdown_cleaned[3:]
    if markdown_cleaned.endswith('```'):
        markdown_cleaned = markdown_cleaned[:-3]
    markdown_cleaned = markdown_cleaned.strip()
    
    if markdown_cleaned != cleaned:
        try:
            result = json.loads(markdown_cleaned)
            logger.debug("Parsed markdown-cleaned response as JSON")
            return _validate_type(result, expected_type)
        except json.JSONDecodeError:
            pass
    
    # All strategies failed
    if log_errors:
        logger.warning(f"Failed to extract JSON from LLM response. Preview: {response_text[:200]}")
    return None


def extract_json_from_model_response(
    response: Any,
    expected_type: Optional[type] = None,
    log_errors: bool = True
) -> Optional[Union[Dict, List]]:
    """
    Extract JSON from model client response object.
    
    Handles different response formats from model clients:
    - response.content[0].text
    - response.content[0].content
    - response.content[0] (string)
    - response (string)
    
    Args:
        response: Model client response object
        expected_type: Expected type (dict or list). If None, auto-detects.
        log_errors: Whether to log extraction failures
        
    Returns:
        Parsed JSON object (dict or list) or None if extraction fails
    """
    # Extract text from response object - handle multiple response formats
    response_text = None
    
    if hasattr(response, 'content') and response.content:
        # Handle string content directly (most common case)
        if isinstance(response.content, str):
            response_text = response.content
        # Handle list of content items
        elif isinstance(response.content, list) and len(response.content) > 0:
            content_item = response.content[0]
            # Try multiple ways to extract text from content item
            if hasattr(content_item, 'text'):
                text_val = getattr(content_item, 'text', None)
                if text_val:
                    response_text = text_val if isinstance(text_val, str) else str(text_val)
            if not response_text and hasattr(content_item, 'content'):
                content_val = getattr(content_item, 'content', None)
                if content_val:
                    if isinstance(content_val, str):
                        response_text = content_val
                    else:
                        response_text = str(content_val)
            if not response_text and isinstance(content_item, str):
                response_text = content_item
            if not response_text:
                response_text = str(content_item)
        # Handle single content item (not list, not string)
        else:
            content_item = response.content
            if hasattr(content_item, 'text'):
                text_val = getattr(content_item, 'text', None)
                if text_val:
                    response_text = text_val if isinstance(text_val, str) else str(text_val)
            if not response_text and hasattr(content_item, 'content'):
                content_val = getattr(content_item, 'content', None)
                if content_val:
                    if isinstance(content_val, str):
                        response_text = content_val
                    else:
                        response_text = str(content_val)
            if not response_text and isinstance(content_item, str):
                response_text = content_item
            if not response_text:
                response_text = str(content_item)
    elif isinstance(response, str):
        response_text = response
    elif hasattr(response, 'text'):
        response_text = response.text
    else:
        response_text = str(response)
    
    if not response_text:
        if log_errors:
            logger.debug(f"extract_json_from_model_response: No text content found. Response type: {type(response)}")
        return None
    
    # Check if response is too short (likely incomplete/truncated)
    response_text = response_text.strip()
    if len(response_text) < 2:
        if log_errors:
            logger.warning(f"extract_json_from_model_response: Response too short ({len(response_text)} chars): {response_text[:100]}")
        return None
    
    return extract_json_from_llm_response(response_text, expected_type, log_errors)


def _validate_type(result: Any, expected_type: Optional[type]) -> Any:
    """Validate that result matches expected type."""
    if expected_type is None:
        return result
    
    if isinstance(result, expected_type):
        return result
    
    # Type mismatch - if expecting dict but got list (or vice versa), return None
    # This prevents downstream errors when code expects a specific type
    if expected_type == dict and isinstance(result, list):
        logger.debug(f"Type mismatch: expected dict, got list - returning None")
        return None
    if expected_type == list and isinstance(result, dict):
        logger.debug(f"Type mismatch: expected list, got dict - returning None")
        return None
    
    # For other mismatches, log but return result (caller can handle)
    logger.debug(f"Type mismatch: expected {expected_type.__name__}, got {type(result).__name__}")
    return result
