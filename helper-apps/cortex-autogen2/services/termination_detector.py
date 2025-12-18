"""
Termination Detection Service

LLM-powered termination detection instead of static regex patterns.
"""

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)


async def should_terminate_early(
    message_source: str,
    message_type: str,
    content_str: str,
    model_client: Optional[object]
) -> tuple[bool, Optional[int]]:
    """
    LLM-powered early termination detection.
    
    Returns: (should_terminate, score_if_detected)
    """
    if message_source != 'execution_completion_verifier_agent' or message_type != 'TextMessage':
        return False, None
    
    if not content_str or not model_client:
        return False, None
    
    try:
        # Use LLM to detect completion markers and scores
        prompt = f"""Analyze this completion verifier message and determine if the task is complete.

Message:
{content_str[:1000]}

Check for:
1. Completion markers (e.g., "TASK_COMPLETE", "fully complete", etc.)
2. Success scores (numeric score indicating quality)
3. Completion signals

Return JSON:
{{
  "complete": true/false,
  "score": 95 (if mentioned, else null),
  "reason": "brief reason"
}}

If task is complete with score > 90, return complete: true.
"""
        
        from autogen_core.models import UserMessage
        response = await model_client.create([UserMessage(content=prompt, source="termination_detector")])
        
        # Extract JSON using centralized utility
        from util.json_extractor import extract_json_from_model_response
        
        result = extract_json_from_model_response(response, expected_type=dict, log_errors=True)
        if result and result.get("complete") and result.get("score", 0) > 90:
            return True, result.get("score")
    
    except Exception as e:
        logger.debug(f"LLM termination detection failed, using fallback: {e}")
    
    # Minimal fallback: only obvious markers
    if "___USERS_TASK_COMPLETE_FULLY_WITH_A_SCORE_OVER_90___" in content_str:
        return True, 90
    
    score_match = re.search(r'"score"\s*:\s*(-?\d+)', content_str)
    if not score_match:
        score_match = re.search(r'score\s*[:=]\s*(-?\d+)', content_str, re.IGNORECASE)
    if score_match:
        score_val = int(score_match.group(1))
        if score_val > 90:
            return True, score_val
    
    return False, None
