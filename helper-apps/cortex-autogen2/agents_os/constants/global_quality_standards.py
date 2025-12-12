# Global Quality Standards - Core quality expectations for all agents and testing
# These standards apply to ALL tasks and are used by planner_agent, execution_completion_verifier_agent, and testing
#
# SHARED SOURCE OF TRUTH:
# - Used by execution_completion_verifier_agent (via format_global_expectations_for_agent)
# - Used by test scoring system (tests/orchestrator.py and tests/evaluators/llm_scorer.py)
# - Single source ensures consistency between agent verification and test evaluation

GLOBAL_QUALITY_EXPECTATIONS = [
    "CRITICAL FAIL (SCORE=0): If main requested deliverable is missing, score=0 regardless of other content quality",
    "CRITICAL FAIL (SCORE=0): MULTIPLE FILE DELIVERIES - If task requests multiple specific file types (e.g., 'return pptx & pdf', 'give me chart and CSV'), ALL requested file types MUST be delivered. Missing ANY requested file type = FAIL.",
    "CRITICAL FAIL (SCORE=0): FILES CONTAIN ERROR MESSAGES - Any deliverable containing error messages like 'Error: Unable to Generate', 'generation failed', 'contact admin', or font errors like 'Character at index 0 in text is outside the range of characters supported by the font' will score 0",
    "All files must have working SAS URLs and proper download links",
    "Response must be COOL, FUN, ENGAGING, and PROFESSIONAL - fun without being disturbing, polished and smooth, complete user's request with insightful reply",
    "MINIMAL BUT DETAILED: Every word adds value, no text dumps or link dumps",
    "VISUALS FIRST: Rich visuals (charts, images, previews) integrated naturally with explanations. For data tasks, visuals are MANDATORY, not optional.",
    "NO TEXT/LINK DUMPS: Never just list files or dump links - integrate everything into engaging narrative",
    "EXPLANATIONS WITH VISUALS: Use visuals to explain, not replace explanation - combine both",
    "COMPLETE THE CONVERSATION: Reply to user's request as if continuing a conversation, not just delivering files",
    "PROFESSIONAL PRESENTATION: Polished, error-free, consistent styling - what an expert would present",
    "ENGAGING STORYTELLING: Use data insights, surprising findings, clear narratives to hold attention",
    "FUN & DELIGHTFUL: Creative visualizations, interesting patterns, enjoyable experience while maintaining professionalism - cool, engaging, fun without being disturbing",
    "File previews should appear before download links when available",
    "All download links MUST open in new tabs (target='_blank') to prevent users from leaving the site",
    "VISUALISTIC: Outputs should be visually rich with charts, images, previews, and visual elements that enhance understanding. For data tasks, this is MANDATORY - never provide only text/number responses without charts.",
    "ENGAGING: Content should be interesting, compelling, and hold user attention - use data insights, surprising findings, and clear narratives",
    "PROFESSIONAL: All deliverables must meet professional standards - proper formatting, high-quality visuals, clear structure, polished presentation",
    "FUN: While maintaining professionalism, outputs should be enjoyable and delightful - creative visualizations, interesting data patterns, engaging storytelling, cool and polished without being disturbing",
    "CLICKABLE PREVIEWS: Preview images MUST be clickable (wrapped in anchor tags linking to main file download URL). The `<img src>` displays the preview image, but `<a href>` must link to the original deliverable file (PPTX, PDF, CSV, etc.), not the preview image URL. When users click preview images, they should download/open the original file.",
    "PREVIEW IMAGES LINK TO ORIGINALS: When preview images are shown, clicking them MUST open/download the original deliverable file (PPTX, PDF, CSV, etc.), not the preview image itself. The `<img src>` shows the preview, but `<a href>` must link to the original file.",
    "HTML DOWNLOAD LINKS REQUIRED: All download links MUST use HTML `<a href=\"URL\" target=\"_blank\">text</a>` syntax, NOT markdown `[text](URL)` syntax. Markdown links cannot open in new tabs, so HTML is mandatory for proper user experience.",
    "CLEAN FILENAMES: All download links MUST use clean, user-friendly filenames - remove timestamps, hashes, and system-generated prefixes (e.g., 'output_20251107T175133Z_4b471ed1.pdf' → 'output.pdf')",
    "NO FILLER WORDS: Response must be direct and simple - no filler phrases like 'let me know!', 'if you'd like', 'don't hesitate to', 'feel free to', or closing pleasantries",
    "DIRECT & SIMPLE: Get straight to the point - every word must add value, no unnecessary phrases or pleasantries",
    "FORBIDDEN INTERNAL LANGUAGE: Never use internal/technical terms like 'workspace', 'print-ready', 'matches your requested name', 'Saved filename on download', 'Here's exactly what you're getting', 'What the page contains', 'Download the PDF', 'File:' - these are internal system language, not user-facing communication",
    "VISUALISTIC MANDATORY: Always show preview images when available - never describe file contents in text when preview images exist. If preview exists, display it immediately as clickable preview linking to original file",
    "INSIGHTS NOT DESCRIPTIONS: Provide insights, not descriptions of what's visible. Extract insights - what patterns, trends, surprises, or key findings emerge? Never describe what users can see ('Here's a chart showing...', 'This visualization displays...', 'The page contains...')",
    "ALWAYS SHOW PREVIEWS: If preview images exist, they MUST be displayed (not optional)",
    "PREFER AZURE UPLOADS: Deliverables should link to Azure SAS URLs generated by presenter_agent. If you reference external source URLs directly (e.g., vendor PDFs or public dashboards), call that out explicitly; evaluators will deduct a few points instead of treating them as hallucinations as long as the URLs are accessible.",
    "VISUALS ENHANCE UNDERSTANDING: Charts and graphs significantly improve data comprehension when included, providing visual insights into patterns and trends",
    "MANDATORY DATA VISUALS: For ALL data tasks (including simple queries requesting counts, statistics, or data retrieval), visualizations are MANDATORY - create at least 2-3 charts showing different perspectives (time series, distribution, comparison). Even simple data queries benefit from visual representation. Responses without visuals for data tasks are incomplete and will receive lower scores.",
    "CRITICAL FAIL (SCORE=0): If there's data and the response only describes what's visible without providing insights, patterns, surprises, or key findings, score=0. Data without insights is useless.",
    "INSIGHTS OVER DESCRIPTIONS: Do NOT just describe what users can see ('Here's a chart showing...', 'This visualization displays...'). Instead, provide INSIGHTS - what patterns, trends, surprises, or key findings emerge? Extract details that make users go 'wow'.",
    "MINIMAL TEXT, MAXIMUM INSIGHTS: Use as few words as possible but give maximum insights. Be direct and impactful. Answer 'So what?' - what does this data mean? What should users notice?",
    "NO TEXT DUMPS: Forbidden phrases like 'Download Data & Visuals', 'Here's the data', 'Download the files below' - integrate links naturally into insightful narrative instead",
    "PROFESSIONAL INSIGHTS: Responses must be pro, engaging, and insightful. Extract key details, surprising numbers, unexpected patterns, actionable insights. Don't repeat what's visible - provide value through insights.",
    "NO DUPLICATE IMAGES: CRITICAL FAIL (SCORE=0) - Each image URL must appear ONLY ONCE in the output. If the same image URL appears multiple times, score=0. Duplicate images waste space and create poor user experience.",
    "CRITICAL: NO 'DUMP OF IMAGES THEN DUMP OF TEXT' PATTERN - Output must weave images and insights together naturally. FORBIDDEN: Showing all images first, then all text below. REQUIRED: Start with key insight → show image → immediate insightful description → next image → immediate description → continue weaving. This creates natural, expert-level flow.",
    "EVERY IMAGE GETS INSIGHTFUL DESCRIPTION IMMEDIATELY AFTER: Each image (chart, preview, visualization) MUST be followed immediately by an insightful professional description (1-3 sentences). FORBIDDEN: Multiple images in a row without descriptions. FORBIDDEN: Saving all descriptions for the end. Each image needs its description right after it.",
    "START WITH KEY INSIGHT: Response must begin with the most important finding or deliverable, not generic intro like 'Here's your analysis' or 'I've analyzed the data'. Start directly with the key insight (e.g., 'Key metric increased significantly, driven by specific factor').",
    "EXPERT-LEVEL FORMATTING: Use bullet lists, numbered lists, bold text for emphasis, structured insights - make it feel like a 100-person expert team prepared this. Polished, comprehensive, but concise. Not verbose but includes every detail and key point.",
    "NATURAL FLOW: Images and insights must be woven together naturally throughout the response. No separation between visuals and text - they should flow together seamlessly (image → insight → image → insight).",
    "PROACTIVE DATA VISUALIZATION: For ALL data tasks (including simple queries requesting counts, statistics, or data retrieval), MANDATORY to create multiple charts showing different perspectives. Use various chart types (bar, line, pie, scatter, histogram) to provide comprehensive visual insights into data patterns, trends, and relationships. Never provide only text/number responses for data tasks.",
    "MULTIPLE VISUALS FOR DATA RICHNESS: ALL data tasks (including simple queries) MUST include 2-4 charts showing different aspects of the data. Multiple visualizations make data more accessible and provide richer insights than text alone. This is MANDATORY, not optional.",
    "VISUALS WITH INSIGHTS: Each chart/visualization MUST be displayed immediately followed by insightful description explaining what patterns, trends, or key findings the visual reveals. Charts without insights are incomplete.",
    "CRITICAL: DATA TASKS REQUIRE VISUALS - For any task involving data (queries, counts, statistics, analysis), providing only text/number responses without charts/visualizations is a significant quality issue. Visuals are not optional bonuses - they are essential for data comprehension and task completion quality.",
    "CRITICAL: OUTPUT MUST BE PURE MARKDOWN - NO HTML STRUCTURE (no <!DOCTYPE>, <html>, <head>, <body> tags). Use standard Markdown syntax for ALL formatting (# ## ### headers, **bold**, *italics*, lists, etc.). Use HTML <img> tags ONLY for images and HTML <a> tags ONLY for download links. NO CSS styling, NO <style> tags, NO HTML document structure. Theme compatibility is handled by the UI."
]


def format_global_expectations_for_agent() -> str:
    """
    Format global expectations for inclusion in agent prompts.

    Returns:
        Formatted string with global expectations for agent use
    """
    if not GLOBAL_QUALITY_EXPECTATIONS:
        return "**GLOBAL QUALITY EXPECTATIONS:**\nNo global expectations available"

    formatted = ["**GLOBAL QUALITY EXPECTATIONS (CRITICAL FOR EXECUTION SUCCESS):**"]
    for expectation in GLOBAL_QUALITY_EXPECTATIONS:
        formatted.append(f"- {expectation}")

    return "\n".join(formatted)
