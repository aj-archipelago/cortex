import logging
from context.cognitive_analyzer import get_cognitive_analyzer

logger = logging.getLogger(__name__)

class MessageProcessor:
    """
    Handles processing and analysis of agent messages from SelectorGroupChat results.
    """

    def __init__(self, context_memory, gpt41_model_client, progress_handler):
        self.context_memory = context_memory
        self.gpt41_model_client = gpt41_model_client
        self.progress_handler = progress_handler
        self.logger = logging.getLogger(__name__)

    async def process_agent_messages(self, result, task_id: str):
        """Process and log all messages from a SelectorGroupChat result."""
        self.logger.info(f"🧠 MESSAGE PROCESSOR: Starting to process {len(result.messages) if hasattr(result, 'messages') else 0} messages for task {task_id}")

        if not hasattr(result, 'messages') or not result.messages:
            self.logger.warning(f"🧠 MESSAGE PROCESSOR: No messages to process for task {task_id}")
            return

        self.logger.info(f"🧠 MESSAGE PROCESSOR: Processing {len(result.messages)} messages")

        for message in result.messages:
                    source = getattr(message, "source", None)
                    content = getattr(message, "content", None)

                    # Extract readable content from different message types
                    content_str = self._extract_message_content(content)

                    if source and content:
                        # Log to context memory for JSONL logging
                        if self.context_memory:
                            self.context_memory.record_message(
                                agent_name=source,
                                message_type="agent_response",
                                content=content_str,
                                metadata={"task_id": task_id, "phase": "execution"}
                            )
                            
                            # Detect file creation markers ("📁 Ready for upload: path")
                            import re
                            import os
                            upload_markers = re.findall(r'📁\s*Ready for upload:\s*(.+)', content_str)
                            # Track already processed files to avoid duplicates
                            processed_files = set()
                            
                            for file_path in upload_markers:
                                file_path = file_path.strip()
                                if not file_path:
                                    continue
                                
                                # Normalize path: handle relative paths by making absolute
                                if not os.path.isabs(file_path):
                                    # Try relative to work_dir if available
                                    if hasattr(self.context_memory, 'work_dir'):
                                        file_path = os.path.join(self.context_memory.work_dir, file_path)
                                    else:
                                        # Try current working directory
                                        file_path = os.path.abspath(file_path)
                                
                                # Normalize path (resolve symlinks, etc.)
                                try:
                                    file_path = os.path.normpath(file_path)
                                except Exception:
                                    pass
                                
                                # Skip if already processed
                                if file_path in processed_files:
                                    continue
                                
                                if os.path.exists(file_path):
                                    try:
                                        processed_files.add(file_path)
                                        
                                        # Determine file type from extension
                                        _, ext = os.path.splitext(file_path)
                                        file_type = ext[1:] if ext.startswith('.') else ext
                                        
                                        # Simple content summary
                                        file_size = os.path.getsize(file_path)
                                        content_summary = f"File size: {file_size} bytes"
                                        
                                        # Record file creation (this will auto-log to worklog)
                                        self.context_memory.record_file_creation(
                                            file_path,
                                            file_type,
                                            content_summary,
                                            {"file_size": file_size},
                                            source
                                        )
                                        self.logger.info(f"📁 Recorded file creation: {os.path.basename(file_path)} by {source}")
                                    except Exception as e:
                                        self.logger.warning(f"Failed to record file creation for {file_path}: {e}")
                                else:
                                    self.logger.debug(f"File path from marker doesn't exist: {file_path}")

                            # Log agent action for tracking
                            self.context_memory.record_agent_action(
                                agent_name=source,
                                action_type="message_response",
                                details={
                                    "message_type": "response",
                                    "content_length": len(content_str),
                                    "content_preview": content_str[:200],
                                    "has_function_call": "[FunctionCall(" in content_str,
                                    "has_tool_result": "[FunctionExecutionResult(" in content_str,
                                    "turn_number": len(result.messages)
                                },
                                metadata={"task_id": task_id, "phase": "execution", "message_index": len(result.messages)}
                            )

                        # Deep cognitive analysis for walkthrough logging (non-blocking)
                        try:
                            await self._perform_cognitive_analysis(content_str, source, task_id)
                        except Exception as e:
                            self.logger.warning(f"🚨 COGNITIVE ANALYSIS COMPLETELY FAILED for {source}: {str(e)} - Continuing execution")

                    # Log internal progress and report user progress
                    self.progress_handler.log_internal_progress(task_id, content, source)
                    await self.progress_handler.report_user_progress(task_id, content_str, percentage=0.0, source=source)

                    if "__TASK_COMPLETELY_FINISHED__" in content_str:
                        self.logger.info(f"✅ TASK COMPLETE: Execution phase finished by {source}")

    def _extract_message_content(self, content) -> str:
        """Extract readable content from different message content types."""
        if isinstance(content, dict):
            if 'text' in content:
                return content['text']
            elif 'arguments' in content:
                return f"Function call with arguments: {content.get('name', 'unknown')}"
            else:
                return str(content)
        elif isinstance(content, str):
            return content
        else:
            return str(content) if content is not None else ""

    async def _perform_cognitive_analysis(self, content_str: str, source: str, task_id: str):
        """Perform deep cognitive analysis and log walkthrough if applicable."""
        try:
            self.logger.info(f"🧠 COGNITIVE ANALYSIS: Starting for {source}, content length: {len(content_str)}")
            cognitive_analyzer = get_cognitive_analyzer(self.gpt41_model_client)
            self.logger.debug(f"🧠 DEEP ANALYSIS: Got analyzer for {source}")

            cognitive_analysis = await cognitive_analyzer.analyze_deep_cognitive(
                content_str, source, task_id
            )

            self.logger.info(f"🧠 COGNITIVE ANALYSIS: Got result for {source}: is_cognitive={cognitive_analysis.get('is_cognitive', False)}, type={cognitive_analysis.get('cognitive_type', 'unknown')}")

            if cognitive_analysis.get("is_cognitive", False):
                self.logger.info(f"📝 LOGGING: Recording cognitive walkthrough for {source} ({cognitive_analysis.get('cognitive_type', 'unknown')})")

                # Create rich walkthrough entry with cognitive metadata
                metadata = {
                    "task_id": task_id,
                    "phase": "execution",
                    "content_length": len(content_str),
                    "timestamp": cognitive_analysis.get("timestamp"),
                    "analysis_method": "deep_cognitive_llm",
                    "cognitive_type": cognitive_analysis.get("cognitive_type", "unknown"),
                    "journey_stage": cognitive_analysis.get("journey_stage", "unknown"),
                    "confidence_score": cognitive_analysis.get("confidence_score", 0.0),
                    "emotional_tone": cognitive_analysis.get("emotional_tone", "neutral"),
                    "learning_value": cognitive_analysis.get("learning_value", "unknown"),
                    "reasoning_depth": cognitive_analysis.get("reasoning_depth", "unknown"),
                    "key_insights": cognitive_analysis.get("key_insights", []),
                    "decision_points": cognitive_analysis.get("decision_points", []),
                    "challenges_identified": cognitive_analysis.get("challenges_identified", []),
                    "solutions_attempted": cognitive_analysis.get("solutions_attempted", [])
                }

                try:
                    # Log as decision with cognitive insights
                    self.context_memory.record_decision(
                        agent_name=source,
                        decision=f"Agent {source} demonstrated {cognitive_analysis.get('cognitive_type', 'cognitive_activity')}",
                        reasoning=content_str[:1000],
                        alternatives=cognitive_analysis.get('solutions_attempted', [])
                    )
                    # Also log to worklog for cognitive work
                    self.context_memory.log_worklog(
                        source, "cognitive_analysis",
                        f"Cognitive activity: {cognitive_analysis.get('cognitive_type', 'unknown')}",
                        status="completed",
                        metadata=metadata
                    )
                    self.logger.info(f"✅ LOGGING: Cognitive analysis recorded for {source} with {len(cognitive_analysis.get('key_insights', []))} insights")
                except Exception as e:
                    self.logger.error(f"❌ COGNITIVE RECORDING FAILED for {source}: {e}")

        except Exception as e:
            self.logger.warning(f"⚠️ COGNITIVE ANALYSIS SKIPPED for {source}: {str(e)}")
            self.logger.debug(f"   Content preview: {content_str[:100]}...")
