"""
Loop Detection Termination Condition

Termination condition that detects infinite loops during execution phase.
"""
import logging
from autogen_agentchat.conditions import FunctionalTermination

logger = logging.getLogger(__name__)


def create_loop_detection_termination(all_messages, max_repetitions: int = 3):
    """
    Create a termination condition that detects loops during execution.
    
    Args:
        all_messages: List to track all messages (will be updated by reference)
        max_repetitions: Maximum number of repetitions before considering it a loop (default: 3)
    
    Returns:
        FunctionalTermination condition that checks for loops
    """
    
    def check_termination(messages):
        """Check if we should terminate based on loop detection."""
        if not messages:
            return False
        
        if len(messages) < max_repetitions * 2:
            return False
        
        # Update all_messages for external tracking
        all_messages.clear()
        all_messages.extend(messages)
        
        # Check last 30 messages for loop patterns
        check_window = min(30, len(messages))
        recent_messages = messages[-check_window:]
        
        # Pattern 1: Same agent + same/similar content
        agent_content_map = {}
        for msg in recent_messages:
            if hasattr(msg, 'source') and hasattr(msg, 'content'):
                agent = msg.source
                content = str(getattr(msg, 'content', ''))
                # Normalize content (remove whitespace, take first 100 chars for comparison)
                content_key = content.strip()[:100] if content else ""
                
                key = (agent, content_key)
                agent_content_map[key] = agent_content_map.get(key, 0) + 1
                
                if agent_content_map[key] >= max_repetitions:
                    logger.warning(f"🛑 LOOP DETECTED: {agent} repeated same content {agent_content_map[key]} times")
                    return True
        
        # Pattern 2: Two agents ping-ponging (alternating)
        if len(recent_messages) >= max_repetitions * 2:
            ping_pong_count = 0
            for i in range(len(recent_messages) - 1, max(0, len(recent_messages) - max_repetitions * 2), -1):
                if i < 1:
                    break
                msg1 = recent_messages[i]
                msg2 = recent_messages[i-1]
                
                if (hasattr(msg1, 'source') and hasattr(msg2, 'source') and
                    msg1.source != msg2.source):
                    content1 = str(getattr(msg1, 'content', ''))
                    content2 = str(getattr(msg2, 'content', ''))
                    # Check if both are empty or very similar
                    if (not content1.strip() and not content2.strip()) or content1.strip()[:50] == content2.strip()[:50]:
                        ping_pong_count += 1
                    else:
                        break  # Pattern broken
            
            if ping_pong_count >= max_repetitions:
                logger.warning(f"🛑 LOOP DETECTED: Ping-pong pattern detected ({ping_pong_count} cycles)")
                return True
        
        # Pattern 3: Same agent selected repeatedly without tool calls
        agent_selections = {}
        for msg in recent_messages:
            if hasattr(msg, 'source'):
                agent = msg.source
                # Check if message has tool calls
                has_tools = (hasattr(msg, 'tool_calls') and msg.tool_calls) or \
                           (hasattr(msg, 'tool_call_id') and msg.tool_call_id) or \
                           'ToolCall' in str(type(msg))
                
                if not has_tools:
                    key = agent
                    agent_selections[key] = agent_selections.get(key, 0) + 1
                    
                    if agent_selections[key] >= max_repetitions * 2:  # More lenient for this pattern
                        logger.warning(f"🛑 LOOP DETECTED: {agent} selected {agent_selections[key]} times without tool calls")
                        return True
                else:
                    # Reset count if agent made a tool call
                    agent_selections[agent] = 0
        
        # Pattern 4: Same error message repeated
        error_messages = {}
        for msg in recent_messages:
            if hasattr(msg, 'content'):
                content = str(getattr(msg, 'content', ''))
                # Look for error indicators
                if any(indicator in content for indicator in ['⛔', 'Cannot proceed', 'file missing', 'CSV missing', 'blocked']):
                    error_key = content.strip()[:150]  # First 150 chars
                    error_messages[error_key] = error_messages.get(error_key, 0) + 1
                    
                    if error_messages[error_key] >= max_repetitions:
                        logger.warning(f"🛑 LOOP DETECTED: Same error message repeated {error_messages[error_key]} times")
                        return True
        
        return False
    
    return FunctionalTermination(check_termination)



