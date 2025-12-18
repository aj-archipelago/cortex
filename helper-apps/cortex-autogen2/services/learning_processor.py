"""
Learning Processing Service

LLM-powered learning extraction and saving logic.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def process_task_completion_learnings(
    context_memory: Optional[object],
    task_id: Optional[str],
    task: str,
    final_result: Optional[str],
    model_client_for_processing: Optional[object]
) -> None:
    """
    Process and save learnings after task completion.
    Uses LLM to determine if task was one-shot and should skip Azure.
    """
    if not context_memory or not task_id or not final_result:
        return
    
    try:
        from services.learning_service import extract_and_save_learnings, _extract_success_score_from_result
        from context.cognitive_journey_mapper import get_cognitive_journey_mapper
        
        # Extract success score from verifier agent message
        # The verifier's TextMessage contains JSON with the score
        success_score = 0.0
        
        # Try to find verifier message in messages.jsonl (via event_recorder)
        if hasattr(context_memory, 'event_recorder'):
            import os
            import json
            messages_file = os.path.join(context_memory.work_dir, "logs", "messages.jsonl")
            if os.path.exists(messages_file):
                try:
                    with open(messages_file, 'r', encoding='utf-8') as f:
                        messages = []
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    msg = json.loads(line)
                                    messages.append(msg)
                                except json.JSONDecodeError:
                                    continue
                    
                    # Find ALL execution_completion_verifier_agent messages (any type)
                    # Verifier can send score in TextMessage, FunctionExecutionResult, or tool events
                    verifier_messages = [
                        m for m in messages 
                        if m.get("agent_name") == "execution_completion_verifier_agent"
                    ]
                    if verifier_messages:
                        # Try TextMessage first
                        text_messages = [m for m in verifier_messages if m.get("message_type") == "TextMessage"]
                        if text_messages:
                            last_verifier = text_messages[-1]
                            verifier_content = last_verifier.get("content", "")
                            success_score = _extract_success_score_from_result(verifier_content)
                            if success_score > 0:
                                logger.debug(f"📊 Extracted score {success_score} from verifier TextMessage")
                        
                        # If no score from TextMessage, try FunctionExecutionResult
                        if success_score == 0.0:
                            func_results = [m for m in verifier_messages if m.get("message_type") == "FunctionExecutionResult"]
                            for func_msg in reversed(func_results):  # Check most recent first
                                func_content = str(func_msg.get("content", ""))
                                # Try to extract score from function result content
                                extracted = _extract_success_score_from_result(func_content)
                                if extracted > 0:
                                    success_score = extracted
                                    logger.debug(f"📊 Extracted score {success_score} from verifier FunctionExecutionResult")
                                    break
                        
                        # Also check ToolCallExecutionEvent and ToolCallRequestEvent for score
                        if success_score == 0.0:
                            tool_events = [m for m in verifier_messages if m.get("message_type") in ["ToolCallExecutionEvent", "ToolCallRequestEvent"]]
                            for tool_msg in reversed(tool_events):
                                tool_content = str(tool_msg.get("content", ""))
                                extracted = _extract_success_score_from_result(tool_content)
                                if extracted > 0:
                                    success_score = extracted
                                    logger.debug(f"📊 Extracted score {success_score} from verifier tool event")
                                    break
                except Exception as e:
                    logger.debug(f"Failed to read messages.jsonl for score extraction: {e}")
        
        # If still no score found, try final_result as fallback
        # final_result is the presenter's final message, which might contain score info
        if success_score == 0.0:
            success_score = _extract_success_score_from_result(final_result)
            if success_score > 0:
                logger.debug(f"📊 Extracted score {success_score} from final_result fallback")
        
        # Also check all messages for any score mentions (verifier might have sent score in a different format)
        if success_score == 0.0 and hasattr(context_memory, 'event_recorder'):
            import os
            import json
            messages_file = os.path.join(context_memory.work_dir, "logs", "messages.jsonl")
            if os.path.exists(messages_file):
                try:
                    with open(messages_file, 'r', encoding='utf-8') as f:
                        all_msgs = [json.loads(line) for line in f if line.strip()]
                    # Search all messages for score patterns
                    for msg in reversed(all_msgs):
                        content = str(msg.get("content", ""))
                        if "score" in content.lower() or "Score" in content:
                            extracted = _extract_success_score_from_result(content)
                            if extracted > 0:
                                success_score = extracted
                                logger.debug(f"📊 Extracted score {success_score} from message content (agent: {msg.get('agent_name', 'unknown')})")
                                break
                except Exception as e:
                    logger.debug(f"Failed to search all messages for score: {e}")
        
        logger.info(f"📊 Extracted success score: {success_score}/100")
        
        # Get cognitive journey analytics
        journey_mapper = get_cognitive_journey_mapper()
        journey_analytics = journey_mapper.get_journey_analytics(task_id) if hasattr(journey_mapper, 'get_journey_analytics') else None
        
        # LLM-powered one-shot detection
        is_one_shot = await detect_one_shot_task(
            context_memory, int(success_score), model_client_for_processing
        )
        
        logger.info(f"🔍 Learning processing: score={success_score}, is_one_shot={is_one_shot}")
        
        # Save learnings logic:
        # 1. Skip one-shot tasks (already solved, no need to save)
        # 2. For ALL challenging tasks (not one-shot): ALWAYS save learnings to Azure
        #    - System must learn from all challenging tasks (successes and failures)
        #    - This builds the knowledge base for future one-shot completion
        
        if model_client_for_processing:
            if is_one_shot:
                # One-shot simple task - skip Azure (already solved, no need to save)
                logger.info(f"🎯 One-shot simple task detected (score: {success_score}) - skipping Azure learnings (already solved)")
            else:
                # Challenging task - ALWAYS save learnings (system must learn from all challenging tasks)
                logger.info(f"💾 Saving learnings to Azure (challenging task, score: {success_score})")
                try:
                    save_result = await extract_and_save_learnings(
                        task_id, task, context_memory, journey_analytics, success_score, model_client_for_processing
                    )
                    if save_result:
                        logger.info(f"✅ Learnings saved to Azure successfully")
                    else:
                        logger.warning(f"⚠️  Learnings save to Azure returned False (check Azure connection/logs)")
                except Exception as e:
                    logger.error(f"❌ Failed to save learnings to Azure: {e}", exc_info=True)
    
    except Exception as e:
        logger.warning(f"Failed to process task completion learnings: {e}")


async def detect_one_shot_task(
    context_memory: object,
    success_score: int,
    model_client: Optional[object]
) -> bool:
    """
    LLM-powered detection of one-shot simple tasks.
    """
    if not model_client or not hasattr(context_memory, 'event_recorder'):
        return False
    
    try:
        events = context_memory.event_recorder.events
        
        # Calculate execution duration from event timestamps
        execution_duration_seconds = None
        if events:
            try:
                from datetime import datetime
                # Get first and last event timestamps
                timestamps = []
                for e in events:
                    ts = e.get("timestamp")
                    if ts:
                        if isinstance(ts, str):
                            # Parse ISO format timestamp
                            try:
                                dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                                timestamps.append(dt.timestamp())
                            except:
                                pass
                        elif isinstance(ts, (int, float)):
                            timestamps.append(ts)
                
                if len(timestamps) >= 2:
                    start_time = min(timestamps)
                    end_time = max(timestamps)
                    execution_duration_seconds = end_time - start_time
            except Exception as e:
                logger.debug(f"Failed to calculate execution duration: {e}")
        
        # Analyze execution path complexity
        error_count = len([e for e in events if e.get("event_type") == "error"])
        file_count = len([e for e in events if e.get("event_type") == "file_creation"])
        handoff_count = len([e for e in events if e.get("event_type") == "handoff"])
        decision_count = len([e for e in events if e.get("event_type") == "decision"])
        tool_execution_count = len([e for e in events if e.get("event_type") == "tool_execution"])
        
        # Extract agent flow from events to detect loops/retries
        agent_sequence = []
        for e in events:
            if e.get("event_type") == "handoff":
                agent = e.get("to_agent") or e.get("agent_name") or "unknown"
                agent_sequence.append(agent)
            elif e.get("event_type") == "message":
                agent = e.get("agent_name") or e.get("source") or "unknown"
                if agent != "unknown":
                    agent_sequence.append(agent)
        
        # Detect loops: same agent pattern repeating
        has_loops = False
        if len(agent_sequence) >= 4:
            # Check for repeating patterns (e.g., A->B->A->B or A->A->A)
            for i in range(len(agent_sequence) - 3):
                pattern = agent_sequence[i:i+2]
                if pattern == agent_sequence[i+2:i+4]:
                    has_loops = True
                    break
            # Check for same agent repeating 3+ times
            for i in range(len(agent_sequence) - 2):
                if agent_sequence[i] == agent_sequence[i+1] == agent_sequence[i+2]:
                    has_loops = True
                    break
        
        # Count unique agents (more agents = more complex path)
        unique_agents = len(set(agent_sequence)) if agent_sequence else 0
        
        # Build execution flow summary for LLM analysis
        flow_summary = f"Agent sequence: {' -> '.join(agent_sequence[:10])}" + ("..." if len(agent_sequence) > 10 else "")
        if has_loops:
            flow_summary += " [LOOPS DETECTED]"
        
        # Format execution duration
        duration_str = "unknown"
        duration_minutes = None
        if execution_duration_seconds is not None:
            duration_minutes = execution_duration_seconds / 60.0
            if duration_minutes < 1:
                duration_str = f"{int(execution_duration_seconds)} seconds"
            else:
                duration_str = f"{duration_minutes:.1f} minutes ({int(execution_duration_seconds)} seconds)"
        
        # Use LLM to analyze execution path complexity
        prompt = f"""Analyze the execution path complexity of this task to determine if it was a simple one-shot task.

