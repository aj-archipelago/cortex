"""
LLM-powered worklog and learnings extractor.

Uses LLM to intelligently extract worklog entries and learnings from agent messages
instead of static pattern matching.
"""
import logging
from typing import Dict, Any, Optional, List
from autogen_core.models import UserMessage

logger = logging.getLogger(__name__)


async def extract_worklog_and_learnings(
    agent_name: str,
    message_content: str,
    message_type: str,
    model_client,
    task_id: str
) -> Dict[str, Any]:
    """
    Use LLM to extract worklog entry and learnings from agent message.
    
    Returns:
        {
            "worklog": {"work_type": str, "description": str, "status": str} or None,
            "learnings": [{"learning_type": str, "content": str}] or []
        }
    """
    if not model_client:
        logger.warning(f"No model_client provided for worklog extraction from {agent_name}")
        return {"worklog": None, "learnings": []}
    
    if not message_content or len(message_content) < 20:
        logger.debug(f"Message content too short ({len(message_content) if message_content else 0} chars) for {agent_name}")
        return {"worklog": None, "learnings": []}
    
    # For structured messages (FunctionCall, FunctionExecutionResult), extract meaningful content
    # The LLM will handle parsing these intelligently
    
    try:
        # Build prompt for LLM to extract worklog and learnings
        prompt = f"""Analyze this agent message and extract worklog and learnings.

Agent: {agent_name}
Message Type: {message_type}
Message Content:
{message_content[:2000]}

**IMPORTANT**: Every agent message represents work being done. ALWAYS extract a worklog entry.

Respond in JSON format:
{{
    "worklog": {{
        "work_type": "planning|code_execution|file_generation|file_upload|data_collection|validation|tool_execution|agent_action",
        "description": "EXACTLY ONE sentence (max 100 words) describing what work was done in this agent turn",
        "status": "completed|in_progress|failed"
    }},
    "learnings": [
        {{
            "learning_type": "planning_approach|code_generation|presentation_approach|data_source|problem_solving|decision|best_practice",
            "content": "Learning content (1-2 sentences)"
        }}
    ] or [] if no learnings
}}

**CRITICAL RULES**:
- ALWAYS provide a worklog entry - every agent message represents work
- Description MUST be exactly ONE sentence (max 100 words, no semicolons, no "and then", no multiple clauses)
- If multiple files were created, summarize as "Generated X files: file1, file2, file3" (don't list each file separately)
- If multiple tools were executed, summarize the overall action in one sentence
- For TextMessage: One sentence about what the agent communicated or decided
- For ToolCallExecutionEvent: One sentence about what tool was executed and the key result (e.g., "Executed code to generate sales data CSV and three charts")
- For ToolCallRequestEvent: One sentence about what tool is being requested (e.g., "Requesting file list to identify deliverables")
- Keep it concise: focus on the main action, not implementation details
- Examples:
  * Good: "Generated 100-row sales dataset CSV and three visualization charts"
  * Bad: "Created sales_data.csv, then created sales_summary.csv, then created sales_over_time.png, then created revenue_by_product.png"
  * Good: "Uploaded all generated files to cloud storage and obtained download URLs"
  * Bad: "Uploaded sales_data.csv, uploaded sales_summary.csv, uploaded sales_over_time.png" """

        # Call LLM
        response = await model_client.create(
            messages=[UserMessage(content=prompt, source="worklog_extractor")]
        )
        
        # Extract JSON from response using centralized utility
        from util.json_extractor import extract_json_from_model_response
        
        # Debug: Log raw response for troubleshooting
        logger.debug(f"Raw LLM response type: {type(response)}")
        if hasattr(response, 'content') and response.content:
            logger.debug(f"Response content type: {type(response.content)}, length: {len(response.content) if isinstance(response.content, list) else 'N/A'}")
            if isinstance(response.content, list) and len(response.content) > 0:
                first_item = response.content[0]
                logger.debug(f"First content item type: {type(first_item)}")
                if hasattr(first_item, 'text'):
                    logger.debug(f"Response text preview: {first_item.text[:200]}...")
        
        result = extract_json_from_model_response(response, expected_type=dict, log_errors=True)
        
        if result:
            # Handle both dict and list responses (defensive)
            if isinstance(result, dict):
                worklog = result.get("worklog")
                learnings = result.get("learnings", [])
            else:
                # If result is not a dict (e.g., list), treat as no extraction
                logger.warning(f"LLM returned non-dict result for {agent_name}: {type(result).__name__}")
                worklog = None
                learnings = []
            
            # Validate worklog structure
            if worklog and isinstance(worklog, dict):
                if not worklog.get("description"):
                    logger.warning(f"LLM returned worklog without description for {agent_name}")
                    worklog = None
                else:
                    logger.debug(f"✅ Worklog extracted for {agent_name}: {worklog.get('description', '')[:60]}...")
            
            return {
                "worklog": worklog,
                "learnings": learnings if isinstance(learnings, list) else []
            }
        else:
            logger.debug(f"⚠️  JSON extraction returned None for {agent_name} ({message_type})")
            return {"worklog": None, "learnings": []}
            
    except Exception as e:
        logger.warning(f"Failed to extract worklog/learnings via LLM: {e}")
        return {"worklog": None, "learnings": []}
