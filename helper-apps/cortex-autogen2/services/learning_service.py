"""
Learning Service - Extract and retrieve learnings from Azure Cognitive Search.

Leverages existing ContextMemory, cognitive journey, and file summaries.
"""
import logging
import json
from typing import Optional, Dict, Any, List
from datetime import datetime

from services.azure_ai_search import search_similar_rest, upsert_run_rest
from autogen_core.models import UserMessage

logger = logging.getLogger(__name__)


async def get_learnings_for_task(task: str, task_id: str, model_client, context_memory=None) -> Optional[str]:
    """
    Retrieve learnings from Azure Cognitive Search for similar tasks.
    Returns formatted learnings string for planner_agent or None if no similar tasks.
    
    Args:
        task: Task description
        task_id: Request/task ID
        model_client: LLM client for synthesis
        context_memory: Optional ContextMemory instance to log retrieved learnings
    """
    try:
        similar_docs = search_similar_rest(task, top=5)
        if not similar_docs:
            if context_memory:
                context_memory.log_learning(
                    learning_type="retrieval",
                    content="No similar tasks found in Azure Cognitive Search",
                    source="azure_search",
                    metadata={"task": task, "similar_docs_count": 0}
                )
            return None
        
        # Use LLM to synthesize learnings from similar tasks
        prompt = f"""**CRITICAL CONTEXT**: These are learnings from PREVIOUS similar tasks. They worked in those contexts but may NOT apply directly to the current task. Use them as INTELLIGENT GUIDANCE, not rigid rules. The current task requirements are PRIMARY - adapt these learnings thoughtfully.

**Current Task**: {task}

**Previous Similar Tasks (for reference only)**:
{json.dumps([{"task": d.get("task", ""), "content": d.get("content", "")[:500]} for d in similar_docs[:3]], indent=2)}

Extract GENERALIZABLE principles (not task-specific details):
- Best practices (actionable strategies that worked before)
- Successful approaches (adaptable patterns)
- Data source strategies (which sources worked, extraction methods that succeeded)
- HTML extraction techniques (methods that successfully extracted data from HTML)
- Pitfalls to avoid (common mistakes)
- Recovery strategies (proven methods)

**IMPORTANT**: 
- These are EXAMPLES from past tasks, not guarantees
- Current task context is PRIMARY - use learnings as guidance, not constraints
- Adapt intelligently - what worked before may need modification
- Focus on generalizable principles, not copying exact approaches

Format as concise bullets (≤18 words each) that can be intelligently applied to planning."""
        
        messages = [UserMessage(content=prompt, source="learning_service")]
        response = await model_client.create(messages=messages)
        # Extract text from response (handle different response formats)
        if hasattr(response, 'content') and response.content:
            learnings = response.content[0].text if hasattr(response.content[0], 'text') else str(response.content[0])
        else:
            learnings = str(response)
        
        if learnings and len(learnings.strip()) > 50:
            formatted_learnings = f"**RECENT LEARNINGS**:\n{learnings}"
            
            # Log retrieved learnings to learnings.jsonl
            if context_memory:
                context_memory.log_learning(
                    learning_type="retrieved_learnings",
                    content=learnings,
                    source="azure_search",
                    metadata={
                        "task": task,
                        "similar_docs_count": len(similar_docs),
                        "synthesized": True
                    }
                )
            
            return formatted_learnings
        return None
    except Exception as e:
        logger.warning(f"[Learning] Retrieval failed: {e}")
        if context_memory:
            context_memory.log_learning(
                learning_type="retrieval_error",
                content=f"Failed to retrieve learnings: {str(e)}",
                source="azure_search",
                metadata={"task": task, "error": str(e)}
            )
        return None


def _extract_success_score_from_result(result: str) -> float:
    """Extract success score from execution_completion_verifier_agent JSON output."""
    from util.json_extractor import extract_json_from_llm_response
    
    data = extract_json_from_llm_response(result, expected_type=dict, log_errors=False)
    if data:
        score = data.get("score", 0)
        return float(score) if score != -1 else 0.0
    return 0.0


