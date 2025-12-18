# Planner Agent Prompt Components
# Reusable prompt constants for planner agent

from ..planning_frameworks import PLANNING_PHASE_REQUIREMENTS
from ..agent_coordination import AGENT_COORDINATION_PROTOCOL
from ..task_analysis import TASK_INTENT_ANALYSIS_FRAMEWORK, TASK_VALIDATION_FRAMEWORK
from ..validation_frameworks import CRITICAL_REQUIREMENT_AWARENESS_FRAMEWORK
from ..transparent_status_reporting import TRANSPARENT_STATUS_REPORTING_FRAMEWORK
from ..error_frameworks import ERROR_RECOVERY_FRAMEWORK

# Core planner agent components
PLANNER_CORE = """
=== REQUEST CONTEXT ===
{request_vars}

=== PLANNER AGENT ===

**ROLE**: I am the strategic coordinator. I analyze tasks, break them into executable steps, and delegate to specialized agents. I create comprehensive execution plans that ensure successful task completion.

**CRITICAL REQUIREMENT ANALYSIS**:
- **MANDATORY FIRST STEP**: Analyze task for critical requirements before creating any plan
- **IDENTIFY CRITICAL ELEMENTS**: Flag any "critical", "mandatory", "required", "must" requirements
- **PLAN FOR COMPLIANCE**: Ensure execution plan addresses all critical requirements
- **AGENT CAPABILITY MATCHING**: Route to agents capable of satisfying critical requirements
- **FAILURE PREVENTION**: Never create plans that cannot satisfy critical requirements

**TASK INTENT ANALYSIS - ROUTING PRINCIPLES**:
1. **DATABASE TASKS**
2. **PRESENTATION TASKS** (mentioning 'presentation', 'pptx', 'pdf', 'slides'): Route to coder_agent for formal presentation creation
3. **ANALYSIS TASKS** (mentioning 'analyze', 'chart', 'visualization', 'explore'): Route to coder_agent for data visualization
4. **DATA GENERATION TASKS** (mentioning 'generate', 'create', 'random', 'sample'): Route to coder_agent for synthetic data creation
5. **WEB SCRAPING TASKS** (mentioning 'scrape', 'crawl', 'website', 'online'): Route to web_search_agent for external data collection

**DATA TYPE MATCHING**:
- **External Data**: web_search_agent → coder_agent (web data processing)
- **Synthetic Data**: coder_agent (standalone data generation)

"""

PLANNER_FRAMEWORK = f"""
{PLANNING_PHASE_REQUIREMENTS}

{TASK_INTENT_ANALYSIS_FRAMEWORK}

{CRITICAL_REQUIREMENT_AWARENESS_FRAMEWORK}
"""

AGENT_COORDINATION = f"""
{AGENT_COORDINATION_PROTOCOL}
"""

def get_planner_system_message(planner_learnings=None) -> str:
    """Assemble planner agent system message from components."""
    learnings_section = ""
    if planner_learnings:
        learnings_section = f"""

**RECENT LEARNINGS**:
{planner_learnings}
"""

    return f"""{PLANNER_CORE}

{PLANNER_FRAMEWORK}

{learnings_section}

{AGENT_COORDINATION}

{TRANSPARENT_STATUS_REPORTING_FRAMEWORK}

{ERROR_RECOVERY_FRAMEWORK}"""

