import os
import json
from typing import Any, Optional
import logging
from typing import List, Dict, Union

# =========================================================================
# Core utility helpers
# =========================================================================



def parse_llm_json_response(content: str) -> Union[dict, list]:
    """
    Parse JSON response from LLM, handling markdown code blocks.

    Args:
        content: Raw string response from LLM that may contain JSON

    Returns:
        Parsed JSON object (dict or list)

    Raises:
        json.JSONDecodeError: If content is not valid JSON after cleaning
        ValueError: If content cannot be processed
    """
    if not content or not isinstance(content, str):
        raise ValueError("Content must be a non-empty string")

    content = content.strip()

    # Remove markdown code blocks if present
    if content.startswith("```json"):
        content = content[7:]
    if content.startswith("```"):
        content = content[3:]
    if content.endswith("```"):
        content = content[:-3]

    content = content.strip()

    # Parse JSON
    return json.loads(content)


def _normalize_to_text_parts(agent_name: str, content: Any) -> List[Dict[str, Any]]:
    logger = logging.getLogger(__name__)

    def _make_part(text_value: str) -> Dict[str, Any]:
        return {"type": "text", "text": text_value}

    if content is None:
        return [_make_part("")]

    if isinstance(content, str):
        return [_make_part(content)]

    if isinstance(content, list):
        typed: List[Dict[str, Any]] = []
        fully_typed = True
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and "text" in item:
                typed.append({"type": "text", "text": str(item.get("text", ""))})
            elif isinstance(item, dict) and "content" in item and "request_id" in item:
                # Handle nested message structure from queue - extract the actual content
                actual_content = item.get("content", "")
                if isinstance(actual_content, str):
                    typed.append({"type": "text", "text": actual_content})
                else:
                    typed.append(_make_part(str(actual_content)))
                logger.info(f"[{agent_name}] Extracted nested content: {actual_content}")
            else:
                fully_typed = False
                break
        if fully_typed and typed:
            return typed

        normalized: List[Dict[str, Any]] = []
        for item in content:
            if isinstance(item, dict):
                if "content" in item and "request_id" in item:
                    # Handle nested message structure - extract the actual content
                    actual_content = item.get("content", "")
                    if isinstance(actual_content, str):
                        normalized.append({"type": "text", "text": actual_content})
                    else:
                        normalized.append(_make_part(str(actual_content)))
                    logger.info(f"[{agent_name}] Extracted nested content: {actual_content}")
                else:
                    try:
                        normalized.append(_make_part(json.dumps(item, ensure_ascii=False)))
                    except Exception:
                        normalized.append(_make_part(str(item)))
            else:
                normalized.append(_make_part(str(item)))
        logger.info(f"[{agent_name}] Normalized list content to typed text parts")
        return normalized

    try:
        payload = json.dumps(content, indent=2, ensure_ascii=False)
    except Exception:
        payload = str(content)
    logger.info(f"[{agent_name}] Converted {type(content).__name__} content to JSON text part")
    return [_make_part(payload)]


def get_work_dir(request_work_dir: Optional[str] = None) -> str:
    """
    Get the working directory for the current request.
    
    This function ensures CORTEX_WORK_DIR env var is set to the request-specific
    directory as a safety net, even if agents use os.environ.get('CORTEX_WORK_DIR').
    
    Args:
        request_work_dir: Request-specific work directory (e.g., /tmp/coding/req_XXX)
        
    Returns:
        The work directory path to use
    """
    # If request-specific directory provided, use it and set env var as safety net
    if request_work_dir:
        # Set CORTEX_WORK_DIR to request-specific directory to prevent path mismatches
        os.environ['CORTEX_WORK_DIR'] = request_work_dir
        return request_work_dir
    
    # Fallback to env var or default
    work_dir = os.getenv('CORTEX_WORK_DIR', '/tmp/coding')
    return work_dir


def create_request_context_vars(request_id: str, work_dir: str) -> str:
    """
    Create request context information for system messages.
    Includes current date and time to ensure agents are temporally aware.
    Each request only has access to its isolated work_dir.
    
    Note: This is for display in system messages only. For code execution,
    agents should use os.getcwd() for work_dir and datetime.now() for dates.
    """
    from datetime import datetime
    now = datetime.now()
    current_date = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M:%S")
    current_year = now.strftime("%Y")
    
    return f"""
Request ID: {request_id}
Working Directory: {work_dir}
Current Date: {current_date}
Current Time: {current_time}
Current Year: {current_year}

Note: In code execution, use os.getcwd() for working directory and datetime.now() for current date/time.
"""



