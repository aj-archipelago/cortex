"""
Context generation functionality for context memory system.

Handles LLM-powered summarization and context generation for agents.
"""
import json
import os
import logging
from typing import Dict, Any, Optional, List
from .config import AGENT_CONTEXT_LIMITS, AGENT_ROLE_DESCRIPTIONS
from .context_utils import estimate_tokens, filter_relevant_events

logger = logging.getLogger(__name__)


class ContextGenerator:
    """
    Handles context generation and LLM-powered summarization.
    """
    
    def __init__(self, model_client, event_recorder, file_summarizer):
        """
        Initialize ContextGenerator.
        
        Args:
            model_client: LLM client for summarization
            event_recorder: EventRecorder instance for accessing events
            file_summarizer: FileSummarizer instance for file summaries
        """
        self.model_client = model_client
        self.event_recorder = event_recorder
        self.file_summarizer = file_summarizer
        self.file_summarizer = file_summarizer
    
    async def generate_context_summary(self, task: str) -> str:
        """
        Use LLM to generate intelligent summary from all events.
        
        Args:
            task: Original task description
            
        Returns:
            Markdown-formatted summary string
        """
        events = self.event_recorder.events
        if not events:
            return "No events recorded yet."
        
        # Prepare events for LLM
        events_json = json.dumps(events, indent=2, ensure_ascii=False)
        
        # Create summarization prompt
        prompt = f"""You are a context summarizer. Analyze all agent events and create a comprehensive summary.

EVENTS: {events_json}
TASK: {task}

Create a structured summary with:
1. **AGENT FLOW WALKTHROUGH**: Sequential list of agents, what each did, why selected, accomplishments, handoffs
2. **ACCOMPLISHMENTS SUMMARY**: What was created/achieved, evidence (files, data), status of deliverables
3. **FILES CREATED**: For each file - name, type, created by which agent, purpose, content summary/preview
4. **KEY DECISIONS**: Important choices, reasoning, impact
5. **DATA SOURCES**: Database queries, web searches, synthetic data generation
6. **CURRENT STATE**: What's ready for presentation, what's pending, any issues

Be specific, accurate, and comprehensive. Base everything on actual events, not assumptions."""
        
        try:
            from autogen_core.models import UserMessage
            
            messages = [UserMessage(content=prompt, source="context_generator")]
            
            response = await self.model_client.create(messages=messages)
            
            # Handle response format - check for content attribute first (OpenAI-compatible)
            summary = None
            if response and hasattr(response, 'content'):
                summary = response.content
            elif response and isinstance(response, list) and len(response) > 0:
                summary = response[0].content if hasattr(response[0], 'content') else str(response[0])
            elif hasattr(response, 'choices') and response.choices:
                if hasattr(response.choices[0], 'message'):
                    summary = response.choices[0].message.content
                elif hasattr(response.choices[0], 'content'):
                    summary = response.choices[0].content
                elif isinstance(response.choices[0], dict):
                    summary = response.choices[0].get('message', {}).get('content') or response.choices[0].get('content')
            elif isinstance(response, str):
                summary = response
            
            if summary:
                self.event_recorder._log_context_summary(summary, "execution_complete")
                return summary
            else:
                error_msg = f"LLM returned unexpected format. Response type: {type(response)}, Response: {str(response)[:200]}"
                logger.error(f"❌ CRITICAL ERROR - LLM summary generation failed: {error_msg}")
                logger.error("⚠️  FALLBACK ACTIVATED - This should NEVER happen. System will continue but root cause MUST be fixed.")
                return self._generate_fallback_context_summary(self.event_recorder.events, task)
        except Exception as e:
            logger.error(f"❌ CRITICAL ERROR - Failed to generate context summary: {e}", exc_info=True)
            logger.error("⚠️  FALLBACK ACTIVATED - This should NEVER happen. System will continue but root cause MUST be fixed.")
            return self._generate_fallback_context_summary(self.event_recorder.events, task)
    
    def _generate_fallback_context_summary(self, events: List[dict], task: str) -> str:
        """
        ⚠️  CRITICAL FALLBACK - This should NEVER be called in normal operation.
        
        This fallback generates a basic summary when LLM fails. It exists to prevent
        system crashes, but its usage indicates a SERIOUS ERROR that MUST be fixed.
        
        When this is called, it means:
        - LLM API call failed or returned unexpected format
        - Model client configuration may be incorrect
        - API connectivity issues
        - Response parsing logic needs fixing
        
        ROOT CAUSE MUST BE INVESTIGATED AND FIXED.
        """
        logger.error("=" * 80)
        logger.error("❌ CRITICAL ERROR: FALLBACK CONTEXT SUMMARY ACTIVATED")
        logger.error("=" * 80)
        logger.error("⚠️  THIS SHOULD NEVER HAPPEN - LLM SUMMARY GENERATION FAILED")
        logger.error(f"Task: {task}")
        logger.error(f"Events count: {len(events)}")
        logger.error("Root cause investigation REQUIRED:")
        logger.error("  1. Check LLM API connectivity and configuration")
        logger.error("  2. Verify model_client.create() response format")
        logger.error("  3. Check for API errors or timeouts")
        logger.error("  4. Review error logs above for details")
        logger.error("=" * 80)
        
        # Generate basic fallback summary
        summary_parts = [f"**TASK**: {task}\n\n"]
        summary_parts.append("⚠️ **WARNING**: LLM summary generation failed. Using basic fallback.\n\n")
        
        # Group events by agent
        by_agent = {}
        for e in events:
            agent = e.get("agent_name", "unknown")
            if agent not in by_agent:
                by_agent[agent] = []
            by_agent[agent].append(e.get("action", "unknown"))
        
        summary_parts.append("**AGENT FLOW WALKTHROUGH**:\n")
        for agent, actions in by_agent.items():
            action_counts = {}
            for a in actions:
                action_counts[a] = action_counts.get(a, 0) + 1
            summary_parts.append(f"- {agent}: {action_counts}\n")
        
        # File creations
        file_creations = [e for e in events if e.get("event_type") == "file_creation"]
        if file_creations:
            summary_parts.append("\n**FILES CREATED**:\n")
            for fc in file_creations:
                details = fc.get("details", {})
                file_path = details.get("file_path", "unknown")
                summary_parts.append(f"- {os.path.basename(file_path)} (by {fc.get('agent_name', 'unknown')})\n")
        
        summary = "".join(summary_parts)
        # Log fallback summary with error marker
        try:
            self.event_recorder._log_context_summary(summary, "execution_complete_FALLBACK_ERROR")
        except Exception as e:
            logger.error(f"Failed to log fallback summary: {e}")
        
        return summary
    
    
    async def _generate_focused_summary(self, agent_name: str, relevant_events: List[dict], 
                                       current_step: str, max_tokens: int) -> str:
        """
        Use LLM to generate focused summary from filtered events.
        
        Args:
            agent_name: Name of the agent
            relevant_events: Filtered relevant events
            current_step: Current step description
            max_tokens: Maximum tokens for summary
            
        Returns:
            Focused summary string
        """
        if not relevant_events:
            return f"No relevant events for {agent_name}."
        
        agent_role = AGENT_ROLE_DESCRIPTIONS.get(agent_name, "Agent role not specified")
        
        # Prepare events JSON (limit size to avoid token overflow)
        events_json = json.dumps(relevant_events[-20:], indent=2, ensure_ascii=False)  # Last 20 events
        
        prompt = f"""You are a context summarizer. Create a focused summary for {agent_name}.

AGENT ROLE: {agent_role}
CURRENT STEP: {current_step}
RELEVANT EVENTS: {events_json}

Create a concise summary (max {max_tokens} tokens estimated) with:
1. **CURRENT STATUS**: What step we're on, what's been accomplished
2. **AVAILABLE FILES**: Files created that this agent might need (with metadata: columns for CSV, structure for JSON)
3. **RECENT ACCOMPLISHMENTS**: What previous agents did (relevant to this agent's role)
4. **WHAT TO DO NEXT**: Based on plan and current step, what this agent should do

Be specific, actionable, and focused. Only include information relevant to {agent_name}'s role.
Keep the summary concise - aim for {max_tokens} tokens or less."""
        
        try:
            from autogen_core.models import UserMessage
            
            messages = [UserMessage(content=prompt, source="context_generator")]
            
            response = await self.model_client.create(messages=messages)
            
            # Handle response format - check for content attribute
            if response and hasattr(response, 'content'):
                summary = response.content
                return summary
            elif response and isinstance(response, list) and len(response) > 0:
                summary = response[0].content if hasattr(response[0], 'content') else str(response[0])
                return summary
            else:
                error_msg = f"LLM returned empty focused summary for {agent_name}. Response: {type(response)}"
                logger.error(f"❌ CRITICAL ERROR - LLM focused summary failed: {error_msg}")
                logger.error("⚠️  FALLBACK ACTIVATED - This should NEVER happen. System will continue but root cause MUST be fixed.")
                return self._generate_fallback_summary(agent_name, relevant_events, current_step)
        except Exception as e:
            logger.error(f"❌ CRITICAL ERROR - Failed to generate focused summary for {agent_name}: {e}", exc_info=True)
            logger.error("⚠️  FALLBACK ACTIVATED - This should NEVER happen. System will continue but root cause MUST be fixed.")
            return self._generate_fallback_summary(agent_name, relevant_events, current_step)
    
    def _generate_fallback_summary(self, agent_name: str, relevant_events: List[dict], current_step: str) -> str:
        """
        ⚠️  CRITICAL FALLBACK - This should NEVER be called in normal operation.
        
        This fallback generates a basic summary when LLM fails. It exists to prevent
        system crashes, but its usage indicates a SERIOUS ERROR that MUST be fixed.
        
        When this is called, it means:
        - LLM API call failed or returned unexpected format
        - Model client configuration may be incorrect
        - API connectivity issues
        - Response parsing logic needs fixing
        
        ROOT CAUSE MUST BE INVESTIGATED AND FIXED.
        """
        logger.error("=" * 80)
        logger.error(f"❌ CRITICAL ERROR: FALLBACK FOCUSED SUMMARY ACTIVATED for {agent_name}")
        logger.error("=" * 80)
        logger.error("⚠️  THIS SHOULD NEVER HAPPEN - LLM FOCUSED SUMMARY GENERATION FAILED")
        logger.error(f"Agent: {agent_name}")
        logger.error(f"Current step: {current_step}")
        logger.error(f"Relevant events count: {len(relevant_events)}")
        logger.error("Root cause investigation REQUIRED:")
        logger.error("  1. Check LLM API connectivity and configuration")
        logger.error("  2. Verify model_client.create() response format")
        logger.error("  3. Check for API errors or timeouts")
        logger.error("  4. Review error logs above for details")
        logger.error("=" * 80)
        
        # Generate basic fallback summary
        summary_parts = [f"**CURRENT STATUS**: {current_step}\n\n"]
        summary_parts.append(f"⚠️ **WARNING**: LLM summary generation failed for {agent_name}. Using basic fallback.\n\n")
        
        # Recent file creations
        file_creations = [e for e in relevant_events if e.get("event_type") == "file_creation"][-10:]
        if file_creations:
            summary_parts.append("**AVAILABLE FILES**:\n")
            for event in file_creations:
                details = event.get("details", {})
                file_path = details.get("file_path", "unknown")
                file_type = details.get("file_type", "unknown")
                summary_parts.append(f"- {os.path.basename(file_path)} ({file_type})\n")
            summary_parts.append("\n")
        
        # Recent accomplishments
        accomplishments = [e for e in relevant_events if e.get("event_type") == "accomplishment"][-5:]
        if accomplishments:
            summary_parts.append("**RECENT ACCOMPLISHMENTS**:\n")
            for event in accomplishments:
                details = event.get("details", {})
                acc = details.get("accomplishment", "")
                if acc:
                    summary_parts.append(f"- {acc[:100]}\n")
            summary_parts.append("\n")
        
        return "".join(summary_parts)
    
    async def get_focused_agent_context(self, agent_name: str, current_step: str = "", 
                                       max_tokens: Optional[int] = None) -> str:
        """
        Generate focused context summary for execution agents.
        
        Args:
            agent_name: Name of the agent
            current_step: Current step description
            max_tokens: Maximum tokens (defaults to AGENT_CONTEXT_LIMITS)
            
        Returns:
            Focused context summary string (1-5k tokens)
        """
        if max_tokens is None:
            max_tokens = AGENT_CONTEXT_LIMITS.get(agent_name, AGENT_CONTEXT_LIMITS["default"])
        
        # Filter relevant events
        relevant_events = filter_relevant_events(agent_name, self.event_recorder.events)
        
        if not relevant_events and not self.event_recorder.events:
            return f"**CURRENT STEP**: {current_step}\n\nNo events recorded yet."
        
        # Generate focused summary using LLM
        llm_summary = await self._generate_focused_summary(agent_name, relevant_events, current_step, max_tokens)
        
        # Get file summaries (limited)
        file_summaries = self.file_summarizer.get_file_summaries()
        
        # Format file list (compact)
        file_list = []
        for file_path, summary in list(file_summaries.items())[-10:]:  # Last 10 files
            file_name = summary.get("file_name", os.path.basename(file_path))
            file_type = summary.get("file_type", "unknown")
            content_preview = summary.get("content_preview", {})
            
            file_info = f"- {file_name} ({file_type})"
            
            # Add compact metadata
            if isinstance(content_preview, dict):
                if "columns" in content_preview:
                    file_info += f" - Columns: {content_preview['columns'][:5]}"  # First 5 columns
                elif "keys" in content_preview:
                    file_info += f" - Keys: {content_preview['keys'][:5]}"  # First 5 keys
                elif "dimensions" in content_preview:
                    file_info += f" - {content_preview['dimensions']}"
            
            file_list.append(file_info)
        
        # Combine everything
        context = f"""**EXECUTION CONTEXT SUMMARY**

**CURRENT STEP**: {current_step}

{llm_summary}

**AVAILABLE FILES**:
{chr(10).join(file_list) if file_list else "No files created yet."}
"""
        
        # Ensure we're within token limit
        estimated_tokens = estimate_tokens(context)
        if estimated_tokens > max_tokens:
            # Truncate if needed
            ratio = max_tokens / estimated_tokens
            target_length = int(len(context) * ratio * 0.9)  # 90% to be safe
            context = context[:target_length] + "\n\n[Context truncated to fit token limit]"
        
        return context
    
    def _format_complete_event_history(self) -> str:
        """
        Format complete event history for presenter context.
        
        Returns:
            Formatted event history string
        """
        events = self.event_recorder.events
        if not events:
            return "No events recorded."
        
        history_parts = []
        
        # Group events by type
        file_creations = [e for e in events if e.get("event_type") == "file_creation"]
        tool_executions = [e for e in events if e.get("event_type") == "tool_execution"]
        handoffs = [e for e in events if e.get("event_type") == "handoff"]
        accomplishments = [e for e in events if e.get("event_type") == "accomplishment"]
        
        if file_creations:
            history_parts.append("**FILE CREATIONS**:")
            for event in file_creations:
                details = event.get("details", {})
                file_path = details.get("file_path", "unknown")
                agent = event.get("agent_name", "unknown")
                timestamp = event.get("timestamp", "")
                history_parts.append(f"- {os.path.basename(file_path)} (by {agent} at {timestamp})")
            history_parts.append("")
        
        if tool_executions:
            history_parts.append("**TOOL EXECUTIONS**:")
            for event in tool_executions[-20:]:  # Last 20 tool executions
                tool_name = event.get("action", "unknown")  # Tool name is in 'action' field
                agent = event.get("agent_name", "unknown")
                history_parts.append(f"- {tool_name} (by {agent})")
            history_parts.append("")
        
        if handoffs:
            history_parts.append("**AGENT HANDOFFS**:")
            for event in handoffs:
                details = event.get("details", {})
                from_agent = details.get("from_agent", "unknown")
                to_agent = details.get("to_agent", "unknown")
                history_parts.append(f"- {from_agent} → {to_agent}")
            history_parts.append("")
        
        if accomplishments:
            history_parts.append("**ACCOMPLISHMENTS**:")
            for event in accomplishments[-15:]:  # Last 15 accomplishments
                details = event.get("details", {})
                acc = details.get("accomplishment", "")
                if acc:
                    history_parts.append(f"- {acc[:200]}")  # Truncate long accomplishments
            history_parts.append("")
        
        return "\n".join(history_parts)
    
    async def get_presenter_context(self, task: str, upload_results: dict,
                                   execution_plan: str = "", max_tokens: int = 50000) -> str:
        """
        Generate comprehensive context for presenter agent (up to 50k tokens).
        
        Args:
            task: Original task description
            upload_results: Upload results dict with SAS URLs
            execution_plan: Execution plan text (optional)
            max_tokens: Maximum tokens (default 50k for presenter)
            
        Returns:
            Comprehensive presenter context string
        """
        # Generate LLM summary with full context
        llm_summary = await self.generate_context_summary(task)
        
        # Get complete event history summary
        event_history = self._format_complete_event_history()
        
        # Get file summaries with detailed content previews
        file_summaries = self.file_summarizer.get_file_summaries()
        
        # Format file summaries with full details
        file_summary_text = "**FILES CREATED WITH CONTENT PREVIEWS**:\n\n"
        for file_path, summary in file_summaries.items():
            file_name = summary.get("file_name", os.path.basename(file_path))
            file_type = summary.get("file_type", "unknown")
            content_preview = summary.get("content_preview", {})
            
            file_summary_text += f"### {file_name} ({file_type})\n"
            
            if isinstance(content_preview, dict):
                if "columns" in content_preview:
                    # CSV file - show all columns and more sample rows
                    file_summary_text += f"- Columns: {content_preview['columns']}\n"
                    file_summary_text += f"- Row count: {content_preview['row_count']}\n"
                    file_summary_text += f"- Sample data:\n{content_preview['sample_data']}\n\n"
                elif "keys" in content_preview:
                    # JSON file - show structure and sample records
                    file_summary_text += f"- Keys: {content_preview['keys']}\n"
                    if "sample_records" in content_preview:
                        file_summary_text += f"- Sample records: {json.dumps(content_preview['sample_records'], indent=2)}\n\n"
                    elif "sample_data" in content_preview:
                        file_summary_text += f"- Sample data: {json.dumps(content_preview['sample_data'], indent=2)}\n\n"
                elif "dimensions" in content_preview:
                    # Image file - full metadata
                    file_summary_text += f"- Dimensions: {content_preview['dimensions']}\n"
                    file_summary_text += f"- Format: {content_preview.get('format', 'unknown')}\n"
                    if "mode" in content_preview:
                        file_summary_text += f"- Mode: {content_preview['mode']}\n"
                    file_summary_text += "\n"
                else:
                    file_summary_text += f"- Preview: {json.dumps(content_preview, indent=2)}\n\n"
            else:
                file_summary_text += f"- Preview: {str(content_preview)}\n\n"
        
        # Format upload results
        upload_text = "**UPLOAD RESULTS**:\n"
        if isinstance(upload_results, dict):
            upload_text += json.dumps(upload_results, indent=2)
        else:
            upload_text += str(upload_results)
        
        # Combine everything with full execution plan
        execution_plan_full = execution_plan if execution_plan else "No plan available"
        
        presenter_context = f"""**TASK**: {task}

**EXECUTION PLAN**: {execution_plan_full}

**EXECUTION SUMMARY**:
{llm_summary}

**COMPLETE EVENT HISTORY**:
{event_history}

{file_summary_text}

{upload_text}
"""
        
        # Ensure we're within token limit (but presenter gets up to 50k)
        estimated_tokens = estimate_tokens(presenter_context)
        if estimated_tokens > max_tokens:
            # If over limit, prioritize: keep task, plan, summary, files, truncate event history
            # Calculate how much we can keep
            base_size = len(f"**TASK**: {task}\n\n**EXECUTION PLAN**: {execution_plan_full}\n\n**EXECUTION SUMMARY**:\n{llm_summary}\n\n{file_summary_text}\n\n{upload_text}\n")
            available_for_history = (max_tokens * 4) - base_size  # Convert tokens to chars
            if available_for_history > 0:
                event_history = event_history[:available_for_history] + "\n\n[Event history truncated to fit token limit]"
                presenter_context = f"""**TASK**: {task}

**EXECUTION PLAN**: {execution_plan_full}

**EXECUTION SUMMARY**:
{llm_summary}

**COMPLETE EVENT HISTORY**:
{event_history}

{file_summary_text}

{upload_text}
"""
            else:
                # Even base is too large - truncate file summaries
                logger.warning(f"Presenter context exceeds {max_tokens} tokens, truncating file summaries")
                presenter_context = presenter_context[:max_tokens * 4] + "\n\n[Context truncated to fit token limit]"
        
        # Log presenter context
        self.event_recorder._log_presenter_context(presenter_context)
        
        return presenter_context
    
    def get_agent_context(self, agent_name: str, current_step: str) -> str:
        """
        Get relevant context for specific agent (legacy method - use get_focused_agent_context instead).
        
        Args:
            agent_name: Name of the agent
            current_step: Current step description
            
        Returns:
            Context string relevant to the agent
        """
        events = self.event_recorder.events
        # Filter events for this agent
        agent_events = [e for e in events if e.get("agent_name") == agent_name]
        
        if not agent_events:
            return f"No context available for {agent_name}."
        
        context_parts = [f"**AGENT CONTEXT FOR {agent_name}**:\n"]
        context_parts.append(f"Current step: {current_step}\n")
        context_parts.append(f"Recent events: {len(agent_events)} events recorded\n")
        
        # Get recent file creations by this agent
        file_creations = [e for e in agent_events if e.get("event_type") == "file_creation"]
        if file_creations:
            context_parts.append("Files created:\n")
            for event in file_creations[-5:]:  # Last 5 files
                file_path = event.get("details", {}).get("file_path", "unknown")
                context_parts.append(f"- {file_path}\n")
        
        return "".join(context_parts)

