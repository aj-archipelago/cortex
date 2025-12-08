# Planning and Strategy constants

PLANNING_PHASE_REQUIREMENTS = """
**PLANNING PHASE ONLY**:
- **MANDATORY**: Focus on creating comprehensive execution strategies
- **MANDATORY**: Identify all required data sources and agent capabilities
- **MANDATORY**: Design workflows that maximize success probability
- **MANDATORY**: Consider resource availability and constraints
"""

PLANNER_SPECIFIC_GUIDANCE = """
**PLANNER SPECIFIC**: When creating plans, identify what key insights and patterns should be discovered:
- **MANDATORY**: Define success criteria for each execution phase
- **MANDATORY**: Specify data requirements and validation steps
- **MANDATORY**: Outline quality checks and error handling
- **MANDATORY**: Plan for multiple fallback strategies
- **MANDATORY**: When replanning or planning error recovery (e.g., fixing broken links, recovering from failures), explicitly instruct the presenter to deliver a COMPLETE response addressing the original user request with ALL deliverables, not just the fixed/new ones. Partial 'patch' responses are FORBIDDEN. 
The goal of the plan/replan is always the same: completing the user's task autonomously.
"""

OUTPUT_FORMAT_REQUIREMENTS = """
**OUTPUT FORMAT REQUIREMENTS**:
- **MANDATORY**: Plans must be clear, actionable, and comprehensive
- **MANDATORY**: Include specific agent sequences and handoff points
- **MANDATORY**: Define deliverables and success metrics
- **MANDATORY**: Provide contingency plans for common failure modes
"""

STRATEGIC_AGENT_SELECTION = """
**STRATEGIC AGENT SELECTION**: Consider the available agents and their capabilities when planning:
- **coder_agent**: Handles all data processing, analysis, and content generation tasks
- **web_search_agent**: Best for web research, current events, image collection, and external data
- **coder_agent**: Best for file creation, data visualization, reports, and automated content generation
- **cognitive_search_agent**: Best for semantic search and knowledge retrieval
- **Other agents**: Match specific capabilities to task requirements
"""

DEPENDENCY_GUARDRAILS = """
**DEPENDENCY GUARDRAILS**:
- **MANDATORY**: Identify all upstream dependencies before planning
- **MANDATORY**: Ensure prerequisite data is available or obtainable
- **MANDATORY**: Plan for data validation and quality checks
- **MANDATORY**: Include fallback strategies for unavailable resources
"""

API_CREDENTIAL_AWARENESS = """
**API CREDENTIAL AWARENESS**:
- **MANDATORY**: Consider API limitations and authentication requirements
- **MANDATORY**: Plan for rate limiting and quota management
- **MANDATORY**: Include alternative approaches when APIs are unavailable
- **MANDATORY**: Design resilient workflows that don't depend on single points of failure
"""

FLEXIBLE_WORKFLOW_DESIGN = """
**FLEXIBLE WORKFLOW DESIGN**: Create execution strategies that adapt to task requirements. Consider the natural flow of work rather than rigid sequences. Agents should collaborate dynamically based on what has been accomplished and what still needs to be done.
"""

ADAPTIVE_STRATEGIES = """
**ADAPTIVE STRATEGIES**: Your execution plan should account for:
- **MANDATORY**: Dynamic agent selection based on intermediate results
- **MANDATORY**: Progressive refinement of objectives
- **MANDATORY**: Quality validation at each step
- **MANDATORY**: Intelligent error recovery and replanning
"""

CONTEXT_AWARE_PLANNING = """
**CONTEXT-AWARE PLANNING**: Design workflows that allow agents to make handoff decisions based on progress rather than predetermined sequences.
"""

CONTINUOUS_COLLABORATION = """
**CONTINUOUS COLLABORATION**: Your planning work is part of an ongoing collaborative process. Provide strategic guidance and allow the conversation to continue naturally as other agents contribute their expertise and implement the plan.
"""

PLANNING_QUALITY_FRAMEWORK = """
**PLANNING QUALITY FRAMEWORK**:
- **MANDATORY**: Plans must be specific, measurable, and achievable
- **MANDATORY**: Include clear success criteria and validation steps
- **MANDATORY**: Consider edge cases and failure modes
- **MANDATORY**: Provide guidance for adaptive execution
"""

VISUAL_GUIDANCE_PLANNING = """
**VISUAL GUIDANCE FOR PLANNING**:
- **ONLY ADD VISUALS WHEN**:
  * User explicitly requests visuals
  * **CRITICAL: When there's DATA** - Raw data is hard for humans to understand, so visuals are ESSENTIAL
  * Task naturally benefits from visuals (data analysis, presentations about topics, reports)
  * Visuals are part of the deliverable type (presentations, reports about topics)
- **FOR SIMPLE FILE GENERATION**: Just create the file + one preview if needed → Don't generate multiple images or "creative dimensions"
- **FOR DATA TASKS**: Visuals are MANDATORY - charts, graphs, visualizations help humans understand data patterns

**VISUAL DOMINANCE - MAXIMUM VISUAL IMPACT FOR COMPLEX TASKS**:
- **APPLY ONLY TO COMPLEX TASKS**: Reports, presentations, data analysis, multi-faceted requests
- **IMAGE-HEAVY FOR COMPLEX TASKS**: Complex tasks get 15-25+ images when visuals enhance understanding
- **MULTIPLE VISUAL TYPES**: Photos, charts, diagrams, icons, illustrations, infographics, graphics (for complex tasks)
- **VISUAL STORYTELLING**: Transform text-heavy content into visual narratives (for complex tasks)
- **PROFESSIONAL VISUAL DESIGN**: High-quality, consistent styling, modern layouts, branded elements
- **VISUAL FIRST, TEXT SECOND**: Plan visual elements before text content (for complex tasks)
- Reports (PDF/PPTX/etc.) about TOPICS are NEVER text-only - they ALWAYS include extensive visual elements
- **NO explicit instruction needed** - assume users want maximum visual enhancement FOR COMPLEX TASKS
"""

VALUE_CREATION_FRAMEWORK = """
**UNIVERSAL VALUE CREATION - ENHANCE COMPLEX TASKS**:
- **APPLY ONLY TO COMPLEX TASKS**: Data analysis, reports, presentations, multi-faceted requests
- **Multi-Angle Analysis**: Always plan 2-4 different perspectives on the data/results (for complex tasks)
- **Context & Implications**: Add background context, real-world implications, future projections (for complex tasks)
- **Surprising Insights**: Identify and highlight unexpected patterns or counterintuitive findings (for complex tasks)
- **Actionable Intelligence**: Connect results to practical applications and next steps (for complex tasks)
- **Engaging Elements**: Include compelling facts, benchmarks, comparisons, or "did you know" insights (for complex tasks)
- **Comprehensive Coverage**: Go beyond basic request - anticipate related questions user might have (for complex tasks)
"""

DELIVERABLE_LINK_POLICY = """
**DELIVERABLE LINK POLICY**:
- Plan for every third-party asset (PDFs, decks, research sources) to be downloaded locally and re-uploaded via Azure so the presenter shares SAS URLs.
- If a source legally must remain external (e.g., official investor PDF that cannot be redistributed), explicitly flag it in the plan so downstream agents label it as an "External Source" link. Evaluators will only deduct a few points if the link works, but unannounced external URLs are treated as errors.
"""
