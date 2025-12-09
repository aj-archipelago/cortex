"""
Score-Based Termination Condition

Termination condition that checks presentation quality scores from verifier agent.
Terminates workflow when score exceeds threshold (default 90).
"""

import logging
import json
import re
from typing import List
from autogen_agentchat.conditions import FunctionalTermination

logger = logging.getLogger(__name__)


def detect_loop_pattern(messages: List) -> bool:
    """
    Detect repetitive patterns indicating infinite loop.
    
    This is a programmatic safety net that detects loops before relying on the LLM verifier agent.
    Checks for:
    1. Same agent + same/empty content repeating 6+ times consecutively
    2. High percentage of alternating empty messages (>50% of last 10)
    3. LLM request timeout messages appearing 2+ times (indicates backend issues causing loops)
    
    Returns True if loop detected, False otherwise.
    """
    if len(messages) < 10:
        return False
    
    # Check last 30 messages for patterns
    recent = messages[-30:] if len(messages) >= 30 else messages
    
    # Pattern 1: Same agent + same/empty content repeating
    agent_content_pairs = []
    timeout_count = 0
    
    for msg in recent:
        if hasattr(msg, 'source') and hasattr(msg, 'content'):
            source = msg.source
            content = str(msg.content).strip()
            agent_content_pairs.append((source, content))
            
            # Pattern 3: Detect LLM timeout messages
            if "Request timed out after" in content or "timed out after" in content.lower():
                timeout_count += 1
    
    # If we see 2+ timeout messages in recent history, we're in a timeout loop
    if timeout_count >= 2:
        logger.warning(f"🛑 Loop Pattern 3 detected: {timeout_count} LLM timeout messages in recent history (backend issues causing loop)")
        return True
    
    # Count consecutive repetitions
    if len(agent_content_pairs) >= 6:
        last_6 = agent_content_pairs[-6:]
        # Check if all 6 are identical (same agent, same content)
        if all(pair == last_6[0] for pair in last_6):
            logger.warning(f"🛑 Loop Pattern 1 detected: {last_6[0][0]} repeating identical content 6+ times")
            return True
    
    # Pattern 2: Two agents alternating with empty/same content
    if len(agent_content_pairs) >= 10:
        alternating_empty_count = 0
        for i in range(len(agent_content_pairs) - 1):
            curr = agent_content_pairs[i]
            next_pair = agent_content_pairs[i + 1]
            # Check if content is empty or very short (< 10 chars)
            if len(curr[1]) < 10 or len(next_pair[1]) < 10:
                alternating_empty_count += 1
        
        # If >50% of recent messages are empty alternations
        if alternating_empty_count > len(agent_content_pairs) * 0.5:
            logger.warning(f"🛑 Loop Pattern 2 detected: {alternating_empty_count}/{len(agent_content_pairs)} messages are empty alternations (>50%)")
            return True
    
    return False



def create_score_based_termination(all_messages, threshold: int = 90):
    """
    Create a termination condition based on presentation quality score.
    Checks execution_completion_verifier_agent messages for presentation quality scores.
    Terminates if score > threshold (default 90).
    """
    
    def extract_score(content: str) -> int:
        """Extract score from verifier agent response (supports JSON format like LLM scorer, including -1 for loops)."""
        try:
            # Try parsing as JSON first (like LLM scorer format) - supports negative numbers
            json_match = re.search(r'\{.*?"score"\s*:\s*(-?\d+).*?\}', content, re.DOTALL)
            if json_match:
                score_str = json_match.group(1)
                return int(score_str)
            
            # Try to find score pattern: "score: 95" or "score=95" or "Score: 95/100" or "score: -1"
            score_patterns = [
                r'score["\s:]*(-?\d+)',
                r'Score["\s:]*(-?\d+)',
                r'score\s*=\s*(-?\d+)',
                r'Score\s*=\s*(-?\d+)',
                r'(-?\d+)/100',
            ]
            
            for pattern in score_patterns:
                match = re.search(pattern, content, re.IGNORECASE)
                if match:
                    return int(match.group(1))
            
            # Try parsing entire content as JSON
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict) and 'score' in parsed:
                    return int(parsed['score'])
            except:
                pass
                
        except Exception as e:
            logger.debug(f"Error extracting score: {e}")
        
        return None
    
    def check_termination(messages):
        """Check if we should terminate based on presentation quality score."""
        if not messages:
            return False

        if len(all_messages) < 2:
            return False

        # PROGRAMMATIC LOOP DETECTION - Auto-terminate on loops (safety net)
        # This catches loops even if verifier_agent doesn't return score=-1
        if detect_loop_pattern(all_messages):
            logger.warning(f"🛑 PROGRAMMATIC LOOP DETECTOR: Repetitive pattern detected. Auto-terminating to prevent infinite loop.")
            return True

        # CIRCUIT BREAKER: Detect empty message loops (minimal fix)
        # Check last 20 messages for presenter empty + verifier score 0 pattern (10+ times)
        if len(all_messages) >= 20:
            empty_loop_count = 0
            for i in range(len(all_messages) - 1, max(0, len(all_messages) - 20), -1):
                if i < 1:
                    break
                msg1 = all_messages[i]
                msg2 = all_messages[i-1] if i > 0 else None
                
                # Check for presenter empty + verifier score 0 pattern
                if (msg2 and hasattr(msg1, 'source') and msg1.source == 'execution_completion_verifier_agent' and
                    hasattr(msg2, 'source') and msg2.source == 'presenter_agent' and
                    hasattr(msg2, 'content')):
                    content2 = str(getattr(msg2, 'content', ''))
                    content1 = str(getattr(msg1, 'content', ''))
                    score = extract_score(content1)
                    if score == 0 and (not content2 or content2.strip() == ""):
                        empty_loop_count += 1
                    else:
                        break  # Pattern broken
            
            if empty_loop_count >= 10:
                logger.warning(f"🛑 CIRCUIT BREAKER: Empty message loop detected ({empty_loop_count} cycles). Terminating to prevent infinite loop.")
                return True

        # Check that the previous agent (before any verifier messages) is presenter_agent
        # Walk backwards from end, skip verifier messages, first non-verifier should be presenter TextMessage
        for msg in reversed(all_messages):
            if hasattr(msg, 'source') and msg.source == 'execution_completion_verifier_agent':
                continue  # Skip verifier messages
            # First non-verifier message found
            if (hasattr(msg, 'source') and msg.source == 'presenter_agent' and
                hasattr(msg, 'type') and msg.type == 'TextMessage'):
                break  # Found presenter TextMessage - valid sequence
            else:
                return False  # Previous agent was not presenter_agent

        # CRITICAL: Last message must be from execution_completion_verifier_agent
        last_message = messages[-1]
        if not hasattr(last_message, 'source') or last_message.source != 'execution_completion_verifier_agent':
            return False

        

        # Now check the verifier's score
        content = str(last_message.content)
        score = extract_score(content)
        
        if score is not None:
            logger.info(f"🔍 Presentation quality score: {score}/100 (threshold: {threshold})")
            if score == -1:
                logger.warning(f"⚠️ Loop detected - score -1 (incomplete task). Terminating gracefully to prevent infinite loop.")
                return True  # Allow termination with -1 score (loop detected)
            elif score > threshold:
                logger.info(f"✅ Presentation quality acceptable! Score {score} > {threshold}")
                return True
            else:
                logger.info(f"⚠️ Presentation score {score} <= {threshold}, may need improvement...")
                # Don't terminate - let workflow continue for replanning/improvement
                return False
        
        return False
    
    return FunctionalTermination(check_termination)

