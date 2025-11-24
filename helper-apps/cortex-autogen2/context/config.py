"""
Configuration constants for context memory system.
"""

# Token limits for agent context summaries
AGENT_CONTEXT_LIMITS = {
    "planner_agent": 2000,  # Needs plan context
    "coder_agent": 5000,  # Needs file metadata, data structure
    "aj_sql_agent": 3000,  # Needs query context, data requirements
    "web_search_agent": 3000,  # Needs search context, findings
    "execution_completion_verifier_agent": 5000,  # Needs full flow awareness
    "uploader_agent": 2000,  # Minimal - just file list
    "presenter_agent": 50000,  # Maximum - comprehensive context
    "default": 3000  # Default for other agents
}

# Agent role descriptions for context filtering
AGENT_ROLE_DESCRIPTIONS = {
    "coder_agent": "Generates and executes Python code to create files. Needs file metadata, data structures, and code execution context.",
    "aj_sql_agent": "Queries Al Jazeera databases. Needs SQL query context, data requirements, and JSON result files.",
    "web_search_agent": "Performs web research. Needs search context, research findings, and downloaded files.",
    "execution_completion_verifier_agent": "Verifies execution completion and flow correctness. Needs full awareness of all events.",
    "planner_agent": "Creates execution plans. Needs plan context, decisions, and handoffs.",
    "uploader_agent": "Uploads files to Azure Blob Storage. Needs minimal context - just file list.",
    "presenter_agent": "Creates final user presentations. Needs comprehensive context with all details."
}

