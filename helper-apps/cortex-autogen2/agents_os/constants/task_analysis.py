# Task Analysis Framework - Generic Principles for Understanding Task Intent
# Used by all agents to analyze task requirements without hardcoded examples

TASK_INTENT_ANALYSIS_FRAMEWORK = """
**GENERIC TASK ANALYSIS FRAMEWORK**:
Analyze task intent by identifying key patterns and requirements:

**DELIVERABLE TYPE DETECTION**:
- **PRESENTATION DETECTED**: Task mentions 'presentation', 'pptx', 'pdf', 'slides', 'presentation' → Create formal presentation files
- **VISUALIZATION DETECTED**: Task mentions 'chart', 'visualization', 'graph', 'plot', 'diagram' → Create data visualizations
- **REPORT DETECTED**: Task mentions 'report', 'summary', 'analysis', 'overview' → Create structured reports
- **DATASET DETECTED**: Task mentions 'dataset', 'csv', 'excel', 'data file' → Create data files
- **CONTENT DETECTED**: Task mentions 'generate', 'create', 'produce' → Create new content/assets

**DATA SOURCE ANALYSIS**:
- **WEB DETECTED**: Task mentions 'scrape', 'crawl', 'website', 'online' → Collect external web data
- **SYNTHETIC DETECTED**: Task mentions 'generate', 'random', 'sample', 'create' → Generate synthetic data
- **EXISTING DETECTED**: Task mentions 'analyze', 'process', 'transform' → Process existing data

**CONTENT TYPE ANALYSIS**:
- **AUTHOR DETECTED**: Task mentions 'author', 'writer', 'byline', 'contributor' → Focus on authorship data
- **CONTENT DETECTED**: Task mentions 'headline', 'article', 'content', 'text' → Focus on content data
- **TEMPORAL DETECTED**: Task mentions 'trend', 'time', 'daily', 'monthly', 'year' → Focus on temporal patterns
- **STATISTICAL DETECTED**: Task mentions 'count', 'total', 'average', 'percentage' → Focus on quantitative analysis

**OUTPUT FORMAT MATCHING**:
Match task requirements to appropriate output formats:
- PPTX requested → PowerPoint presentation
- PDF requested → PDF document
- PNG requested → Image/chart files
- CSV requested → Data files
- JSON requested → Structured data files

**AGENT SELECTION PRINCIPLES**:
- Presentation tasks → coder_agent for formal file creation
- Analysis tasks → coder_agent for visualization and processing
- Web tasks → web_search_agent for external data collection
- Generation tasks → coder_agent for synthetic content creation
"""

TASK_VALIDATION_FRAMEWORK = """
**GENERIC TASK VALIDATION FRAMEWORK**:
Validate task understanding and execution correctness:

**DELIVERABLE VALIDATION**:
- Output files match requested formats (PPTX for presentations, PNG for charts, etc.)
- File count meets requirements (single PPTX, multiple PNGs, etc.)
- File naming follows conventions (descriptive, not system-generated)
- File content matches task intent (author charts for author analysis, etc.)

**DATA VALIDATION**:
- Data sources appropriate for task (database for structured data, web for external data)
- Data structure matches requirements (author fields for author analysis, etc.)
- Data volume appropriate for task scope (sample vs complete dataset)
- Data quality meets standards (complete, accurate, consistent)

**PROCESS VALIDATION**:
- Agent sequence follows logical flow (data extraction → processing → presentation)
- Each step produces expected intermediate outputs
- Error handling maintains task integrity
- Fallback strategies preserve core requirements

**QUALITY VALIDATION**:
- Output presentation follows professional standards
- Visual elements enhance rather than distract
- Information hierarchy supports task goals
- User experience considerations addressed
"""

__all__ = ['TASK_INTENT_ANALYSIS_FRAMEWORK', 'TASK_VALIDATION_FRAMEWORK']
