"""
Event recording and logging functionality for context memory system.

Handles all event recording methods and JSONL file logging.
"""
import json
import os
import logging
from datetime import datetime
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)


class EventRecorder:
    """
    Handles recording of agent events and logging to JSONL files.
    """
    
    def __init__(self, work_dir: str, request_id: str):
        """
        Initialize EventRecorder.
        
        Args:
            work_dir: Working directory for this request
            request_id: Unique request/task identifier
        """
        self.work_dir = work_dir
        self.request_id = request_id
        
        # Ensure logs directory exists
        self.logs_dir = os.path.join(work_dir, "logs")
        os.makedirs(self.logs_dir, exist_ok=True)
        
        # JSONL log files (no .log files)
        self.events_file = os.path.join(self.logs_dir, "events.jsonl")
        self.messages_file = os.path.join(self.logs_dir, "messages.jsonl")
        self.context_summary_file = os.path.join(self.logs_dir, "context_summary.jsonl")
        self.presenter_context_file = os.path.join(self.logs_dir, "presenter_context.jsonl")
        self.worklog_file = os.path.join(self.logs_dir, "worklog.jsonl")
        self.learnings_file = os.path.join(self.logs_dir, "learnings.jsonl")
        
        # Initialize learnings.jsonl file (create empty file if doesn't exist)
        # This ensures the file always exists even if no learnings are logged
        if not os.path.exists(self.learnings_file):
            try:
                with open(self.learnings_file, 'w', encoding='utf-8') as f:
                    pass  # Create empty file
            except Exception as e:
                logger.warning(f"Failed to initialize learnings.jsonl: {e}")
        
        # In-memory event storage for quick access
        self.events = []
        self._load_events()
        
        # Track files that have already been logged to prevent duplicates
        # Key: normalized file path, Value: timestamp of first logging
        self._logged_files = {}
        self._load_logged_files()
    
    def _load_events(self):
        """Load existing events from JSONL file."""
        if os.path.exists(self.events_file):
            try:
                with open(self.events_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                event = json.loads(line)
                                self.events.append(event)
                            except json.JSONDecodeError as e:
                                logger.warning(f"Failed to parse event line: {e}")
            except Exception as e:
                logger.warning(f"Failed to load events: {e}")
    
    def _load_logged_files(self):
        """Load already-logged files from existing events to prevent duplicates."""
        for event in self.events:
            if event.get("event_type") == "file_creation":
                file_path = event.get("details", {}).get("file_path")
                if file_path:
                    # Normalize path for consistent tracking
                    try:
                        normalized_path = os.path.normpath(file_path)
                        if normalized_path not in self._logged_files:
                            self._logged_files[normalized_path] = event.get("timestamp")
                    except Exception:
                        pass
    
    def _save_event(self, event: dict):
        """Append event to JSONL file."""
        try:
            with open(self.events_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(event, ensure_ascii=False) + '\n')
            self.events.append(event)
        except Exception as e:
            logger.error(f"Failed to save event: {e}")
    
    def _log_message(self, agent_name: str, message_type: str, content: str, metadata: dict = None):
        """Log message to messages.jsonl (JSONL format)."""
        try:
            message_entry = {
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "message_type": message_type,
                "content": str(content),
                "metadata": metadata or {}
            }
            with open(self.messages_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(message_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to log message: {e}")
    
    def _log_context_summary(self, summary: str, summary_type: str = "execution_complete"):
        """Write context summary to context_summary.jsonl (JSONL format)."""
        try:
            summary_entry = {
                "timestamp": datetime.now().isoformat(),
                "summary_type": summary_type,
                "content": summary,
                "metadata": {
                    "request_id": self.request_id,
                    "phase": "execution" if summary_type == "execution_complete" else "presentation"
                }
            }
            with open(self.context_summary_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(summary_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to log context summary: {e}")
    
    def _log_presenter_context(self, context: str):
        """Write presenter context to presenter_context.jsonl (JSONL format)."""
        try:
            context_entry = {
                "timestamp": datetime.now().isoformat(),
                "summary_type": "presenter_context",
                "content": context,
                "metadata": {
                    "request_id": self.request_id,
                    "phase": "presentation"
                }
            }
            with open(self.presenter_context_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(context_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to log presenter context: {e}")
    
    def record_agent_action(self, agent_name: str, action_type: str,
                           details: dict, result: dict = None,
                           metadata: dict = None):
        """Record structured agent action."""
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "agent_action",
            "agent_name": agent_name,
            "action": action_type,
            "details": details,
            "result": result,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id,
                **(metadata or {})
            }
        }
        self._save_event(event)
    
    def record_file_creation(self, file_path: str, file_type: str,
                           content_summary: str, metadata: dict,
                           agent_name: str):
        """Record file creation with content preview. Skips if file was already logged."""
        # Normalize path for consistent tracking
        try:
            normalized_path = os.path.normpath(file_path)
        except Exception:
            normalized_path = file_path
        
        # Check if this file was already logged
        if normalized_path in self._logged_files:
            logger.debug(f"⏭️  Skipping duplicate file creation log for {os.path.basename(file_path)} (already logged at {self._logged_files[normalized_path]})")
            return
        
        # Record the file as logged
        timestamp = datetime.now().isoformat()
        self._logged_files[normalized_path] = timestamp
        
        event = {
            "timestamp": timestamp,
            "event_type": "file_creation",
            "agent_name": agent_name,
            "action": "file_created",
            "details": {
                "file_path": file_path,
                "file_type": file_type,
                "content_summary": content_summary,
                **metadata
            },
            "result": None,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id
            }
        }
        self._save_event(event)
        # Note: File creation is tracked in events.jsonl, but NOT logged to worklog.jsonl
        # Worklog entries are created by LLM extraction from agent messages (one per agent turn)
        # This prevents duplicate worklog entries and ensures one sentence per agent turn
    
    def record_tool_execution(self, agent_name: str, tool_name: str,
                             input_params: dict, output_result: dict,
                             success: bool):
        """Record tool execution."""
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "tool_execution",
            "agent_name": agent_name,
            "action": tool_name,
            "details": {
                "input_params": input_params,
                "success": success
            },
            "result": output_result,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id
            }
        }
        self._save_event(event)
    
    def record_handoff(self, from_agent: str, to_agent: str,
                      reason: str, context: str):
        """Record agent handoff."""
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "handoff",
            "agent_name": from_agent,
            "action": "handoff",
            "details": {
                "from_agent": from_agent,
                "to_agent": to_agent,
                "reason": reason,
                "context": context
            },
            "result": None,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id
            }
        }
        self._save_event(event)
    
    def record_accomplishment(self, agent_name: str, accomplishment: str,
                            evidence: list, context: str):
        """Record accomplishment with evidence."""
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "accomplishment",
            "agent_name": agent_name,
            "action": "accomplishment",
            "details": {
                "accomplishment": accomplishment,
                "evidence": evidence,
                "context": context
            },
            "result": None,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id
            }
        }
        self._save_event(event)
        # Also log to worklog
        self.log_worklog(
            agent_name, "accomplishment", accomplishment,
            status="completed",
            metadata={"evidence": evidence, "context": context}
        )
    
    def record_decision(self, agent_name: str, decision: str,
                       reasoning: str, alternatives: list):
        """Record important decision."""
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "decision",
            "agent_name": agent_name,
            "action": "decision_made",
            "details": {
                "decision": decision,
                "reasoning": reasoning,
                "alternatives_considered": alternatives
            },
            "result": None,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id
            }
        }
        self._save_event(event)
    
    def record_error(self, agent_name: str, error_type: str,
                    error_message: str, recovery_action: str):
        """Record error and recovery."""
        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": "error",
            "agent_name": agent_name,
            "action": "error_occurred",
            "details": {
                "error_type": error_type,
                "error_message": error_message,
                "recovery_action": recovery_action
            },
            "result": None,
            "metadata": {
                "work_dir": self.work_dir,
                "request_id": self.request_id
            }
        }
        self._save_event(event)
    
    def record_message(self, agent_name: str, message_type: str,
                      content: str, metadata: dict = None):
        """Record message (input/output/tool_call)."""
        self._log_message(agent_name, message_type, content, metadata)
    
    def log_worklog(self, agent_name: str, work_type: str, description: str,
                   status: str = "in_progress", metadata: dict = None, details: dict = None):
        """
        Log worklog entry - tracks work done, accomplishments, progress.
        
        Args:
            agent_name: Agent performing the work
            work_type: Type of work (e.g., "accomplishment", "file_creation", "data_processing", "tool_execution")
            description: Description of work done
            status: Status of work ("in_progress", "completed", "failed")
            metadata: Additional metadata (files created, data processed, etc.)
            details: Structured details (SQL queries, code patterns, errors, data sources, tools used) for brain learning
        """
        try:
            worklog_entry = {
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "work_type": work_type,
                "description": description,
                "status": status,
                "metadata": {
                    "request_id": self.request_id,
                    "work_dir": self.work_dir,
                    **(metadata or {})
                }
            }
            # Add structured details if provided (for brain learning generation)
            if details:
                worklog_entry["details"] = details
            
            with open(self.worklog_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(worklog_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to log worklog: {e}")
    
    def log_learning(self, learning_type: str, content: str, source: str = "system",
                    success_score: float = None, metadata: dict = None, details: dict = None):
        """
        Log learning entry - tracks extracted learnings, best practices, insights.
        
        Args:
            learning_type: Type of learning (e.g., "best_practice", "antipattern", "insight", "recovery_strategy")
            content: Learning content/text
            source: Source of learning (e.g., "system", "azure_search", "task_execution")
            success_score: Success score of the task that generated this learning (if applicable)
            metadata: Additional metadata (task_id, similar_tasks, etc.)
            details: Structured details (what_worked, what_failed, breakthrough) for brain learning
        """
        try:
            learning_entry = {
                "timestamp": datetime.now().isoformat(),
                "learning_type": learning_type,
                "content": content,
                "source": source,
                "metadata": {
                    "request_id": self.request_id,
                    "work_dir": self.work_dir,
                    **(metadata or {})
                }
            }
            # Add structured details if provided (for brain learning generation)
            if details:
                learning_entry["details"] = details
            
            if success_score is not None:
                learning_entry["success_score"] = success_score
            
            with open(self.learnings_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(learning_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to log learning: {e}")