async def extract_and_save_learnings(
    task_id: str, task: str, context_memory, cognitive_journey: Optional[Dict],
    success_score: float, model_client
) -> bool:
    """
    Extract ONE high-impact learning per task - breakthroughs, instant data finding, one-shot enablement.
    Max IQ, min words, max impact. Every word must be valuable.
    """
    try:
        if not context_memory:
            logger.warning("[Learning] No context_memory provided, skipping extraction")
            return False
        
        events = context_memory.event_recorder.events if hasattr(context_memory, 'event_recorder') else []
        file_summaries = context_memory.get_file_summaries() if hasattr(context_memory, 'get_file_summaries') else {}
        
        # Extract execution insights: errors, inefficiencies, agent behaviors, execution flow
        # PRIORITY: Focus on breakthrough moments - where data was found after struggles, how errors were fixed
        
        errors_and_recoveries = []
        coding_error_fixes = []  # Track multiple coding errors and their fixes
        data_source_struggles = []  # Track failed data attempts
        data_source_breakthroughs = []  # Track where data was finally found (MOST IMPORTANT)
        agent_mistakes = []
        inefficient_paths = []
        data_source_attempts = []
        key_decisions = []
        execution_flow = []
        
        # Track agent sequence to detect loops/inefficiencies
        agent_sequence = []
        error_count_by_agent = {}  # Track how many times each agent hit errors
        
        for e in events:
            event_type = e.get("event_type")
            agent = e.get("agent_name", "unknown")
            
            if event_type == "error":
                error = e.get("error", "") or e.get("details", {}).get("error", "")
                recovery = e.get("recovery", "") or e.get("details", {}).get("recovery", "")
                if error:
                    errors_and_recoveries.append(f"{agent}: {error}" + (f" → Recovery: {recovery}" if recovery else ""))
                    
                    # Track coding errors specifically (coder_agent errors with fixes)
                    if agent == "coder_agent" and recovery:
                        coding_error_fixes.append(f"Error: {error} → Fixed by: {recovery}")
                    
                    # Count errors per agent to detect struggle patterns
                    if agent not in error_count_by_agent:
                        error_count_by_agent[agent] = 0
                    error_count_by_agent[agent] += 1
            
            elif event_type == "decision":
                decision = e.get("decision", "") or e.get("details", {}).get("decision", "")
                reasoning = e.get("reasoning", "") or e.get("details", {}).get("reasoning", "")
                if decision:
                    key_decisions.append(f"{agent}: {decision}" + (f" (Reasoning: {reasoning})" if reasoning else ""))
            
            elif event_type == "handoff":
                from_agent = e.get("from_agent", "unknown")
                to_agent = e.get("to_agent", "unknown")
                agent_sequence.append(f"{from_agent}→{to_agent}")
                execution_flow.append(f"Handoff: {from_agent} → {to_agent}")
            
            elif event_type == "tool_execution":
                tool = e.get("tool", "") or e.get("details", {}).get("tool", "")
                result = e.get("result", "") or e.get("details", {}).get("result", "")
                success = e.get("success", True)
                
                # Track data source attempts - failures and successes
                if "search" in tool.lower() or "data" in tool.lower() or "url" in tool.lower() or "fetch" in tool.lower():
                    if result and len(result) > 20:
                        # Remove local paths from result
                        clean_result = result[:200].replace("/tmp/coding/req_", "[path]/").replace("/Users/", "[path]/")
                        
                        if not success or "error" in str(result).lower() or "failed" in str(result).lower() or "404" in str(result) or "not found" in str(result).lower():
                            # Failed attempt - track struggle
                            data_source_struggles.append(f"{agent} tried {tool}: FAILED - {clean_result}")
                        else:
                            # Successful attempt - this is the breakthrough!
                            data_source_breakthroughs.append(f"{agent} found data using {tool}: {clean_result}")
                        
                        data_source_attempts.append(f"{agent} used {tool}: {clean_result}")
        
        # Detect loops and inefficient patterns in agent sequence
        if len(agent_sequence) >= 4:
            for i in range(len(agent_sequence) - 3):
                pattern = agent_sequence[i:i+2]
                if pattern == agent_sequence[i+2:i+4]:
                    inefficient_paths.append(f"Loop detected: {' → '.join(pattern)} repeated")
                    break
        
        # Identify agents that struggled (multiple errors)
        struggling_agents = [agent for agent, count in error_count_by_agent.items() if count >= 2]
        
        # Get worklog entries to understand what agents actually did
        agent_actions = []
        if hasattr(context_memory, 'work_dir'):
            import os
            worklog_file = os.path.join(context_memory.work_dir, "logs", "worklog.jsonl")
            if os.path.exists(worklog_file):
                try:
                    with open(worklog_file, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    entry = json.loads(line)
                                    agent = entry.get("agent", "unknown")
                                    description = entry.get("description", "")
                                    if description and agent != "system":
                                        agent_actions.append(f"{agent}: {description}")
                                except json.JSONDecodeError:
                                    continue
                except Exception as e:
                    logger.debug(f"Failed to read worklog.jsonl: {e}")
        
        # Build comprehensive context summary - PRIORITIZE BREAKTHROUGH MOMENTS
        context_parts = []
        
        # MOST IMPORTANT: Data source breakthroughs (where data was finally found after struggles)
        if data_source_breakthroughs:
            context_parts.append(f"🔍 DATA BREAKTHROUGH (MOST IMPORTANT - where data was finally found): {chr(10).join(data_source_breakthroughs)}")
        if data_source_struggles:
            context_parts.append(f"❌ Data source struggles (failed attempts before breakthrough): {chr(10).join(data_source_struggles[:5])}")
        
        # CRITICAL: Coding error fixes (if coder got stuck multiple times)
        if len(coding_error_fixes) >= 2:
            context_parts.append(f"🐛 CODING BREAKTHROUGH (coder got stuck {len(coding_error_fixes)} times, these fixes are critical): {chr(10).join(coding_error_fixes)}")
        
        # Agent struggles (multiple errors)
        if struggling_agents:
            context_parts.append(f"⚠️ Agents that struggled (multiple errors): {', '.join(struggling_agents)}")
        
        # Other errors and recoveries
        if errors_and_recoveries:
            context_parts.append(f"Errors encountered: {chr(10).join(errors_and_recoveries[:5])}")
        
        # Inefficient patterns
        if inefficient_paths:
            context_parts.append(f"Inefficient patterns: {chr(10).join(inefficient_paths[:3])}")
        
        # Execution flow
        if execution_flow:
            context_parts.append(f"Execution flow: {chr(10).join(execution_flow[:10])}")
        
        # Key decisions
        if key_decisions:
            context_parts.append(f"Key decisions: {chr(10).join(key_decisions[:5])}")
        
        # Agent actions
        if agent_actions:
            context_parts.append(f"Agent actions: {chr(10).join(agent_actions[:10])}")
        
        context_summary = chr(10).join(context_parts) if context_parts else "Task completed with standard workflow."
        
        prompt = f"""Extract ONE comprehensive learning from this task execution. Focus on WHAT WENT WRONG, WHY IT TOOK LONG, and HOW TO DO IT BETTER NEXT TIME.

**Task**: {task}

**Execution Context**:
{context_summary}

**CRITICAL LEARNING EXTRACTION REQUIREMENTS**:

**PRIORITY ORDER - Focus on breakthrough moments:**

1. **DATA FINDING BREAKTHROUGHS (HIGHEST PRIORITY)**: 
   - If system struggled to find data, WHERE it finally found the data is THE MOST IMPORTANT learning
   - Extract: Which data source/method/URL finally worked after failures?
   - Extract: What was the pattern that succeeded? (e.g., "official website X", "API endpoint Y", "search query Z")
   - This knowledge enables instant data finding next time

2. **CODING ERROR FIXES (HIGH PRIORITY)**:
   - If coder_agent got stuck 3+ times with different errors and fixed them, THOSE FIXES are critical
   - Extract: What errors occurred? How were they fixed?
   - Extract: What coding patterns/libraries/methods solved the problem?
   - This knowledge prevents same errors next time

3. **WHAT WENT WRONG**: Identify agent mistakes, inefficiencies, wrong approaches
   - Which agents made errors or took wrong paths?
   - What decisions led to delays or failures?
   - What should agents have done differently?

4. **WHY IT TOOK LONG**: Analyze execution complexity
   - Were there loops, retries, or back-and-forth between agents?
   - Did agents try wrong approaches before finding the right one?
   - Were there unnecessary steps or redundant operations?

5. **HOW TO DO BETTER NEXT TIME**: Provide generic, actionable guidance
   - What should planner_agent plan differently for similar tasks?
   - What should coder_agent code/search/find better?
   - What data sources or methods should be tried FIRST (based on what worked)?
   - What shortcuts or optimizations should be used?

4. **GENERIC PRINCIPLES ONLY**: 
   - NO local file paths, environment-specific paths, or system-specific details
   - NO references to specific files like "/tmp/coding/req_XXX/file.csv"
   - NO assumptions about local environment (next run might be different box)
   - Focus on GENERIC patterns, methods, approaches that work anywhere
   - Use generic placeholders: "data file", "output directory", "source URL"

5. **DETAILED BUT CONCISE**:
   - Can be any length needed for comprehensive learning (no word limit, no truncation)
   - Every word must add value - no spam, no fluff, no repetition
   - NO filler phrases like "During this task", "In this task", "For this task" - start directly with learning content
   - Structured: What went wrong → Why it took long → How to improve
   - Actionable: Specific guidance agents can follow next time
   - **NO TRUNCATION**: Output complete learning, no matter how long. Detailed learnings are valuable.

**Output Format**:
- Pure learning text only (no JSON, no code blocks, no headers)
- Start directly with the learning content
- Be specific about agent behaviors and improvements
- Include generic data sources, methods, approaches that worked
- Focus on patterns that apply to similar tasks, not this specific run
- **NO FILLER WORDS**: Do NOT use phrases like "During this task", "In this task", "For this task", "This task", "The task", "Throughout", "As part of" - we already know it's a learning from task execution. Start directly with the learning content.
- **NO TRUNCATION**: Output the complete learning, no matter how long. Detailed learnings are valuable. Do not cut off or truncate the content.

**Example Structure** (adapt based on actual execution):

**If data finding was a struggle:**
- "For [task type] requiring [data type], system struggled with [failed attempts]. BREAKTHROUGH: Data was finally found at [generic source/pattern] using [method]. Next time: Start with [this source/method] first, skip [failed approaches]. Pattern: [generic pattern that worked]."

**If coding had multiple errors:**
- "Coder_agent encountered 3 errors: [error1] → fixed by [fix1], [error2] → fixed by [fix2], [error3] → fixed by [fix3]. CRITICAL: For [task type], use [library/pattern] instead of [wrong approach]. Always [specific fix pattern] when [condition]."

**General structure:**
- "For [task type], planner_agent should [specific planning improvement]. Coder_agent encountered [specific issue] because [root cause]. Solution: [generic approach]. Data sources: [generic sources that worked, not specific URLs]. Avoid [specific mistake]. Use [generic method] instead of [inefficient approach]."

**CRITICAL**: If context shows data struggles or multiple coding errors, prioritize those breakthrough moments - they are the most valuable learnings.

Extract the learning now:"""
        
        messages = [UserMessage(content=prompt, source="learning_service")]
        response = await model_client.create(messages=messages)
        
        # Extract text from response using the same robust logic as json_extractor
        # This ensures consistent extraction across all LLM calls
        learning_text = None
        
        if hasattr(response, 'content') and response.content:
            # Handle string content directly (most common case)
            if isinstance(response.content, str):
                learning_text = response.content
            # Handle list of content items
            elif isinstance(response.content, list) and len(response.content) > 0:
                content_item = response.content[0]
                # Try multiple ways to extract text from content item
                if hasattr(content_item, 'text'):
                    text_val = getattr(content_item, 'text', None)
                    if text_val:
                        learning_text = text_val if isinstance(text_val, str) else str(text_val)
                if not learning_text and hasattr(content_item, 'content'):
                    content_val = getattr(content_item, 'content', None)
                    if content_val:
                        if isinstance(content_val, str):
                            learning_text = content_val
                        else:
                            learning_text = str(content_val)
                if not learning_text and isinstance(content_item, str):
                    learning_text = content_item
                if not learning_text:
                    learning_text = str(content_item)
            # Handle single content item (not list, not string)
            else:
                content_item = response.content
                if hasattr(content_item, 'text'):
                    text_val = getattr(content_item, 'text', None)
                    if text_val:
                        learning_text = text_val if isinstance(text_val, str) else str(text_val)
                if not learning_text and hasattr(content_item, 'content'):
                    content_val = getattr(content_item, 'content', None)
                    if content_val:
                        if isinstance(content_val, str):
                            learning_text = content_val
                        else:
                            learning_text = str(content_val)
                if not learning_text and isinstance(content_item, str):
                    learning_text = content_item
                if not learning_text:
                    learning_text = str(content_item)
        elif isinstance(response, str):
            learning_text = response
        elif hasattr(response, 'text'):
            learning_text = response.text
        else:
            learning_text = str(response)
        
        # Validate we got actual content
        if not learning_text:
            logger.warning(f"[Learning] No learning text extracted from LLM response. Response type: {type(response)}, has content: {hasattr(response, 'content')}")
            return False
        
        learning_text = str(learning_text).strip()
        
        # Debug: Log what we extracted
        logger.debug(f"[Learning] Extracted learning text length: {len(learning_text)}, preview: {learning_text[:100]}")
        
        # Initial validation - must have some content
        if len(learning_text) < 10:
            logger.warning(f"[Learning] LLM response extraction failed - got too short: {repr(learning_text[:200])}. Response type: {type(response)}")
            return False
        
        # Remove markdown code blocks, headers, etc.
        if learning_text.startswith("```"):
            import re
            learning_text = re.sub(r'```[a-z]*\n?', '', learning_text)
            learning_text = re.sub(r'```\n?', '', learning_text)
        learning_text = learning_text.strip()
        
        # Remove common prefixes that LLM might add
        prefixes_to_remove = ["Learning:", "Breakthrough:", "Insight:", "Key Learning:", "**", "#"]
        for prefix in prefixes_to_remove:
            if learning_text.startswith(prefix):
                learning_text = learning_text[len(prefix):].strip()
        
        # Final validation - must be substantial after cleaning
        if not learning_text or len(learning_text) < 50:
            logger.warning(f"[Learning] Generated learning too short ({len(learning_text)} chars) or empty after cleaning, skipping save. Raw text: {repr(learning_text[:200])}")
            return False
        
        # Remove local file paths and environment-specific references
        import re
        # Remove absolute paths like /tmp/coding/req_XXX/...
        learning_text = re.sub(r'/tmp/coding/req_[a-f0-9-]+/[^\s]+', '[output file]', learning_text)
        # Remove specific request IDs
        learning_text = re.sub(r'req_[a-f0-9-]+', '[request]', learning_text)
        # Remove local paths like /Users/... or C:\...
        learning_text = re.sub(r'/[^\s]+\.(csv|json|xlsx|pdf|pptx|png|jpg)', '[file]', learning_text)
        # Remove timestamps that might be in paths
        learning_text = re.sub(r'\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}', '[timestamp]', learning_text)
        
        # Remove filler words/phrases that add no value (we already know it's a learning from a task)
        filler_patterns = [
            r'\bDuring this task\b',
            r'\bIn this task\b',
            r'\bFor this task\b',
            r'\bThis task\b',
            r'\bThe task\b',
            r'\bThroughout the task\b',
            r'\bAs part of this task\b',
            r'\bIn the execution\b',
            r'\bDuring execution\b',
            r'\bIn this execution\b',
            r'\bFor this execution\b',
            r'\bThe execution\b',
            r'\bDuring the process\b',
            r'\bIn the process\b',
            r'\bThroughout the process\b',
            r'\bIn this case\b',
            r'\bFor this case\b',
            r'\bIn this scenario\b',
            r'\bFor this scenario\b',
        ]
        for pattern in filler_patterns:
            learning_text = re.sub(pattern, '', learning_text, flags=re.IGNORECASE)
        
        # Clean up multiple spaces and trim
        learning_text = re.sub(r'\s+', ' ', learning_text).strip()
        
        # NO TRUNCATION - Azure can handle longer content, detailed learnings are valuable
        # Only validate minimum length, not maximum
        
        # Prepare document for Azure - ONE learning, no metadata dump
        doc = {
            "id": task_id,
            "date": datetime.now().isoformat() + "Z",
            "task": task,
            "content": learning_text,  # Pure learning, no success_score, no metadata
            "owner": "autogen2",
            "requestId": task_id,
        }
        
        save_result = upsert_run_rest(doc)
        
        # Log to learnings.jsonl (always log, even if Azure save failed)
        if context_memory:
            try:
                context_memory.log_learning(
                    learning_type="brain_learning",
                    content=learning_text,
                    source="task_execution",
                    metadata={"task": task, "azure_saved": save_result}
                )
                logger.info(f"📝 Logged brain learning to learnings.jsonl (Azure save: {save_result})")
            except Exception as e:
                logger.warning(f"[Learning] Failed to log to learnings.jsonl: {e}")
        
        # Save to brain_learning.txt file if saving to Azure (non-one-shot task)
        if save_result and context_memory and hasattr(context_memory, 'work_dir'):
            try:
                import os
                logs_dir = os.path.join(context_memory.work_dir, "logs")
                os.makedirs(logs_dir, exist_ok=True)
                brain_learning_file = os.path.join(logs_dir, "brain_learning.txt")
                with open(brain_learning_file, 'w', encoding='utf-8') as f:
                    f.write(learning_text)
                logger.info(f"💾 Saved brain learning to {brain_learning_file}")
            except Exception as e:
                logger.warning(f"[Learning] Failed to save brain learning to file: {e}")
        
        if save_result:
            logger.info(f"🧠 Saved ONE brain learning to Azure ({len(learning_text)} chars)")
        else:
            logger.warning(f"⚠️  Azure save failed - check Azure connection/credentials. Learning still logged locally.")
        
        return save_result
    except Exception as e:
        logger.warning(f"[Learning] Save failed: {e}")
        return False
