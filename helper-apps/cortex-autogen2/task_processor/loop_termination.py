"""
Loop Detection Termination Condition

Generic termination condition that detects infinite loops during execution phase.
Simple patterns: ping-pong between 2 agents, or excessive planner invocations.
"""
import logging
from autogen_agentchat.conditions import FunctionalTermination

logger = logging.getLogger(__name__)


def create_loop_detection_termination(all_messages, max_repetitions: int = 3):
    """
    Create a termination condition that detects loops during execution.
    
    Detects:
    1. Any two agents ping-ponging 20+ times
    2. Planner appearing 20+ times total
    """
    
    def check_termination(messages):
        """Check if we should terminate based on loop detection."""
        if not messages:
            return False
        
        if len(messages) < 20:
            return False
        
        # Update all_messages for external tracking
        all_messages.clear()
        all_messages.extend(messages)
        
        # Extract agent sequence (only TextMessages, not tool calls)
        agent_sequence = []
        for msg in messages:
            if hasattr(msg, 'source'):
                is_text = 'TextMessage' in str(type(msg)) or \
                         (hasattr(msg, 'content') and isinstance(getattr(msg, 'content', None), str) and 
                          'ToolCall' not in str(type(msg)))
                if is_text:
                    agent_sequence.append(msg.source)
        
        if len(agent_sequence) < 20:
            return False
        
        # === PATTERN 1: Any two agents ping-ponging 20+ times ===
        # Check last 50 messages for alternating pattern
        last_n = agent_sequence[-50:] if len(agent_sequence) >= 50 else agent_sequence
        unique_agents = set(last_n)
        if len(unique_agents) == 2:
            agents = list(unique_agents)
            alternations = sum(1 for i in range(1, len(last_n)) if last_n[i] != last_n[i-1])
            if alternations >= 20:
                logger.warning(f"🛑 LOOP DETECTED: Ping-pong {agents[0]} ↔ {agents[1]} ({alternations} alternations)")
                return True
        
        # === PATTERN 2: Planner appearing 20+ times total ===
        planner_count = sum(1 for a in agent_sequence if 'planner' in a.lower())
        if planner_count >= 10:
            logger.warning(f"🛑 LOOP DETECTED: Excessive replanning ({planner_count} planner invocations)")
            return True
        
        return False
    
    return FunctionalTermination(check_termination)