def write_plan_to_file(work_dir: str, plan_content: str) -> None:
    """Write execution plan to logs/plan.log file."""
    if not work_dir or not os.path.exists(work_dir):
        return
    logs_dir = os.path.join(work_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    
    plan_path = os.path.join(logs_dir, "plan.log")
    try:
        from datetime import datetime
        timestamp = datetime.now().isoformat()
        with open(plan_path, 'w', encoding='utf-8') as f:
            f.write(f"[{timestamp}] PLAN CREATED\n{plan_content}\n")
    except Exception:
        pass  # Silently fail if file write fails

def append_accomplishment_to_file(work_dir: str, accomplishment: str) -> None:
    """Append accomplishment to logs/accomplishments.log file and events.jsonl."""
    if not work_dir or not os.path.exists(work_dir):
        return
    logs_dir = os.path.join(work_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)

    # Parse accomplishment to extract agent name and details
    # Format: "AGENT_NAME: description"
    if ": " in accomplishment:
        agent_part, description = accomplishment.split(": ", 1)
        agent_name = agent_part.strip()
    else:
        agent_name = "UNKNOWN_AGENT"
        description = accomplishment

    # Extract request_id from work_dir (e.g. '/tmp/coding/req_<uuid>')
    req_id = os.path.basename(work_dir) if work_dir else 'unknown_req'

    # Log to events.jsonl (JSONL format)
    events_path = os.path.join(logs_dir, "events.jsonl")
    try:
        import json
        from datetime import datetime
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "accomplishment",
            "agent_name": agent_name,
            "action": "accomplishment",
            "details": {
                "accomplishment": description,
                "evidence": ["tool_execution"],
                "context": "Tool-based accomplishment logging"
            },
            "result": None,
            "metadata": {
                "work_dir": work_dir,
                "request_id": req_id
            }
        }
        with open(events_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(event, ensure_ascii=False) + '\n')
    except Exception:
        pass  # Silently fail if JSONL logging fails

    # TODO: Remove legacy .log file creation once system is fully migrated to JSONL

    # TODO: Remove mirror logging once JSONL is fully adopted
    except Exception:
        pass  # Silently fail if file write fails

