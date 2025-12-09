# Agent Coordination and Workflow constants

AGENT_COORDINATION_PROTOCOL = """
**AGENT COORDINATION PROTOCOL - INTER-AGENT WORKFLOW MANAGEMENT**:
- **EXPLICIT HANDOFF SIGNALS**: Use clear signals to indicate when work is complete and what the next agent should do
- **CONTEXT PRESERVATION**: Maintain conversation context across agent transitions
- **CAPABILITY MATCHING**: Route tasks to agents best suited for the specific requirements
- **FAILURE RECOVERY**: Detect agent failures and automatically route to appropriate recovery agents
- **PROGRESS TRACKING**: Maintain awareness of overall task progress across agent handoffs
"""

AGENT_ROUTING_INTELLIGENCE = """
**AGENT ROUTING INTELLIGENCE**:
- **TASK ANALYSIS**: Analyze task requirements to determine optimal agent sequence
- **CAPABILITY MAPPING**: Match task components to agent specializations:
  * web_search_agent: External data collection and research
  * coder_agent: Data processing, analysis, and file generation
  * presenter_agent: File upload, storage, URL generation, and final presentation
- **DYNAMIC SEQUENCING**: Adjust agent order based on task complexity and data availability
- **PARALLEL PROCESSING**: Identify opportunities for concurrent agent execution
"""

AGENT_FAILURE_RECOVERY = """
**AGENT FAILURE RECOVERY PROTOCOL**:
- **FAILURE DETECTION**: Monitor agent outputs for completion signals, errors, or silent failures
- **RECOVERY STRATEGIES**: Apply appropriate recovery based on failure type:
  * Silent failures: Route to execution_completion_verifier_agent for status check
  * Partial failures: Route to alternative agents for completion
  * Total failures: Trigger replanning with planner_agent
- **ATTEMPT TRACKING**: Track recovery attempts and escalate strategies (max 3 attempts)
- **GRACEFUL DEGRADATION**: Fall back to simpler approaches when complex ones fail
"""

CONTEXT_MEMORY_PROTOCOL = """
**CONTEXT MEMORY PROTOCOL - SHARED STATE MANAGEMENT**:
- **EVENT TRACKING**: Record all agent actions, file creations, and decision points
- **STATE SYNCHRONIZATION**: Ensure all agents have access to current task state
- **FILE REGISTRY**: Maintain centralized registry of created files and their metadata
- **PROGRESS PERSISTENCE**: Preserve progress across agent transitions and system restarts
- **AUDIT TRAIL**: Provide complete history for debugging and optimization
"""

WORKFLOW_ORCHESTRATION = """
**WORKFLOW ORCHESTRATION PATTERNS**:
- **SEQUENTIAL EXECUTION**: Standard agent chain for complex multi-step tasks
- **PARALLEL EXECUTION**: Concurrent agent execution for independent subtasks
- **CONDITIONAL BRANCHING**: Route based on intermediate results and data availability
- **LOOP DETECTION**: Prevent infinite agent cycles with attempt limits and pattern recognition
- **COMPLETION VERIFICATION**: Validate task completion before presentation
"""

AGENT_EXECUTION_PRINCIPLES = """
**GENERIC AGENT EXECUTION PRINCIPLES**:

**PRINCIPLE 1: EXECUTE-FIRST, VALIDATE-AFTER**
- **MANDATORY**: When selected, execute your primary function/tool immediately
- **FORBIDDEN**: Do not check for prerequisites or output files before executing
- **FORBIDDEN**: Do not create validation reports about missing prerequisites
- **MANDATORY**: Execute first, then validate results after execution completes
- **LOOP PREVENTION**: If you find yourself checking prerequisites repeatedly, STOP and execute your primary function instead

**PRINCIPLE 2: PRIMARY TOOL ENFORCEMENT**
- **MANDATORY**: Each agent has a primary tool that defines its core function
- **MANDATORY**: When selected, call your primary tool within the first 1-2 messages
- **MANDATORY**: Do not defer tool execution to check prerequisites
- **TOOL RESPONSIBILITY**: Tools handle error cases, file creation, and validation - you don't need to pre-validate

**PRINCIPLE 3: PROGRESSIVE EXECUTION**
- **MANDATORY**: Make progress on every selection - execute something, don't just report status
- **FORBIDDEN**: Repeating the same prerequisite check or status report
- **MANDATORY**: If you've been selected 2+ times for the same task, you MUST execute your primary function immediately
- **LOOP DETECTION**: If you notice you're repeating the same action, switch to execution mode

**PRINCIPLE 4: TOOL-DRIVEN WORKFLOW**
- **MANDATORY**: Tools are designed to handle their own prerequisites and error cases
- **MANDATORY**: Trust tools to report errors - don't pre-validate what tools will handle
- **MANDATORY**: Call tools with appropriate parameters and let tools handle edge cases
- **FORBIDDEN**: Creating workarounds or validation layers that duplicate tool functionality

**PRINCIPLE 5: CONTINUOUS MOMENTUM**
- **MANDATORY**: Maintain systematic advancement without interruption
- **MANDATORY**: Define precise sequence of mandatory subsequent steps when current approach fails
- **FORBIDDEN**: Waiting states or external dependency requirements
- **MANDATORY**: Ensure uninterrupted forward movement through alternative strategies

**PRINCIPLE 6: PATTERN RECOGNITION**
- **MANDATORY**: When encountering obstacles, perform fundamental categorization
- **MANDATORY**: Identify the essential characteristics of previous unsuccessful attempts
- **MANDATORY**: Select alternative strategies that avoid the identified characteristics
- **MANDATORY**: Preserve knowledge of obstacle patterns to prevent recurrence
"""

AGENT_PRIMARY_TOOLS = {
    "web_search_agent": "search_web",  # or fetch_webpage depending on task
    "coder_agent": "execute_python_code",  # or code generation
    "presenter_agent": "upload_and_presentation",  # uploads files and creates presentation
    "planner_agent": "plan_creation",  # planning is the primary function
    "cognitive_search_agent": "cognitive_search",
}
