"""
Context Memory Manager - Unified context/memory system for tracking agent actions.

Tracks structured events in JSONL format, uses LLM for intelligent summarization,
and provides rich context to presenter agent.

This is the main orchestrator class that delegates to specialized modules.
"""
from .event_recorder import EventRecorder
from .file_summaries import FileSummarizer
from .context_generator import ContextGenerator


class ContextMemory:
    """
    Centralized context tracking, summarization, and memory management.
    
    All logging uses JSONL format exclusively - no .log files.
    
    This class orchestrates EventRecorder, FileSummarizer, and ContextGenerator
    to provide a unified interface for context management.
    """
    
    def __init__(self, work_dir: str, model_client, request_id: str):
        """
        Initialize ContextMemory.
        
        Args:
            work_dir: Working directory for this request (e.g., /tmp/coding/req_{task_id})
            model_client: LLM client for summarization (OpenAIChatCompletionClient)
            request_id: Unique request/task identifier
        """
        self.work_dir = work_dir
        self.model_client = model_client
        self.request_id = request_id
        
        # Initialize component modules
        self.event_recorder = EventRecorder(work_dir, request_id)
        self.file_summarizer = FileSummarizer(work_dir)
        self.context_generator = ContextGenerator(model_client, self.event_recorder, self.file_summarizer)
    
    # Delegate event recording methods to EventRecorder
    def record_agent_action(self, agent_name: str, action_type: str,
                           details: dict, result: dict = None,
                           metadata: dict = None):
        """Record structured agent action."""
        self.event_recorder.record_agent_action(agent_name, action_type, details, result, metadata)
    
    def record_file_creation(self, file_path: str, file_type: str,
                           content_summary: str, metadata: dict,
                           agent_name: str):
        """Record file creation with content preview."""
        self.event_recorder.record_file_creation(file_path, file_type, content_summary, metadata, agent_name)
    
    def record_tool_execution(self, agent_name: str, tool_name: str,
                             input_params: dict, output_result: dict,
                             success: bool):
        """Record tool execution."""
        self.event_recorder.record_tool_execution(agent_name, tool_name, input_params, output_result, success)
    
    def record_handoff(self, from_agent: str, to_agent: str,
                      reason: str, context: str):
        """Record agent handoff."""
        self.event_recorder.record_handoff(from_agent, to_agent, reason, context)
    
    def record_accomplishment(self, agent_name: str, accomplishment: str,
                            evidence: list, context: str):
        """Record accomplishment with evidence."""
        self.event_recorder.record_accomplishment(agent_name, accomplishment, evidence, context)
    
    def record_decision(self, agent_name: str, decision: str,
                       reasoning: str, alternatives: list):
        """Record important decision."""
        self.event_recorder.record_decision(agent_name, decision, reasoning, alternatives)
    
    def record_error(self, agent_name: str, error_type: str,
                    error_message: str, recovery_action: str):
        """Record error and recovery."""
        self.event_recorder.record_error(agent_name, error_type, error_message, recovery_action)
    
    def record_message(self, agent_name: str, message_type: str,
                      content: str, metadata: dict = None):
        """Record message (input/output/tool_call)."""
        self.event_recorder.record_message(agent_name, message_type, content, metadata)
    
    # Delegate file summary methods to FileSummarizer
    def get_file_summaries(self) -> dict:
        """Extract and summarize all created files with content previews."""
        return self.file_summarizer.get_file_summaries()
    
    # Delegate context generation methods to ContextGenerator
    async def generate_context_summary(self, task: str) -> str:
        """Use LLM to generate intelligent summary from all events."""
        return await self.context_generator.generate_context_summary(task)
    
    async def get_presenter_context(self, task: str, upload_results: dict,
                                   execution_plan: str = "", max_tokens: int = 50000) -> str:
        """Generate comprehensive context for presenter agent (up to 50k tokens)."""
        return await self.context_generator.get_presenter_context(task, upload_results, execution_plan, max_tokens)
    
    # Delegate worklog and learning logging methods
    def log_worklog(self, agent_name: str, work_type: str, description: str,
                   status: str = "in_progress", metadata: dict = None, details: dict = None):
        """Log worklog entry with optional structured details."""
        self.event_recorder.log_worklog(agent_name, work_type, description, status, metadata, details)
    
    def log_learning(self, learning_type: str, content: str, source: str = "system",
                    success_score: float = None, metadata: dict = None, details: dict = None):
        """Log learning entry with optional structured details."""
        self.event_recorder.log_learning(learning_type, content, source, success_score, metadata, details)
    
    async def get_focused_agent_context(self, agent_name: str, current_step: str = "", 
                                       max_tokens: int = None) -> str:
        """Generate focused context summary for execution agents."""
        return await self.context_generator.get_focused_agent_context(agent_name, current_step, max_tokens)
    
    def get_agent_context(self, agent_name: str, current_step: str) -> str:
        """Get relevant context for specific agent (legacy method)."""
        return self.context_generator.get_agent_context(agent_name, current_step)
    
    # Expose events for backward compatibility
    @property
    def events(self):
        """Access events list (for backward compatibility)."""
        return self.event_recorder.events