def write_current_step_to_file(work_dir: str, step_description: str, source: str) -> None:
    """Write current step to logs/current_step.log file."""
    if not work_dir or not os.path.exists(work_dir):
        return
    logs_dir = os.path.join(work_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    
    current_step_path = os.path.join(logs_dir, "current_step.log")
    try:
        with open(current_step_path, 'w', encoding='utf-8') as f:
            from datetime import datetime
            timestamp = datetime.now().isoformat()
            f.write(f"[{timestamp}] CURRENT_STEP - {source}: {step_description}\n")
    except Exception:
        pass  # Silently fail if file write fails

def build_dynamic_context_from_files(work_dir: str, task: str) -> str:
    """Build comprehensive dynamic context from all log sources and work directory state."""
    if not work_dir or not os.path.exists(work_dir):
        return f"**ORIGINAL TASK**:\n{task}\n\n**EXECUTION PLAN**:\nNo plan available\n"

    logs_dir = os.path.join(work_dir, "logs")
    context_parts = [f"**ORIGINAL TASK**:\n{task}\n"]

    # Read logs/plan.log
    plan_path = os.path.join(logs_dir, "plan.log")
    if os.path.exists(plan_path):
        try:
            with open(plan_path, 'r', encoding='utf-8') as f:
                plan_content = f.read().strip()
                if plan_content:
                    # Truncate very long plans, keep last 2000 chars (most recent)
                    if len(plan_content) > 2000:
                        plan_content = "...\n" + plan_content[-2000:]
                    context_parts.append(f"**EXECUTION PLAN**:\n{plan_content}\n")
        except Exception:
            pass

    # Read logs/agent_journey.log for high-level progress
    journey_path = os.path.join(logs_dir, "agent_journey.log")
    if os.path.exists(journey_path):
        try:
            with open(journey_path, 'r', encoding='utf-8') as f:
                journey_lines = f.readlines()
                # Get last 15 milestones for recent progress
                recent_journey = journey_lines[-15:] if len(journey_lines) > 15 else journey_lines
                if recent_journey:
                    journey_summary = "".join(recent_journey).strip()
                    context_parts.append(f"**RECENT AGENT PROGRESS**:\n{journey_summary}\n")
        except Exception:
            pass

    # Read logs/accomplishments.log (most important for context!)
    accomplishments_path = os.path.join(logs_dir, "accomplishments.log")
    if os.path.exists(accomplishments_path):
        try:
            with open(accomplishments_path, 'r', encoding='utf-8') as f:
                accomplishments = f.read().strip()
                if accomplishments:
                    # Keep last 3000 chars for most recent accomplishments
                    if len(accomplishments) > 3000:
                        accomplishments = "...\n" + accomplishments[-3000:]
                    context_parts.append(f"**ACCOMPLISHMENTS SO FAR**:\n{accomplishments}\n")
        except Exception:
            pass

    # List available files and deliverables (helps agents know what exists)
    try:
        deliverables = []
        for item in os.listdir(work_dir):
            item_path = os.path.join(work_dir, item)
            if os.path.isfile(item_path) and not item.startswith('.'):
                # List files with useful extensions
                if any(item.endswith(ext) for ext in ['.csv', '.png', '.jpg', '.pdf', '.json', '.txt']):
                    size_kb = os.path.getsize(item_path) / 1024
                    deliverables.append(f"  - {item} ({size_kb:.1f} KB)")
        
        # Check sql/ directory for data files
        sql_dir = os.path.join(work_dir, "sql")
        if os.path.exists(sql_dir) and os.path.isdir(sql_dir):
            sql_files = [f for f in os.listdir(sql_dir) if f.endswith('_result.json')]
            if sql_files:
                deliverables.append(f"\n  SQL Results: {len(sql_files)} JSON files in sql/")
        
        if deliverables:
            context_parts.append("**AVAILABLE FILES**:\n" + "\n".join(deliverables) + "\n")
    except Exception:
        pass

    # Read logs/current_step.log
    current_step_path = os.path.join(logs_dir, "current_step.log")
    if os.path.exists(current_step_path):
        try:
            with open(current_step_path, 'r', encoding='utf-8') as f:
                current_step = f.read().strip()
                if current_step:
                    context_parts.append(f"**CURRENT STEP**:\n{current_step}\n")
        except Exception:
            pass

    return "\n".join(context_parts) if len(context_parts) > 1 else f"**ORIGINAL TASK**:\n{task}\n\n**EXECUTION PLAN**:\nNo plan available\n"

def log_agent_milestone(work_dir: str, agent_name: str, action: str, details: str = "") -> None:
    """Log a high-level agent milestone to logs/agent_journey.log."""
    if not work_dir or not os.path.exists(work_dir):
        return
    logs_dir = os.path.join(work_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    
    journey_path = os.path.join(logs_dir, "agent_journey.log")
    try:
        from datetime import datetime
        timestamp = datetime.now().isoformat()
        
        # Format: Clean, scannable, keyword-rich
        log_entry = f"[{timestamp}] {agent_name.upper()} → {action}"
        if details:
            log_entry += f" | {details}"
        log_entry += "\n"
        
        with open(journey_path, 'a', encoding='utf-8') as f:
            f.write(log_entry)
    except Exception:
        pass  # Silently fail if file write fails

def log_agent_handoff(work_dir: str, from_agent: str, to_agent: str, reason: str = "") -> None:
    """Log agent-to-agent handoff to logs/handoffs.log."""
    if not work_dir or not os.path.exists(work_dir):
        return
    logs_dir = os.path.join(work_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    
    handoffs_path = os.path.join(logs_dir, "handoffs.log")
    try:
        from datetime import datetime
        timestamp = datetime.now().isoformat()
        
        log_entry = f"[{timestamp}] HANDOFF: {from_agent} → {to_agent}"
        if reason:
            log_entry += f" | Reason: {reason}"
        log_entry += "\n"
        
        with open(handoffs_path, 'a', encoding='utf-8') as f:
            f.write(log_entry)
    except Exception:
        pass  # Silently fail if file write fails
