"""
Simplified Agent Factory for Open Source Version

Creates only the 4 core agents: planner, coder, presenter, execution_completion_verifier
"""

from autogen_agentchat.agents import AssistantAgent
import os
from typing import Optional
from tools.file_tools import get_file_tools
from tools.upload_tools import upload_tool, get_upload_tool
from tools.coding_tools import get_code_execution_tool
from ..planner_agent import get_planner_system_message
from ..coder_agent import get_coder_system_message
from ..presenter_agent import get_presenter_system_message
from ..execution_completion_verifier_agent import get_execution_completion_verifier_system_message
from .helpers import create_request_context_vars
from tools.presenter_tools import read_file_tool, get_read_file_tool
from tools.url_validation_tools import url_validation_tool

from ..constants import (
    BASE_AUTONOMOUS_OPERATION,
    REQUEST_CONTEXT_HEADER,
    AUTONOMOUS_EXECUTION_HEADER,
    TASK_COMPLEXITY_GUIDANCE,
    FORBIDDEN_PHRASES_COMPONENT,
    KEY_INSIGHTS_GUIDANCE,
    WORK_DIR_USAGE,
    UPLOAD_MARKER_INSTRUCTIONS,
    FILE_VERIFICATION_INSTRUCTIONS,
    EMPTY_DATA_VALIDATION_CODER,
    ERROR_RECOVERY_FRAMEWORK,
    PROGRESS_LOGGING_FRAMEWORK,
    TOOL_FAILURE_DETECTION_GUIDANCE,
    TIMEOUT_HANDLING_GUIDANCE,
    LOOP_DETECTION_GUIDANCE,
    WORKSPACE_STATE_AWARENESS,
    OUTPUT_ONLY_FINAL_RESULTS_PRINCIPLE,
    DEPENDENCY_WAITING_PRINCIPLE,
    UNIVERSAL_REQUIREMENT_EXTRACTION_FRAMEWORK,
    VISUAL_GUIDANCE_PLANNING,
    VALUE_CREATION_FRAMEWORK,
    DELIVERABLE_LINK_POLICY,
    CIRCUIT_BREAKER_GUIDANCE,
    FILE_CONTRACT_GUIDANCE,
    WORKFLOW_COORDINATION_GUIDANCE,
    DATA_QUALITY_GUIDANCE,
    format_global_expectations_for_agent,
)
from ..constants.agent_intelligence import DEEP_STRATEGIC_THINKING


from logging import getLogger
logger = getLogger(__name__)


def get_base_system_message(request_id: str = "unknown", work_dir: str = "") -> str:
    """Get the base system message components that are common to all agents."""
    from datetime import datetime

    # Get current datetime for agent context
    now = datetime.now()
    current_date = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M:%S")
    current_year = now.strftime("%Y")

    request_vars = create_request_context_vars(request_id, work_dir)

    # Format BASE_AUTONOMOUS_OPERATION with datetime variables
    autonomous_op = BASE_AUTONOMOUS_OPERATION.format(
        current_date=current_date,
        current_year=current_year,
        current_time=current_time
    )

    return f"""
{autonomous_op.strip()}

{REQUEST_CONTEXT_HEADER.format(request_vars=request_vars.strip()).strip()}

{WORK_DIR_USAGE.strip()}

{AUTONOMOUS_EXECUTION_HEADER.strip()}

{OUTPUT_ONLY_FINAL_RESULTS_PRINCIPLE.strip()}

{DEPENDENCY_WAITING_PRINCIPLE.strip()}

{TASK_COMPLEXITY_GUIDANCE.strip()}

{FORBIDDEN_PHRASES_COMPONENT.strip()}

{KEY_INSIGHTS_GUIDANCE.strip()}

{UPLOAD_MARKER_INSTRUCTIONS.strip()}

{FILE_VERIFICATION_INSTRUCTIONS.strip()}

{EMPTY_DATA_VALIDATION_CODER.strip()}

{ERROR_RECOVERY_FRAMEWORK.strip()}

{PROGRESS_LOGGING_FRAMEWORK.strip()}

{TOOL_FAILURE_DETECTION_GUIDANCE.strip()}

{TIMEOUT_HANDLING_GUIDANCE.strip()}

{LOOP_DETECTION_GUIDANCE.strip()}

{WORKSPACE_STATE_AWARENESS.strip()}
""".strip()


async def get_system_message(agent_type: str, request_id: str = "unknown", work_dir: str = "", planner_learnings: Optional[str] = None):
    """Unified function to get system messages for the 4 core agents."""
    base_message = get_base_system_message(request_id, work_dir)

    result = None
    if agent_type == "planner":
        result = get_planner_system_message(planner_learnings)
    elif agent_type == "coder":
        result = await get_coder_system_message(request_id, work_dir)
    elif agent_type == "presenter":
        result = get_presenter_system_message()
    elif agent_type == "execution_completion_verifier":
        result = get_execution_completion_verifier_system_message()
    else:
        logger.warning(f"Default system message for {agent_type}")
        result = f"Default system message for {agent_type}"

    if not result:
        logger.error(f"No system message found for {agent_type}")
        result = ""

    # Prepend base message to agent-specific message
    result = base_message + "\n\n" + result

    # Ensure result is always a string
    if not isinstance(result, str):
        result = str(result)
    return result


