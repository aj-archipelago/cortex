"""
Learning Service - Extract and retrieve learnings from Azure Cognitive Search.

Leverages existing ContextMemory, cognitive journey, and file summaries.
"""
import logging
import json
import re
from typing import Optional, Dict, Any, List
from datetime import datetime

from services.azure_ai_search import search_similar_rest, upsert_run_rest
from autogen_core.models import UserMessage

logger = logging.getLogger(__name__)


def _clean_text(text: str) -> str:
    """Clean text by removing ONLY environment-specific paths/IDs, keeping working URLs and code."""
    if not text:
        return text
    
    # Remove /tmp/coding/req_xxx/ paths (these won't exist next time)
    text = re.sub(r'/tmp/coding/req_[a-f0-9-]+/', '', text)
    
    # Remove request IDs in paths (but keep them in URLs if they're part of the working URL)
    text = re.sub(r'/req_[a-f0-9-]+/', '/', text)
    
    # Remove Azure Blob Storage request-specific paths (but keep the base URL pattern)
    text = re.sub(r'/autogentempfiles/req_[a-f0-9-]+/', '/autogentempfiles/', text)
    
    # Remove SAS token parameters from URLs (keep base URL)
    text = re.sub(r'\?[^ ]*sig=[^ &]+[^ ]*', '', text)
    text = re.sub(r'\?se=\d{4}-\d{2}-\d{2}[^ ]*', '', text)
    text = re.sub(r'&se=\d{4}-\d{2}-\d{2}[^ ]*', '', text)
    text = re.sub(r'&sig=[^ &]+', '', text)
    
    # Remove /Users/ paths (these won't exist next time)
    text = re.sub(r'/Users/[^\s]+', '', text)
    
    # Clean up double spaces
    text = re.sub(r'  +', ' ', text)
    text = text.strip()
    
    return text


