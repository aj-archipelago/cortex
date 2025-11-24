"""
Utility functions for context generation.
"""
from typing import List, Dict
from .config import AGENT_ROLE_DESCRIPTIONS


def estimate_tokens(text: str) -> int:
    """
    Rough token estimation (4 chars ≈ 1 token).
    
    Args:
        text: Text to estimate tokens for
        
    Returns:
        Estimated token count
    """
    if not text:
        return 0
    # Rough estimation: 4 characters ≈ 1 token
    return len(text) // 4


def filter_relevant_events(agent_name: str, events: List[dict]) -> List[dict]:
    """
    Filter events relevant to specific agent's role.
    
    Args:
        agent_name: Name of the agent
        events: List of events to filter
        
    Returns:
        Filtered list of relevant events
    """
    if agent_name == "execution_completion_verifier_agent":
        # Needs all events for verification
        return events[-50:]  # Last 50 events
    
    relevant_types = []
    
    if agent_name == "coder_agent":
        relevant_types = ["file_creation", "tool_execution", "agent_action", "handoff"]
    elif agent_name == "aj_sql_agent":
        relevant_types = ["tool_execution", "file_creation", "handoff"]
    elif agent_name == "web_search_agent":
        relevant_types = ["tool_execution", "file_creation", "handoff"]
    elif agent_name == "planner_agent":
        relevant_types = ["agent_action", "decision", "handoff"]
    elif agent_name == "uploader_agent":
        relevant_types = ["file_creation"]  # Only needs file list
    else:
        # Default: include most event types
        relevant_types = ["file_creation", "tool_execution", "agent_action", "handoff", "accomplishment"]
    
    # Filter by event type and agent relevance
    filtered = []
    for event in events:
        event_type = event.get("event_type", "")
        event_agent = event.get("agent_name", "")
        
        # Include if event type is relevant
        if event_type in relevant_types:
            filtered.append(event)
        # Include handoffs involving this agent
        elif event_type == "handoff":
            details = event.get("details", {})
            if details.get("from_agent") == agent_name or details.get("to_agent") == agent_name:
                filtered.append(event)
    
    # Return last 30 events (sliding window)
    return filtered[-30:]

