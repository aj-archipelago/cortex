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
    4. Progress message loops - same progress percentage repeating 15+ times (stuck at same progress level)
    5. Two agents ping-ponging back and forth 10+ times (regardless of content)
    
    Returns True if loop detected, False otherwise.
    """
    if len(messages) < 10:
        return False
    
    # Check last 30 messages for patterns
    recent = messages[-30:] if len(messages) >= 30 else messages
    
    # Pattern 1: Same agent + same/empty content repeating
    agent_content_pairs = []
    timeout_count = 0
    progress_values = []
    # Pattern 6: Stuck at same progress percentage for extended period (15+ messages at same %)
    progress_stuck_count = 0
    last_progress = None

    for msg in recent:
        if hasattr(msg, 'source') and hasattr(msg, 'content'):
            source = msg.source
            content = str(msg.content).strip()
            agent_content_pairs.append((source, content))
            
            # Pattern 3: Detect LLM timeout messages
            if "Request timed out after" in content or "timed out after" in content.lower():
                timeout_count += 1

            # Extract progress values for Pattern 4
            import re
            progress_match = re.search(r'Progress:\s*(\d+)%', content)
            if progress_match:
                progress_values.append(int(progress_match.group(1)))
    
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

    # Pattern 4: Progress message loops - stuck at same progress level
    if len(progress_values) >= 10:
        # Check if the last 10 progress values are all the same (stuck at same percentage)
        # Reduced threshold from 15 to 10 to catch stuck tasks earlier
        last_10_progress = progress_values[-10:]
        if all(p == last_10_progress[0] for p in last_10_progress):
            logger.warning(f"🛑 Loop Pattern 4 detected: Stuck at {last_10_progress[0]}% progress for 10+ consecutive messages")
            return True

    # Pattern 5: Two agents ping-ponging back and forth 10+ times (regardless of content)
    if len(agent_content_pairs) >= 20:
        agents_only = [pair[0] for pair in agent_content_pairs[-20:]]
        unique_agents = set(agents_only)
        if len(unique_agents) == 2:
            # Check if they're strictly alternating
            alternations = sum(1 for i in range(1, len(agents_only)) if agents_only[i] != agents_only[i-1])
            if alternations >= 18:  # Almost all messages are alternating between just 2 agents
                agent_list = list(unique_agents)
                logger.warning(f"🛑 Loop Pattern 5 detected: {agent_list[0]} ↔ {agent_list[1]} ping-ponging {alternations} times")
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
            # Try parsing as JSON first using centralized utility
            from util.json_extractor import extract_json_from_llm_response
            
            parsed = extract_json_from_llm_response(content, expected_type=dict, log_errors=False)
            if parsed and isinstance(parsed, dict) and 'score' in parsed:
                return int(parsed['score'])
            
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
            
            # Fallback: try direct JSON parse (shouldn't be needed with utility, but keep for safety)
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
        
        # CRITICAL: Update all_messages from messages (autogen passes full history)
        all_messages.clear()
        all_messages.extend(messages)

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

        # Find the most recent verifier message (presenter may have spoken after it)
        last_verifier = None
        for msg in reversed(all_messages):
            if hasattr(msg, 'source') and msg.source == 'execution_completion_verifier_agent' and getattr(msg, 'content', None):
                last_verifier = msg
                break

        if not last_verifier:
            return False

        content = str(last_verifier.content)

        # Now check the verifier's score first
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

        # Optional explicit completion marker from verifier (score >= 90)
        try:
            if "___USERS_TASK_COMPLETE_FULLY_WITH_A_SCORE_OVER_90___" in content:
                logger.info("✅ Verifier completion_marker detected. Terminating workflow.")
                return True
        except Exception as e:
            logger.debug(f"Error checking completion marker: {e}")
        
        return False
    
    return FunctionalTermination(check_termination)