def _clean_data_source(source: str) -> str:
    """Clean data source - remove ONLY temporary tokens/params, keep working URLs."""
    if not source:
        return source
    
    # Remove SAS token parameters (keep base URL)
    source = re.sub(r'\?[^ ]*sig=[^ &]+[^ ]*', '', source)
    source = re.sub(r'\?se=\d{4}-\d{2}-\d{2}[^ ]*', '', source)
    source = re.sub(r'&se=\d{4}-\d{2}-\d{2}[^ ]*', '', source)
    source = re.sub(r'&sig=[^ &]+', '', source)
    
    # Remove Azure Blob Storage request-specific paths (keep base URL)
    source = re.sub(r'/autogentempfiles/req_[a-f0-9-]+/', '/autogentempfiles/', source)
    
    # Remove /tmp/coding/req_xxx/ paths (these won't exist next time)
    source = re.sub(r'/tmp/coding/req_[a-f0-9-]+/', '', source)
    
    # Remove /Users/ paths
    source = re.sub(r'/Users/[^\s]+', '', source)
    
    # Clean up
    source = source.strip()
    
    return source


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
        prompt = f"""**CRITICAL CONTEXT**: These are learnings from {len(similar_docs)} PREVIOUS similar tasks retrieved from Azure Cognitive Search. They worked in those contexts but may NOT apply directly to the current task. Use them as INTELLIGENT GUIDANCE, not rigid rules. The current task requirements are PRIMARY - adapt these learnings thoughtfully.

**⚠️ IMPORTANT WARNINGS**:
- **DATA SOURCES MAY HAVE CHANGED**: URLs, APIs, and data sources mentioned in these learnings may no longer be available or may have changed structure. Always verify sources work before relying on them.
- **THESE ARE PREVIOUS PATTERNS**: These learnings show what worked BEFORE, not guarantees for the current task.
- **CURRENT TASK IS PRIMARY**: If learnings conflict with current task requirements, prioritize the current task.
- **TRY LEARNED SOURCES FIRST, BUT HAVE FALLBACKS**: Use learned data sources as starting points, but plan alternative sources in case they've changed.

**Current Task**: {task}

**Previous Similar Tasks (for reference only - {len(similar_docs)} retrieved)**:
{json.dumps([{"task": d.get("task", ""), "content": d.get("content", "")[:1000]} for d in similar_docs[:5]], indent=2)}

**PRIORITY ORDER - Extract these learnings (most important first)**:

1. **DATA SOURCE BREAKTHROUGHS (HIGHEST PRIORITY)**:
   - WHERE data was finally found after struggles (exact source patterns: domains, websites, APIs, URLs)
   - Which data sources/methods/URLs/domains finally worked? (e.g., "https://apps.bea.gov/iTable/?reqid=70", "Wikipedia tables", "FRED API")
   - What extraction methods succeeded? (HTML parsing, API calls, CSV downloads, etc.)
   - **CRITICAL**: Extract the EXACT source URL/pattern that worked so planner can try it FIRST, but with fallbacks
   - **WARNING**: Mention that these URLs may have changed - try them first but verify and have alternatives

2. **CODING ERROR FIXES**:
   - What errors occurred and how were they fixed?
   - What coding patterns/libraries/methods solved problems?

3. **Best practices** (actionable strategies that worked before)
4. **Successful approaches** (adaptable patterns)
5. **Pitfalls to avoid** (common mistakes)
6. **Recovery strategies** (proven methods)

**IMPORTANT**: 
- These are EXAMPLES from {len(similar_docs)} past tasks, not guarantees
- Current task context is PRIMARY - use learnings as guidance, not constraints
- Adapt intelligently - what worked before may need modification
- **DATA SOURCES CAN CHANGE** - URLs/APIs mentioned may no longer work, always verify and have fallbacks
- Focus on generalizable principles AND specific working patterns (URLs, code, queries)
- **PRIORITIZE data source breakthroughs** - if learnings mention where data was found, that's THE KEY learning, but verify it still works

Format as concise bullets (≤18 words each) that can be intelligently applied to planning. Start with data source breakthroughs if available. Include warnings about source verification."""
        
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
                
                # Track data source attempts - failures and successes WITH ATTEMPT ORDER
                if "search" in tool.lower() or "data" in tool.lower() or "url" in tool.lower() or "fetch" in tool.lower() or "download" in tool.lower():
                    if result and len(result) > 20:
                        # Remove local paths from result
                        clean_result = result[:200].replace("/tmp/coding/req_", "[path]/").replace("/Users/", "[path]/")
                        
                        # Track attempt order (count how many attempts we've seen)
                        attempt_num = len(data_source_struggles) + len(data_source_breakthroughs) + 1
                        
                        if not success or "error" in str(result).lower() or "failed" in str(result).lower() or "404" in str(result) or "not found" in str(result).lower():
                            # Failed attempt - track struggle WITH ATTEMPT NUMBER
                            data_source_struggles.append(f"{attempt_num}st/nd/rd/th attempt FAILED - {agent} tried {tool}: {clean_result}")
                        else:
                            # Successful attempt - this is the breakthrough! Track WITH ATTEMPT NUMBER
                            attempt_num = len(data_source_struggles) + len(data_source_breakthroughs) + 1
                            # Extract URL or source pattern from result if available
                            source_pattern = clean_result
                            if "http" in clean_result.lower():
                                # Try to extract domain/URL pattern
                                import re
                                urls = re.findall(r'https?://[^\s\)]+', clean_result)
                                if urls:
                                    # Extract domain pattern (e.g., "bea.gov", "wikipedia.org")
                                    domain_match = re.search(r'https?://([^/]+)', urls[0])
                                    if domain_match:
                                        source_pattern = f"source: {domain_match.group(1)}"
                            # Include how many attempts failed before this success
                            failed_count = len(data_source_struggles)
                            if failed_count > 0:
                                data_source_breakthroughs.append(f"{attempt_num}st/nd/rd/th attempt SUCCESS (after {failed_count} failures) - {agent} found data via {tool}: {source_pattern}")
                            else:
                                data_source_breakthroughs.append(f"{attempt_num}st/nd/rd/th attempt SUCCESS - {agent} found data via {tool}: {source_pattern}")
                        
                        data_source_attempts.append(f"{agent} used {tool}: {clean_result}")
            
            elif event_type == "file_creation":
                # CRITICAL: File creation events indicate successful data acquisition!
                # Track files downloaded by web_search_agent (HTML, CSV, JSON, etc.) as breakthroughs
                file_path = e.get("details", {}).get("file_path", "") or e.get("file_path", "")
                file_type = e.get("details", {}).get("file_type", "") or e.get("file_type", "")
                agent = e.get("agent_name", "unknown")
                
                # Focus on data files downloaded by web_search_agent (not log files or generated files)
                if agent == "web_search_agent" and file_type in ["html", "csv", "json", "xlsx", "zip"]:
                    # Extract source pattern from filename (e.g., "bea_gov", "wikipedia", "fred")
                    import os
                    import re
                    filename = os.path.basename(file_path) if file_path else ""
                    
                    # Extract domain/org pattern from filename (e.g., "apps_bea_gov" -> "bea.gov", "wikipedia" -> "wikipedia")
                    source_pattern = None
                    # Try to extract domain pattern from filename
                    if "_" in filename:
                        parts = filename.split("_")
                        # Look for domain patterns (bea, gov, wikipedia, etc.)
                        for part in parts:
                            part_lower = part.lower()
                            if part_lower in ["bea", "gov", "wikipedia", "fred", "worldbank", "stlouisfed", "world", "bank"]:
                                if part_lower == "gov" and "bea" in filename.lower():
                                    source_pattern = "bea.gov"
                                elif part_lower == "bea":
                                    source_pattern = "bea.gov"
                                else:
                                    source_pattern = part_lower
                                break
                    
                    # If no pattern found, try to extract from filename structure
                    if not source_pattern:
                        # Look for common patterns like "domain_org" or "org_domain"
                        domain_match = re.search(r'([a-z]+)_([a-z]+)', filename.lower())
                        if domain_match:
                            part1, part2 = domain_match.groups()
                            if part1 in ["bea", "apps"] and part2 == "gov":
                                source_pattern = "bea.gov"
                            elif part1 in ["wikipedia", "wiki"]:
                                source_pattern = "wikipedia"
                            elif part1 in ["fred", "stlouisfed"]:
                                source_pattern = "fred.stlouisfed.org"
                    
                    # Default to filename pattern if no specific pattern found
                    if not source_pattern:
                        source_pattern = f"filename pattern: {filename[:50]}"
                    
                    # This is a breakthrough - data was successfully downloaded!
                    data_source_breakthroughs.append(f"{agent} successfully downloaded {file_type.upper()} data file from {source_pattern} (filename: {filename[:50]})")
                    data_source_attempts.append(f"{agent} downloaded {file_type.upper()} file: {filename[:50]}")
        
        # Detect loops and inefficient patterns in agent sequence
        if len(agent_sequence) >= 4:
            for i in range(len(agent_sequence) - 3):
                pattern = agent_sequence[i:i+2]
                if pattern == agent_sequence[i+2:i+4]:
                    inefficient_paths.append(f"Loop detected: {' → '.join(pattern)} repeated")
                    break
        
        # Identify agents that struggled (multiple errors)
        struggling_agents = [agent for agent, count in error_count_by_agent.items() if count >= 2]
        
        # Get worklog entries with structured details (SQL queries, code patterns, errors, data sources)
        # CRITICAL: Use worklog.jsonl instead of messages.jsonl - it has structured details for brain learning
        agent_actions = []
        sql_queries_from_worklog = []
        code_patterns_from_worklog = []
        errors_from_worklog = []
        error_fixes_from_worklog = []
        data_sources_from_worklog = []
        tools_used_from_worklog = []
        
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
                                    agent = entry.get("agent_name", entry.get("agent", "unknown"))
                                    description = entry.get("description", "")
                                    work_type = entry.get("work_type", "")
                                    details = entry.get("details", {})  # Structured details from enhanced extractor
                                    
                                    if description and agent != "system":
                                        agent_actions.append(f"{agent}: {description}")
                                        
                                        # Extract structured details from worklog
                                        if details:
                                            # SQL queries
                                            sql_queries = details.get("sql_queries", [])
                                            if sql_queries:
                                                sql_queries_from_worklog.extend(sql_queries)
                                            
                                            # Code patterns
                                            code_patterns = details.get("code_patterns", [])
                                            if code_patterns:
                                                code_patterns_from_worklog.extend(code_patterns)
                                            
                                            # Errors and fixes
                                            errors = details.get("errors", [])
                                            if errors:
                                                errors_from_worklog.extend([f"{agent}: {e}" for e in errors])
                                            
                                            error_fixes = details.get("error_fixes", [])
                                            if error_fixes:
                                                error_fixes_from_worklog.extend([f"{agent}: {e}" for e in error_fixes])
                                            
                                            # Data sources (MOST IMPORTANT)
                                            data_sources = details.get("data_sources", [])
                                            if data_sources:
                                                # Genericize data sources (remove temporary URLs, keep domain patterns)
                                                for source in data_sources:
                                                    generic_source = _genericize_data_source(source)
                                                    data_sources_from_worklog.append(generic_source)
                                                    # Add to breakthroughs with attempt order if available
                                                    # Track which attempt this was (if we can infer from worklog order)
                                                    data_source_breakthroughs.append(f"{agent} found data from: {generic_source}")
                                            
                                            # Tools used
                                            tools_used = details.get("tools_used", [])
                                            if tools_used:
                                                tools_used_from_worklog.extend(tools_used)
                                        
                                        # Fallback: Extract from description if details not available (backward compatibility)
                                        if not details or not details.get("data_sources"):
                                            desc_lower = description.lower()
                                            if agent == "web_search_agent" and work_type in ["data_collection", "tool_execution"]:
                                                if any(keyword in desc_lower for keyword in ["collected", "fetched", "downloaded", "saved", "found"]):
                                                    import re
                                                    source_keywords = ["bea", "wikipedia", "fred", "world bank", "stlouisfed", "gov", "org"]
                                                    for keyword in source_keywords:
                                                        if keyword in desc_lower:
                                                            source_pattern = keyword
                                                            context_match = re.search(rf'({keyword}[^\s]*(?:\s+[A-Z][^\s]*)*)', description, re.IGNORECASE)
                                                            if context_match:
                                                                source_pattern = context_match.group(1)
                                                            data_source_breakthroughs.append(f"{agent} successfully acquired data from: {source_pattern} (from worklog: {description[:100]})")
                                                            break
                                except json.JSONDecodeError:
                                    continue
                except Exception as e:
                    logger.debug(f"Failed to read worklog.jsonl: {e}")
        
        # Get learnings from learnings.jsonl (actionable insights, breakthroughs, error fixes)
        learnings_from_file = []
        if hasattr(context_memory, 'work_dir'):
            import os
            learnings_file = os.path.join(context_memory.work_dir, "logs", "learnings.jsonl")
            if os.path.exists(learnings_file):
                try:
                    with open(learnings_file, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    entry = json.loads(line)
                                    learning_type = entry.get("learning_type", "")
                                    content = entry.get("content", "")
                                    details = entry.get("details", {})
                                    
                                    if content:
                                        learnings_from_file.append({
                                            "type": learning_type,
                                            "content": content,
                                            "details": details
                                        })
                                        
                                        # Extract breakthroughs from learnings
                                        if details:
                                            breakthrough = details.get("breakthrough")
                                            if breakthrough:
                                                data_source_breakthroughs.append(f"Breakthrough from learnings: {breakthrough}")
                                            
                                            what_worked = details.get("what_worked")
                                            if what_worked and "data" in learning_type.lower() or "source" in learning_type.lower():
                                                data_source_breakthroughs.append(f"Data source that worked: {what_worked}")
                                            
                                            # Extract error fixes from learnings
                                            if "error" in learning_type.lower() or "fix" in learning_type.lower():
                                                if what_worked:
                                                    error_fixes_from_worklog.append(f"Error fix from learnings: {what_worked}")
                                except json.JSONDecodeError:
                                    continue
                except Exception as e:
                    logger.debug(f"Failed to read learnings.jsonl: {e}")
        
        # Build comprehensive context summary - PRIORITIZE BREAKTHROUGH MOMENTS
        context_parts = []
        
        # MOST IMPORTANT: Data source breakthroughs (where data was finally found after struggles)
        if data_source_breakthroughs:
            context_parts.append(f"🔍 DATA BREAKTHROUGH (MOST IMPORTANT - where data was finally found after struggles): {chr(10).join(data_source_breakthroughs)}")
            # Add emphasis that this is THE KEY learning
            context_parts.append(f"⚠️ CRITICAL: The breakthrough above shows WHERE data was finally found. This knowledge enables instant data finding next time - extract the exact source pattern/method/URL that worked.")
        if data_source_struggles:
            context_parts.append(f"❌ Data source struggles (failed attempts before breakthrough - VALUABLE for next time to skip these): {chr(10).join(data_source_struggles[:10])}")
            context_parts.append(f"⚠️ CRITICAL: The failed attempts above show what NOT to try first. Next time, skip these and go directly to the breakthrough source, but keep alternatives (6th, 7th, etc.) ready if the breakthrough source has changed.")
        
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
        
        # Agent actions (clean paths only)
        if agent_actions:
            cleaned_actions = [_clean_text(action) for action in agent_actions[:10]]
            context_parts.append(f"Agent actions: {chr(10).join(cleaned_actions)}")
        
        # CRITICAL: Use structured data from worklog.jsonl and learnings.jsonl instead of messages.jsonl
        structured_details_for_llm = ""
        
        # SQL queries from worklog (keep SPECIFIC working queries)
        if sql_queries_from_worklog:
            context_parts.append(f"📊 SQL QUERIES THAT WORKED (from worklog - SPECIFIC queries): {chr(10).join(sql_queries_from_worklog[:10])}")
        
        # Code patterns from worklog (keep SPECIFIC working code)
        if code_patterns_from_worklog:
            context_parts.append(f"💻 CODE PATTERNS THAT WORKED (from worklog - SPECIFIC code): {chr(10).join(code_patterns_from_worklog[:10])}")
        
        # Errors and fixes from worklog (keep specific, only clean paths)
        if errors_from_worklog:
            cleaned_errors = [_clean_text(e) for e in errors_from_worklog[:10]]
            context_parts.append(f"❌ ERRORS ENCOUNTERED (from worklog): {chr(10).join(cleaned_errors)}")
        
        if error_fixes_from_worklog:
            cleaned_fixes = [_clean_text(f) for f in error_fixes_from_worklog[:10]]
            context_parts.append(f"✅ ERROR FIXES (from worklog): {chr(10).join(cleaned_fixes)}")
        
        # Data sources from worklog (MOST IMPORTANT - keep SPECIFIC working URLs)
        if data_sources_from_worklog:
            context_parts.append(f"🔍 DATA SOURCES THAT WORKED (from worklog - SPECIFIC URLs): {chr(10).join(data_sources_from_worklog[:10])}")
        
        # Tools used from worklog (keep specific)
        if tools_used_from_worklog:
            context_parts.append(f"🛠️ TOOLS/METHODS USED (from worklog): {chr(10).join(tools_used_from_worklog[:10])}")
        
        # Learnings from learnings.jsonl (actionable insights - already genericized)
        if learnings_from_file:
            learnings_summary = []
            for learning in learnings_from_file[:15]:  # Limit to most recent 15 learnings
                learning_str = f"[{learning['type']}] {learning['content']}"
                if learning.get('details'):
                    details = learning['details']
                    if details.get('what_worked'):
                        learning_str += f" | What worked: {details['what_worked']}"
                    if details.get('what_failed'):
                        learning_str += f" | What failed: {details['what_failed']}"
                    if details.get('breakthrough'):
                        # Emphasize prioritization if breakthrough mentions attempt order
                        breakthrough = details['breakthrough']
                        if 'attempt' in breakthrough.lower() or 'next time' in breakthrough.lower():
                            learning_str += f" | ⚠️ PRIORITIZATION: {breakthrough}"
                        else:
                            learning_str += f" | Breakthrough: {breakthrough}"
                learnings_summary.append(learning_str)
            
            if learnings_summary:
                context_parts.append(f"🧠 ACTIONABLE LEARNINGS (from learnings.jsonl, genericized): {chr(10).join(learnings_summary)}")
        
        context_summary = chr(10).join(context_parts) if context_parts else "Task completed with standard workflow."
        
        prompt = f"""Extract ONE comprehensive, high-IQ learning that will make similar tasks go ONE-SHOT next time. This learning is for the system's "brain" - it must be actionable, specific, and enable instant success.

**Task**: {task}

**Execution Context**:
{context_summary}

**YOUR MISSION**: Extract a learning that captures HOW THE JOB WAS DONE, WHAT GOT STUCK, and HOW TO DO IT INSTANTLY NEXT TIME. This is like a brain with IQ 9999 - every word must enable one-shot completion.

**CRITICAL EXTRACTION REQUIREMENTS**:

**1. DYNAMIC EXTRACTION FROM STRUCTURED WORKLOG AND LEARNINGS - GENERIC PATTERNS ONLY**:
   - Analyze the structured details provided above (worklog.jsonl with SQL queries, code patterns, errors, data sources; learnings.jsonl with actionable insights)
   - **CRITICAL: KEEP SPECIFIC WORKING PATTERNS** - Extract SPECIFIC patterns that worked, remove ONLY environment-specific paths:
     * Remove paths like "/tmp/coding/req_xxx/" - these won't exist next time
     * Remove SAS tokens from URLs (sig=, se= params) - these expire
     * KEEP actual working URLs (e.g., "https://apps.bea.gov/iTable/?reqid=70&step=30") - these will work next time
     * KEEP actual working code patterns (e.g., "pandas.read_html(StringIO(html_content))") - these are reusable
     * KEEP actual SQL queries with table names - these are specific and work
   - **SQL QUERIES**: Use the SQL queries from worklog.jsonl - keep SPECIFIC working queries with actual table names. Example: "SELECT post_author, COUNT(*) FROM ucms_aje.wp_posts WHERE post_status='publish'..." - keep actual table/column names that worked
   - **CODE PATTERNS**: Use the code patterns from worklog.jsonl - keep SPECIFIC working code. Example: "pandas.read_html(StringIO(html_content))" - keep actual code that worked
   - **ERRORS AND FIXES**: Use the errors and error fixes from worklog.jsonl - keep specific error messages and fixes. Example: "ValueError: No tables found" - keep actual error patterns
   - **DATA SOURCES**: Use the data sources from worklog.jsonl - these are THE KEY breakthroughs. Keep SPECIFIC working URLs. Example: "https://apps.bea.gov/iTable/?reqid=70&step=30" NOT generic "bea.gov" - the specific URL that worked
   - **PRIORITIZATION**: If data was found on the 5th attempt, indicate which SPECIFIC source/method worked and should be tried FIRST next time. Example: "Data found on 5th attempt at https://apps.bea.gov/iTable/?reqid=70&step=30 - NEXT TIME: Try this EXACT URL FIRST, skip direct CSV download attempts"
   - **LEARNINGS**: Use the actionable learnings from learnings.jsonl - they contain specific breakthroughs, what worked vs what failed
   - **REMOVE ONLY**: Paths (/tmp/coding/req_xxx/), SAS tokens (sig=, se=), request IDs in paths - but KEEP working URLs, code, queries

**2. WHAT GOT STUCK - SPECIFIC DETAILS WITH ATTEMPT ORDER**:
   - Which specific SQL queries failed? On which attempt? What was the error? How was it fixed?
   - Which specific code operations failed? On which attempt? What was the error? How was it fixed?
   - Which specific data sources failed? On which attempts (1st, 2nd, 3rd, etc.)? Why did they fail? What finally worked (which attempt)?
   - Which agents got stuck? On what attempts? How did they recover?
   - Extract SPECIFIC error messages and SPECIFIC fixes WITH ATTEMPT ORDER - this is VALUABLE to know what to skip next time
   - **CRITICAL**: Include ALL failed attempts (1st, 2nd, 3rd, 4th) AND the successful one (5th) - this helps next time skip 1-4 and try 5th first, but also know alternatives exist (6th, 7th, etc.)

**3. HOW THE JOB WAS DONE - EXACT PATH**:
   - What was the exact sequence that worked? (planner → agent1 → agent2 → ...)
   - What SQL queries actually worked? (extract query patterns, genericize table names)
   - What code actually worked? (extract code patterns, libraries, methods)
   - What data sources actually worked? (extract source patterns, methods, URLs)
   - What tools/methods actually worked? (extract tool patterns, parameters that worked)

**4. HOW TO DO IT ONE-SHOT NEXT TIME - PRIORITIZATION CRITICAL**:
   - **PRIORITIZATION**: If data was found on the 5th attempt, extract which SPECIFIC source/method worked and state "NEXT TIME: Try [SPECIFIC URL/method] FIRST, skip [failed attempts]"
   - What should planner_agent plan FIRST? (based on what worked, prioritize successful SPECIFIC sources/methods)
   - What SQL query should aj_sql_agent use? (extract the EXACT working query with actual table names - keep it specific)
   - What code pattern should coder_agent use? (extract the EXACT working code - keep it specific, remove only paths)
   - What data source should web_search_agent try FIRST? (extract the SPECIFIC breakthrough URL/method that worked)
   - What shortcuts eliminate the redundant steps? (skip what didn't work, go straight to SPECIFIC what worked)
   - **CRITICAL**: Extract attempt order if available - if source X worked on 5th attempt, state "Try SPECIFIC source X (with actual URL) FIRST, skip sources A, B, C, D that failed"

**5. FORMAT - DENSE, ACTIONABLE, SPECIFIC, NO FILLER**:
   - Start directly with learning content (NO "During this task", "In this task", etc.)
   - Every sentence must be actionable - agents can follow it directly
   - Include actual SQL queries (with actual table names), code patterns (actual working code), error patterns
   - Include actual source URLs (remove only SAS tokens), tool patterns, method patterns
   - **CRITICAL: KEEP SPECIFIC WORKING PATTERNS** - Remove only paths (/tmp/coding/req_xxx/), SAS tokens. Keep actual working URLs, code, queries.
   - **PRIORITIZATION WITH FAILED ATTEMPTS**: If data was found after multiple attempts, explicitly state "NEXT TIME: Try [SPECIFIC URL/method from successful attempt] FIRST, skip [list all failed attempts with their URLs/errors], but keep alternatives (6th, 7th, etc.) ready if the successful source has changed"
   - Dense with information - no filler words, no repetition
   - Can be any length needed - detailed learnings are valuable
   - **NO TRUNCATION** - output complete learning
   - **REMOVE ONLY**: "/tmp/coding/req_xxx/" paths, SAS tokens (sig=, se=), request IDs in paths - but KEEP working URLs, code, queries

**EXAMPLE STRUCTURE** (adapt based on actual execution):

**If SQL queries were involved:**
"For [task type] requiring database queries, aj_sql_agent initially tried [failed query pattern] which failed with [specific error]. BREAKTHROUGH: Query that worked: [EXACT SQL pattern with genericized table names, e.g., 'SELECT post_author, COUNT(*) FROM [posts_table] WHERE post_status='publish' AND YEAR(post_date)=YEAR(CURDATE()) GROUP BY post_author ORDER BY COUNT(*) DESC LIMIT 50']. Error fix: [specific fix, e.g., 'DATE_FORMAT requires specific date format, use DATE_FORMAT(post_date, '%Y-%m-01') not '%Y-%m'']. Next time: Use [this EXACT query pattern] FIRST, avoid [failed pattern]."

**If code execution was involved:**
"Coder_agent encountered [specific error, e.g., 'KeyError: post_author'] when [specific operation, e.g., 'accessing JSON result']. Fix: [specific fix, e.g., 'check result structure first, use result.get('data', []) before accessing']. Code pattern that worked: [extract actual code pattern, e.g., 'import pandas as pd; df = pd.read_json(file); top_authors = df.groupby('author').size().sort_values(ascending=False).head(10)']. Next time: Use [this EXACT code pattern] FIRST."

**If data finding was involved:**
"System struggled with multiple failed attempts: 1st attempt FAILED - Direct CSV download from https://apps.bea.gov/api/data?format=csv (404 Not Found), 2nd attempt FAILED - FRED API at https://fred.stlouisfed.org/series/GDP (empty results), 3rd attempt FAILED - Wikipedia scraping (no tables found), 4th attempt FAILED - World Bank API (timeout). BREAKTHROUGH (found on 5th attempt): Data found at https://apps.bea.gov/iTable/?reqid=70&step=30 using fetch_webpage_bound() to save HTML, then pandas.read_html(StringIO(html_content)). NEXT TIME: Try https://apps.bea.gov/iTable/?reqid=70&step=30 FIRST using HTML table extraction method, skip attempts 1-4 (CSV download, FRED API, Wikipedia, World Bank), but keep 6th+ alternatives ready if the breakthrough source has changed."

**GENERAL STRUCTURE**:
"[Task type] execution path: [exact sequence that worked]. SQL queries: [extract working query patterns]. Code patterns: [extract working code patterns]. Data sources: [extract working source patterns]. Errors encountered: [specific errors] → fixed by [specific fixes]. Next time: [EXACT actionable steps to one-shot]."

**CRITICAL**: 
- Extract ACTUAL patterns from execution details (SQL, code, sources, errors)
- Make it ACTIONABLE - agents can follow it directly
- Make it SPECIFIC - include actual query/code/source patterns
- Make it DENSE - no filler, every word enables one-shot
- Make it COMPLETE - no truncation, detailed learnings are valuable

Analyze the execution context above and extract the learning now:"""
        
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
        
        # Remove local file paths and environment-specific references (AGGRESSIVE GENERICIZATION)
        import re
        # Remove absolute paths like /tmp/coding/req_XXX/...
        learning_text = re.sub(r'/tmp/coding/req_[a-f0-9-]+/[^\s]+', '[output file]', learning_text)
        # Remove specific request IDs
        learning_text = re.sub(r'req_[a-f0-9-]+', '[request_id]', learning_text)
        # Remove local paths like /Users/... or C:\...
        learning_text = re.sub(r'/[^\s]+\.(csv|json|xlsx|pdf|pptx|png|jpg)', '[file]', learning_text)
        # Remove timestamps that might be in paths
        learning_text = re.sub(r'\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}', '[timestamp]', learning_text)
        # Remove Azure Blob Storage URLs with SAS tokens (keep domain pattern)
        learning_text = re.sub(r'https?://[^/]+/autogentempfiles/req_[a-f0-9-]+/[^\s]+', 'Azure Blob Storage file', learning_text)
        learning_text = re.sub(r'\?[^ ]*sig=[^ &]+[^ ]*', '', learning_text)  # Remove SAS tokens
        learning_text = re.sub(r'\?se=\d{4}-\d{2}-\d{2}[^ ]*', '', learning_text)  # Remove expiration params
        # Genericize URLs - keep domain, remove params/tokens
        learning_text = re.sub(r'https?://([^/]+)/[^\s]+', r'[\1 data source]', learning_text)
        
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
