"""
Configuration constants for context memory system.
"""

# Token limits for agent context summaries
AGENT_CONTEXT_LIMITS = {
    "planner_agent": 2000,  # Needs plan context
    "coder_agent": 5000,  # Needs file metadata, data structure
    "aj_sql_agent": 3000,  # Needs query context, data requirements
    "web_search_agent": 3000,  # Needs search context, findings
    "cognitive_search_agent": 2000,  # Needs search context
    "aj_article_writer_agent": 2500,  # Needs article context
    "execution_completion_verifier_agent": 5000,  # Needs full flow awareness
    "uploader_agent": 2000,  # Minimal - just file list
    "presenter_agent": 50000,  # Maximum - comprehensive context
    "default": 3000  # Default for other agents
}

# Agent role descriptions for context filtering
AGENT_ROLE_DESCRIPTIONS = {
    "planner_agent": "Creates comprehensive execution strategies and identifies required data sources for complex tasks requiring multiple agents.",
    "coder_agent": "Generates and executes Python code to create deliverables from data collected by other agents. Only runs after data collection is complete.",
    "aj_sql_agent": "Database specialist for Al Jazeera content. The ONLY agent that can access AJ databases for news articles and analytics.",
    "web_search_agent": "Specializes in internet data collection, downloading files from government sites, APIs, and data repositories.",
    "cognitive_search_agent": "Searches Azure Cognitive Search indexes for news wires, AJE/AJA articles, and cortex documents.",
    "aj_article_writer_agent": "Professional journalist that creates balanced, well-sourced articles using AJ SQL data and verified sources.",
    "execution_completion_verifier_agent": "Tracks execution progress, detects agent flow issues, and provides recovery guidance.",
    "uploader_agent": "Manages file uploads to Azure Blob Storage and handles SAS URL generation.",
    "presenter_agent": "Creates final user presentations by formatting uploaded file data and providing comprehensive results.",
}