**Execution Path Metrics**:
- Success score: {success_score}
- Execution duration: {duration_str}
- Total events: {len(events)}
- Files created: {file_count}
- Errors encountered: {error_count}
- Agent handoffs: {handoff_count}
- Decisions made: {decision_count}
- Tool executions: {tool_execution_count}
- Unique agents involved: {unique_agents}
- Execution flow: {flow_summary}

**One-Shot Task Definition** (based on execution path, NOT just success):
A one-shot task has a SIMPLE, STRAIGHTFORWARD execution path:
- Direct path to completion (few agent handoffs, typically 1-3 agents)
- No loops or retries (agents don't repeat the same actions)
- Minimal errors (0-1 errors, quickly resolved)
- Simple flow (e.g., planner -> coder -> presenter, without back-and-forth)
- First attempt success (no major replanning or approach changes)
- **Fast execution** (typically completes in < 5 minutes)

**Challenging Task Definition** (complex execution path):
A challenging task has a COMPLEX execution path:
- Multiple agent handoffs (4+ agents or many handoffs)
- Loops detected (same agents repeating, back-and-forth patterns)
- Multiple errors or retries
- Complex flow (agents trying different approaches, replanning)
- Multiple attempts before success
- **Long execution time** (takes > 5 minutes indicates complexity, even if path seems simple)

**CRITICAL**: Focus on EXECUTION PATH COMPLEXITY and DURATION, not just success score. A task can have high score but complex path (challenging), or low score but simple path (still challenging due to failure). If execution took > 5 minutes, it's likely challenging regardless of path simplicity.

Analyze the execution flow above and determine if the path was simple (one-shot) or complex (challenging).

Return JSON:
{{
  "is_one_shot": true/false,
  "reason": "brief explanation focusing on execution path complexity"
}}
"""
        
        from autogen_core.models import UserMessage
        response = await model_client.create([UserMessage(content=prompt, source="one_shot_detector")])
        
        # Extract JSON using centralized utility
        from util.json_extractor import extract_json_from_model_response
        
        result = extract_json_from_model_response(response, expected_type=dict, log_errors=True)
        if result:
            return result.get("is_one_shot", False)
    
    except Exception as e:
        logger.debug(f"LLM one-shot detection failed, using fallback: {e}")
    
    # Fallback logic based on execution path complexity and duration
    # Analyze path complexity: simple path = one-shot, complex path = challenging
    
    # Calculate execution duration for fallback
    execution_duration_minutes = None
    if events:
        try:
            from datetime import datetime
            timestamps = []
            for e in events:
                ts = e.get("timestamp")
                if ts:
                    if isinstance(ts, str):
                        try:
                            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                            timestamps.append(dt.timestamp())
                        except:
                            pass
                    elif isinstance(ts, (int, float)):
                        timestamps.append(ts)
            
            if len(timestamps) >= 2:
                start_time = min(timestamps)
                end_time = max(timestamps)
                execution_duration_minutes = (end_time - start_time) / 60.0
        except Exception:
            pass
    
    # Check for simple execution path
    unique_agents = len(set([e.get("agent_name") or e.get("to_agent") or "unknown" 
                             for e in events if e.get("event_type") in ["handoff", "message"]]))
    
    # Simple path indicators:
    # - Few handoffs (<= 2)
    # - No errors or 1 quickly resolved error
    # - Few unique agents (<= 3)
    # - Not too many events (< 20)
    # - Fast execution (< 5 minutes)
    
    is_simple_path = (
        handoff_count <= 2 and
        unique_agents <= 3 and
        error_count <= 1 and
        len(events) < 20  # Not too many events overall
    )
    
    # Check execution duration - > 5 minutes = challenging
    is_fast_execution = True
    if execution_duration_minutes is not None:
        is_fast_execution = execution_duration_minutes <= 5.0
        if not is_fast_execution:
            logger.debug(f"Fallback: Execution took {execution_duration_minutes:.1f} minutes (> 5 min), not one-shot")
    
    # If path is complex (many handoffs, loops, errors) OR took too long, it's challenging
    if not is_simple_path:
        logger.debug(f"Fallback: Complex execution path (handoffs: {handoff_count}, agents: {unique_agents}, errors: {error_count}, events: {len(events)}), not one-shot")
        return False
    
    if not is_fast_execution:
        return False  # Already logged above
    
    # Simple path + fast execution + high score = likely one-shot
    if success_score >= 90 and is_simple_path and is_fast_execution:
        logger.debug(f"Fallback: Simple execution path, fast execution, high score - is one-shot")
        return True
    
    # Simple path but low score = still challenging (failed simple task)
    logger.debug(f"Fallback: Simple path but low score ({success_score}), not one-shot")
    return False
