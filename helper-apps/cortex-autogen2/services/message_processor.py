"""
Message Processing Service

LLM-powered message processing for worklog, learnings, and file detection.
No static code - everything uses LLM intelligence.
"""

import logging
import os
import re
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


async def process_message(
    message: Any,
    context_memory: Optional[object],
    model_client_for_processing: Optional[object],
    task_id: Optional[str],
    work_dir: Optional[str],
    messages_file_path: Optional[str] = None  # Deprecated - EventRecorder handles this
) -> Dict[str, Any]:
    """
    Process a single message through the full pipeline:
    - Record to context_memory (EventRecorder saves to messages.jsonl)
    - Extract worklog/learnings via LLM
    - Detect files via LLM
    - Return processing results
    
    Returns dict with: processed, worklog_added, learnings_added, files_detected
    """
    result = {
        "processed": False,
        "worklog_added": False,
        "learnings_added": 0,
        "files_detected": []
    }
    
    if not message:
        return result
    
    # Extract message metadata
    message_content = getattr(message, "content", "")
    message_source = getattr(message, "source", "unknown")
    message_type = type(message).__name__
    
    # Convert content to string
    content_str = str(message_content) if message_content else ""
    
    if not content_str:
        return result
    
    # Process through context_memory (this will save to messages.jsonl via EventRecorder)
    if not context_memory or not message_source:
        return result
    
    try:
        # Record message (EventRecorder handles messages.jsonl saving)
        # Use actual message_type, not hardcoded "agent_response"
        context_memory.record_message(
            agent_name=message_source,
            message_type=message_type,  # Use actual message type
            content=content_str,
            metadata={"task_id": task_id, "phase": "execution"}
        )
        
        # LLM-powered worklog/learnings extraction
        # Process TextMessage, ToolCallExecutionEvent, and other meaningful message types
        # Skip ToolCallRequestEvent (just requests, not actual work) and system messages
        should_extract = (
            model_client_for_processing 
            and len(content_str) >= 20
            and message_type != "ToolCallRequestEvent"  # Skip tool requests, process results
            and message_source != "system"  # Skip system messages (handled separately)
            and message_source != "user"  # Skip user messages
        )
        
        if not model_client_for_processing:
            logger.debug(f"⚠️  No model_client_for_processing for {message_source} ({message_type}) - skipping extraction")
        elif len(content_str) < 20:
            logger.debug(f"⚠️  Content too short ({len(content_str)} chars) for {message_source} ({message_type}) - skipping extraction")
        elif message_type == "ToolCallRequestEvent":
            logger.debug(f"⚠️  Skipping ToolCallRequestEvent for {message_source} - will process ToolCallExecutionEvent instead")
        elif message_source in ["system", "user"]:
            logger.debug(f"⚠️  Skipping {message_source} message - handled separately")
        
        if should_extract:
            logger.debug(f"🔍 Extracting worklog/learnings for {message_source} ({message_type}, {len(content_str)} chars)")
            try:
                from services.worklog_learnings_extractor import extract_worklog_and_learnings
                extraction_result = await extract_worklog_and_learnings(
                    agent_name=message_source,
                    message_content=content_str,
                    message_type=message_type,
                    model_client=model_client_for_processing,
                    task_id=task_id
                )
                
                # Log worklog if extracted (LLM always works!)
                worklog = extraction_result.get("worklog")
                if worklog:
                    # Extract structured details for brain learning generation
                    details = worklog.get("details", {})
                    context_memory.log_worklog(
                        message_source,
                        worklog.get("work_type", "agent_action"),
                        worklog.get("description", "Agent performed work"),
                        status=worklog.get("status", "completed"),
                        metadata={"task_id": task_id, "message_type": message_type},
                        details=details if details else None  # Pass structured details
                    )
                    result["worklog_added"] = True
                    logger.debug(f"✅ Worklog extracted for {message_source}: {worklog.get('description', '')[:50]}...")
                else:
                    logger.debug(f"⚠️  No worklog extracted for {message_source} ({message_type}) - LLM returned None")
                
                # Log learnings if extracted
                learnings_count = 0
                for learning in extraction_result.get("learnings", []):
                    # Extract structured details for brain learning generation
                    learning_details = learning.get("details", {})
                    context_memory.log_learning(
                        learning_type=learning.get("learning_type", "insight"),
                        content=learning.get("content", ""),
                        source=message_source,
                        metadata={"task_id": task_id},
                        details=learning_details if learning_details else None  # Pass structured details
                    )
                    learnings_count += 1
                result["learnings_added"] = learnings_count
                if learnings_count > 0:
                    logger.debug(f"✅ {learnings_count} learning(s) extracted for {message_source}")
                
            except Exception as e:
                logger.warning(f"LLM extraction failed for {message_source}: {e}", exc_info=True)
        elif not model_client_for_processing and message_source not in ["system", "user"]:
            logger.debug(f"LLM not available for {message_source} - skipping worklog/learnings extraction")
        
        # LLM-powered file detection (instead of static regex)
        files_detected = await detect_files_in_message(
            content_str, message_source, context_memory, task_id, work_dir, model_client_for_processing
        )
        result["files_detected"] = files_detected
        
        result["processed"] = True
        
    except Exception as e:
        logger.warning(f"Failed to process message: {e}")
    
    return result