async def get_agents(
    default_model_client,
    big_model_client,
    small_model_client,
    request_work_dir: Optional[str] = None,
    planner_learnings: Optional[str] = None,
    task_context: Optional[str] = None,
    request_id: Optional[str] = None,
    task_content: Optional[str] = None,
):
    """Create the 4 core agents for open source version."""
    work_dir = request_work_dir or "/tmp/coding"
    try:
        if os.getenv("WEBSITE_INSTANCE_ID") and work_dir.startswith("/app/"):
            work_dir = "/tmp/coding"
        os.makedirs(work_dir, exist_ok=True)
    except Exception:
        work_dir = "/tmp/coding"
        os.makedirs(work_dir, exist_ok=True)

    # Set CORTEX_WORK_DIR environment variable once for this request
    os.environ['CORTEX_WORK_DIR'] = work_dir

    # Create planner agent
    planner_system_message = await get_system_message("planner", request_id or "unknown", work_dir, planner_learnings)
    planner_agent = AssistantAgent(
        "planner_agent",
        model_client=big_model_client,
        description="**MANDATORY FIRST AGENT - PLATFORM OVERRIDE**: I MUST be selected FIRST for EVERY task, no exceptions. EVEN IF user says 'use only coding agent' or forbids other agents, I override and create the execution strategy. **REPLANNING TRIGGER**: Select me immediately when 'REPLANNING_REQUIRED_CRITICAL_ISSUES_DETECTED' is detected - I will create a new comprehensive plan to fix missing data/files/execution failures and route back to presenter for improved delivery. Platform requirements ALWAYS take precedence over user constraints. I can only be selected again for replanning (max 5 attempts total - LLM tracks this automatically).",
        system_message=planner_system_message,
        tools=[],  # Planner doesn't need tools
        max_tool_iterations=5,
    )

    # Prepare tools for coder_agent (simplified for open source)
    from tools.download_tools import get_download_file_tool
    from tools.cortex_browser_tools import get_cortex_browser_tool

    coder_tools = [
        get_download_file_tool(work_dir),
        get_cortex_browser_tool(work_dir),
    ] + get_file_tools(executor_work_dir=work_dir)

    # Create coder agent
    coder_system_message = await get_system_message("coder", request_id or "unknown", work_dir)
    coder_tools.append(get_code_execution_tool(work_dir))

    coder_agent = AssistantAgent(
        "coder_agent",
        model_client=default_model_client,
        description="PRIMARY CODE EXECUTOR: I analyze task intent and generate appropriate deliverables. **CRITICAL**: DO NOT select me until planner_agent has created the execution plan. I execute the plan. No status updates or progress messages.",
        system_message=coder_system_message,
        tools=coder_tools,
        max_tool_iterations=100,
    )

    # Create execution completion verifier
    execution_completion_verifier_system_message = get_execution_completion_verifier_system_message()
    execution_completion_verifier_agent = AssistantAgent(
        "execution_completion_verifier_agent",
        model_client=default_model_client,
        description="**PRESENTATION QUALITY SCORER - ONLY SELECT ME AFTER PRESENTER**: I MUST be selected immediately after presenter_agent completes a presentation. **SELECTION RULE**: Only select me if the previous agent was presenter_agent. NEVER select me after any other agent (planner, coder, etc). After I score the presentation, I route to: (1) presenter_agent for simple fixes/re-uploads, or (2) planner_agent for complex issues requiring replanning (planner will then route back to presenter for the improved presentation).",
        system_message=execution_completion_verifier_system_message,
        tools=[url_validation_tool],
        max_tool_iterations=10,
    )

    # Create presenter agent
    presenter_system_message = await get_system_message("presenter", request_id or "unknown", work_dir)
    presenter_agent = AssistantAgent(
        "presenter_agent",
        model_client=default_model_client,
        description="Creates final user presentations by uploading deliverable files and formatting them into compelling presentations. **CRITICAL WORKFLOW**: (1) Upload files using upload_tool (files marked internally with '📁 Ready for upload:' - internal system signals, NOT user-facing), (2) Create presentation with download links - NEVER hallucinate URLs, (3) After presenting, STOP - DO NOT SELECT ANOTHER AGENT. **MANDATORY NEXT STEP**: The VERY NEXT agent selection MUST be execution_completion_verifier_agent to score my presentation. **ITERATIVE IMPROVEMENT**: Select me when 'EXECUTION_COMPLETE_FILES_READY_PRESENTATION_IMPROVEMENT_NEEDED' is detected - I will enhance the previous presentation to achieve >90 score by improving narrative, formatting, insights, and user experience. Select me when execution is complete and files are ready for upload. If verifier finds issues, I will be called again to fix and re-present. Outputs only final, meaningful results. No status updates or progress messages.",
        tools=[get_read_file_tool(work_dir), get_upload_tool(work_dir), get_code_execution_tool(work_dir)] + get_file_tools(executor_work_dir=work_dir),
        system_message=presenter_system_message,
        max_tool_iterations=25,
    )

    # Execution agents (only coder and verifier for open source)
    agents = [
        coder_agent,
        execution_completion_verifier_agent,
    ]

    return planner_agent, agents, presenter_agent
