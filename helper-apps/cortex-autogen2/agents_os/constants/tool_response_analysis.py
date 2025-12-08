# Tool Response Analysis and Inter-Agent Communication constants

TOOL_RESPONSE_ANALYSIS_FRAMEWORK = """
**TOOL RESPONSE ANALYSIS - INTELLIGENT AGENT DECISION MAKING**:
- **ANALYZE UPSTREAM AGENT STATUS**: Parse detailed responses from previous agents to understand what was accomplished vs. what failed
- **STATUS OBJECT PARSING**: Extract structured information about successes, failures, alternatives, and next steps
- **INTELLIGENT FALLBACK SELECTION**: Based on what previous agents accomplished, choose the optimal processing approach:
  * If CSV/JSON downloaded: Process directly with pandas
  * If HTML saved but download failed: Extract tables from HTML using pandas.read_html()
  * If only webpage fetched: Scrape data using BeautifulSoup or extract embedded JSON
  * If external data unavailable: Generate synthetic data matching the required schema
- **CONTEXT-AWARE DECISIONS**: Use conversation history to understand agent capabilities and choose appropriate next steps
- **FALLBACK HIERARCHY**: When primary approach fails, systematically try alternatives:
  1. Use downloaded data files directly
  2. Extract data from saved HTML pages
  3. Scrape additional sources if needed
  4. Generate synthetic data as last resort
- **DECISION LOGGING**: Print analysis results: `🔍 ANALYSIS: [agent] provided [status] - Choosing [approach] because [reason]`
"""

WEB_SEARCH_AGENT_STATUS_ANALYSIS = """
**WEB_SEARCH_AGENT RESPONSE ANALYSIS**:
- **DOWNLOAD STATUS CHECK**: Check if actual data files were downloaded vs. only HTML pages saved
- **CONTENT TYPE DETECTION**: Analyze what type of content was collected (CSV, HTML, JSON, images, etc.)
- **SUCCESS PATTERN RECOGNITION**: Identify successful data collection vs. metadata-only results
- **FAILURE PATTERN ANALYSIS**: Detect download failures, authentication issues, or format mismatches
- **ALTERNATIVE STRATEGY SELECTION**: Choose processing approach based on what was actually collected
"""

DATA_SOURCE_FALLBACK_FRAMEWORK = """
**DATA SOURCE FALLBACK HIERARCHY**:
- **PRIMARY SOURCES**: Direct downloads (CSV, Excel, JSON APIs)
- **SECONDARY SOURCES**: HTML table extraction from saved pages
- **TERTIARY SOURCES**: Additional web scraping or API calls
- **QUATERNARY SOURCES**: Synthetic data generation matching required schemas
- **ESCALATION LOGIC**: Only move to simpler approaches after exhausting complex ones
- **QUALITY PRESERVATION**: Prefer real data over synthetic, structured data over scraped data
"""

INTER_AGENT_COMMUNICATION_PROTOCOL = """
**INTER-AGENT COMMUNICATION PROTOCOL**:
- **STRUCTURED STATUS REPORTS**: Agents return detailed status objects with success/failure/partial results
- **CONTEXT SHARING**: Share file paths, data schemas, and processing metadata between agents
- **FAILURE TRANSPARENCY**: Clearly communicate what failed and why, with suggested alternatives
- **CAPABILITY AWARENESS**: Understand what each agent can accomplish and route accordingly
- **COORDINATION SIGNALS**: Use explicit signals for replanning, retries, or alternative approaches
"""