async def detect_files_in_message(
    content_str: str,
    message_source: str,
    context_memory: object,
    task_id: Optional[str],
    work_dir: Optional[str],
    model_client: Optional[object]
) -> list:
    """
    LLM-powered file detection from message content.
    Returns list of detected file paths.
    """
    detected_files = []
    
    if not content_str or not model_client:
        return detected_files
    
    try:
        # Use LLM to detect file paths and creation markers intelligently
        prompt = f"""Analyze this message from {message_source} and detect any file paths or file creation indicators.

Message content:
{content_str[:2000]}

Extract:
1. File paths mentioned (absolute or relative)
2. File creation markers (e.g., "Ready for upload", "Created file", "Generated")
3. Any file references

Return JSON with:
{{
  "files": ["/path/to/file1", "/path/to/file2"],
  "markers": ["Ready for upload: /path/to/file"]
}}

If no files detected, return {{"files": [], "markers": []}}
"""
        
        from autogen_core.models import UserMessage
        response = await model_client.create([UserMessage(content=prompt, source="file_detector")])
        
        # Extract JSON using centralized utility
        from util.json_extractor import extract_json_from_model_response
        
        file_data = extract_json_from_model_response(response, expected_type=dict, log_errors=True)
        detected_paths = []
        
        if file_data:
            detected_paths = file_data.get("files", [])
            markers = file_data.get("markers", [])
            
            # Also check markers for file paths
            for marker in markers:
                path_match = re.search(r'[^\s:]+\.(csv|json|xlsx|pptx|pdf|png|jpg|jpeg|txt|py|html|xml)', marker, re.IGNORECASE)
                if path_match:
                    detected_paths.append(marker.split(':')[-1].strip() if ':' in marker else marker.strip())
    
    except Exception as e:
        logger.warning(f"LLM file detection failed for {message_source}: {e}")
        detected_paths = []
    
    # Process detected file paths
    processed_files = set()
    for file_path in detected_paths:
        if not file_path:
            continue
        
        # Normalize path
        if not os.path.isabs(file_path):
            if work_dir:
                file_path = os.path.join(work_dir, file_path)
            else:
                file_path = os.path.abspath(file_path)
        
        try:
            file_path = os.path.normpath(file_path)
        except Exception:
            continue
        
        if file_path in processed_files:
            continue
        
        if os.path.exists(file_path):
            try:
                processed_files.add(file_path)
                detected_files.append(file_path)
                
                # Determine file type
                _, ext = os.path.splitext(file_path)
                file_type = ext[1:] if ext.startswith('.') else ext
                
                # Record file creation
                file_size = os.path.getsize(file_path)
                content_summary = f"File size: {file_size} bytes"
                
                context_memory.record_file_creation(
                    file_path,
                    file_type,
                    content_summary,
                    {"file_size": file_size},
                    message_source
                )
                logger.info(f"📁 Recorded file creation: {os.path.basename(file_path)} by {message_source}")
            except Exception as e:
                logger.warning(f"Failed to record file creation for {file_path}: {e}")
    
    return detected_files
