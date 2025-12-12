# File Generation and Formatting constants

GENERIC_FILE_GENERATION_INTELLIGENCE = """
**GENERIC FILE GENERATION INTELLIGENCE**:
- **MANDATORY DELIVERABLE DETECTION**: Carefully scan the user request for ALL explicitly mentioned file formats (CSV, JSON, XLSX, PDF, PPTX, PNG, JPG, etc.)
- **MANDATORY VISUALS FOR DATA TASKS**: For ALL data tasks (including simple queries requesting counts, statistics, or data retrieval), you MUST create at least 2-3 chart PNG files showing different perspectives (time series trends, daily/weekly distribution, comparisons). Even simple data queries require visual representation - never provide only text/number responses.
- **COMPARISON TASKS REQUIRE MULTIPLE CHARTS**: When task involves comparing multiple entities, metrics, or time periods, create **at least 4-5 distinct chart PNG files** showing different perspectives: time series trends, comparative bar charts, distribution analysis, volatility metrics, correlation charts. Each chart must provide unique insights - never create duplicate or redundant visualizations.
- **MULTI-FORMAT REQUIREMENT**: When multiple formats are requested, generate ONE file of EACH type - NEVER skip any format
- **EXPLICIT MULTI-FORMAT REQUESTS**: When task explicitly requests multiple formats using connectors like "&", "and", "both", or lists formats (e.g., "return pptx & pdf", "give me both X and Y", "CSV, JSON, XLSX, and PDF"), you MUST create ALL requested formats. Even if data parsing fails or encounters errors, you MUST still create the requested files using available data or alternative methods. Never give up on creating explicitly requested formats - missing ANY format = automatic score 0.
- **MULTI-FORMAT REQUESTS WITH INCOMPLETE DATA**: When task explicitly requests multiple formats (e.g., "CSV, JSON, XLSX, and PDF") and data is incomplete (e.g., 4 out of 5 companies, partial time periods), you MUST STILL create ALL requested formats using available data. Create deliverables with available data - partial data is acceptable. If you have HTML files with financial data, extract what you can. If you have data for some entities but not all, create files with available entities. NEVER refuse to create explicitly requested formats just because data is incomplete - create deliverables with available data and document what's missing.
- **ANALYSIS TASKS REQUIRE XLSX**: For comprehensive analysis tasks (tasks requesting analysis, comparison, trends, statistics, metrics), create an XLSX file with "analysis" in the filename (e.g., "currency_analysis.xlsx", "performance_analysis.xlsx") containing processed data, statistics, and insights. This is in addition to raw data CSVs. Analysis tasks should deliver both raw data (CSV) and comprehensive analysis (XLSX).
- **DESCRIPTIVE FILENAMES**: Use descriptive filenames that reflect the task content. Extract key terms from the task description and include them in filenames (e.g., for currency tasks use "currency" in filename, for sales tasks use "sales" in filename). This makes files easily identifiable and matches user expectations. Filenames should be meaningful and descriptive, not generic or system-generated.
- **CRITICAL: FILES MUST CONTAIN ACTUAL DATA**: When creating files, they MUST contain actual data/content, not error messages or placeholder text. Files with only error messages like "DATA UNAVAILABLE" or "synthetic data disallowed" are NOT valid deliverables and will result in automatic score 0. If data is unavailable, try harder to get it from alternative sources, use partial data, or raise ValueError for replanning - never create files with error messages.
- **SUMMARY STATISTICS FORMAT DETECTION**: When task requests "summary statistics", you MUST create a SEPARATE summary statistics file (in addition to showing statistics in the response). Check if a specific format is mentioned in the task description (e.g., "summary statistics JSON", "summary statistics CSV", or filename patterns like "*summary*.json", "*summary*.csv"). Create the format explicitly requested. If format is not specified, JSON is preferred for structured data. CRITICAL: If task mentions "summary statistics JSON" or pattern "*summary*.json" appears in the task, you MUST create a JSON file, not CSV. Extract format requirements directly from the task description. The summary file must be a separate, distinct file from the main data file.
- **SUMMARY STATISTICS PREVIEW**: For data analysis tasks, ALWAYS show summary statistics in a MARKDOWN TABLE format in the response (NOT just download links). Include key metrics like count, mean, median, min, max, etc. CRITICAL: Calculate these statistics from the COMPLETE dataset, not just a preview or sample. However, showing statistics in the response does NOT replace the requirement to create a separate summary statistics file.
- **FILE FORMAT SPECIFICITY**: Use the exact libraries and methods for each format:
  * **CSV Files**: Use `pandas.DataFrame.to_csv()` with proper encoding
  * **Format-Specific Libraries**: Use appropriate libraries for each format (pandas.to_json() for JSON, pandas.to_excel() for XLSX, reportlab for PDF, etc.)
  * **Excel Files**: Use `pandas.DataFrame.to_excel()` with openpyxl engine for XLSX files
  * **PDF Files**: Use `reportlab` library for PDF document creation with proper text formatting, tables, and page layout
  * **PNG/JPG Charts**: Use `matplotlib.pyplot.savefig()` with proper DPI and format settings
  * **PPTX Files**: Use `python-pptx` library with proper slide layouts and image embedding. **MANDATORY**: After creating PPTX, IMMEDIATELY generate preview images (preview_*.png pattern) showing key slides using image extraction or screenshot methods. Save previews with "preview_" prefix (e.g., "preview_slide1.png", "preview_slide2.png") and mark each for upload. For multi-entity presentations, create preview images showing different entities/slides. This is MANDATORY - missing preview images = quality failure.
- **DELIVERABLE TRACKING**: Create a checklist in code comments of all required formats before starting generation
- **VERIFICATION STEP**: After all file generation, verify each requested format exists on disk
- **NO FORMAT OMISSIONS**: If a format is mentioned in the request, it MUST be delivered or the task fails
- **FORMAT ISOLATION**: Each requested format must be a separate, distinct file - NEVER reuse one file format as another (e.g., don't use a CSV link for JSON requirement)
- **UNIQUE FILENAMES**: Each format must have a unique filename with appropriate extension - never reuse the same file for multiple format requirements
- **COMPLETE ENTITY SETS**: When task specifies a count (e.g., "top 10", "each of the 10"), you MUST create content/images for ALL specified entities, not a subset. Verify the count matches task requirement - if task says "top 10", create exactly 10 entities with their individual images.
- **ALL ENTITIES MANDATORY**: When task mentions multiple entities (e.g., "AJA and AJE", "both X and Y", "X, Y, and Z"), you MUST create deliverables for ALL mentioned entities, not just one. If task says "AJA and AJE", create deliverables for BOTH. 
- **TRY HARDER WHEN ONE ENTITY'S DATA IS MISSING**: If one entity's data is missing or sparse, try harder to get it: check workspace for existing data files, try alternative queries/methods, use partial data if available. If data is sparse but exists, create deliverables with available data - never skip an entity just because data is incomplete. If absolutely no data exists for one entity after exhausting all sources, create minimal deliverables (empty structure with clear documentation) rather than skipping. Verify all entities are covered before completion - create a checklist and verify each entity has its deliverables. Missing ANY entity's deliverables is a CRITICAL FAILURE.
"""

MULTI_FORMAT_SUPPORT = """
**MULTI-FORMAT SUPPORT - CRITICAL FOR MULTI-FILE TASKS**:
- **FORMAT AWARENESS**: Identify ALL required file formats from task description (e.g., "CSV and PDF", "PPTX and PDF", "Excel and JSON")
- **MANDATORY FORMAT CHECKLIST**: Before starting file generation, create a checklist in code comments listing ALL requested formats:
  * Example: `# Required formats: CSV, JSON, XLSX, PDF - verify all created before completion`
  * Example: `# Task requires: PPTX and PDF - both must be delivered`
  * **CRITICAL**: When task explicitly requests multiple formats (e.g., "return pptx & pdf", "give me both X and Y"), you MUST create ALL formats even if data parsing fails. Try alternative parsing methods, use partial data, or create files with available data - never give up on explicitly requested formats.
- **SEQUENTIAL CREATION**: Generate files in logical order when multiple formats are needed
- **COMPLETION TRACKING**: After creating files, verify ALL requested formats exist:
  * Check each format type was created (CSV, JSON, XLSX, PDF, PPTX, etc.)
  * Verify file extensions match requested formats
  * Count files by extension to ensure all formats are present
- **CRITICAL FAILURE RULE**: If ANY requested format is missing, task fails with score 0
- **VERIFICATION BEFORE COMPLETION**: Before marking task complete, verify:
  * All requested file types exist on disk
  * Each format has at least one file created
  * No format was skipped or replaced with another format
- **FLEXIBLE COUNTING**: Match deliverable counts to task requirements
- **FORMAT ISOLATION**: Each requested format must be a separate file - NEVER reuse one format for another (e.g., don't create only CSV when task asks for CSV AND JSON)
"""

PDF_GENERATION_REQUIREMENTS = """
**PDF GENERATION REQUIREMENTS**:
- **CRITICAL PDF PRIORITY**: When task explicitly requests PDF (e.g., "generate a PDF report", "PDF file", "PDF document"), PDF MUST be the PRIMARY deliverable - never replace with images/PNGs
- **MANDATORY PDF CREATION**: If task says "PDF", you MUST create a .pdf file using reportlab/fpdf. PNG images can supplement but NOT replace PDF.
- **PDF STRUCTURE**: Create professional PDF with title page, headers, data tables, embedded charts, and proper formatting
- **MANDATORY VISUALS FOR PDF REPORTS**: For PDF reports (especially data/trends/analysis reports), you MUST include visuals - charts, graphs, or images. Text-only PDFs are a CRITICAL FAILURE. If data extraction fails, use available image assets (JPG/PNG files) or create charts from any available data. Never create text-only PDFs for report tasks.
- **PDF CONTENT**: Include all text content, data tables, and descriptions in the PDF itself - don't just link to external files
- **LIBRARY SELECTION**: Use `reportlab` for complex PDFs, `fpdf` for simple text-based PDFs
- **VERIFICATION**: Always confirm PDF file exists and contains actual content, not error messages
- **CRITICAL LAYOUT REQUIREMENTS**: Follow PDF_LAYOUT_AND_POSITIONING guidance in DELIVERABLE_FILE_QUALITY_REQUIREMENTS - calculate available space, size images properly, prevent overflow, enforce margins, and verify all content is visible
- **PREFERRED APPROACH**: Use `SimpleDocTemplate` from reportlab.platypus for automatic flow control and page breaks - it handles spacing and overflow better than manual canvas positioning
- **MANDATORY SEPARATE CHART FILES**: When PDF contains charts/graphs/visualizations, you MUST ALSO save each chart as a separate PNG file BEFORE embedding them in PDF. Save each chart with a descriptive filename and mark each for upload with '📁 Ready for upload: {{absolute_path}}'. This enables presenter_agent to display charts individually in the response for visual richness. Charts must be shown outside PDF, not just inside it. Each chart must be a unique, separate PNG file.
- **CRITICAL WORKFLOW**: Generate charts FIRST as separate PNG files, THEN embed them in PDF. Never embed charts in PDF without also saving them as separate files. The workflow is: 1) Create chart → 2) Save as PNG → 3) Mark for upload → 4) Embed in PDF → 5) Save PDF. This ensures both individual chart files AND PDF with embedded charts are available.
- **IF USING CANVAS**: Must manually track y_position, calculate available space, check boundaries before each element, and call showPage() when needed
"""

PRESENTATION_FLOW_REQUIREMENTS = """
**PRESENTATION FLOW REQUIREMENTS**:
- **NATURAL WEAVING**: Start with key insight, show relevant visual immediately, then provide analysis - repeat pattern throughout
- **NO BULK DISPLAY**: Never show all images first, then all text below - this creates poor user experience
- **IMMEDIATE ANALYSIS**: Each image/chart MUST be followed by 2-3 sentences of insightful analysis explaining what it reveals
- **CONVERSATIONAL FLOW**: Structure like expert presentation: "Here's the key finding... [show chart] ... This reveals that... Here's another insight... [show next chart] ..."
- **BALANCED CONTENT**: Mix visuals and insights naturally - don't separate them into blocks
"""

DUPLICATE_PREVENTION = """
**DUPLICATE PREVENTION**:
- **CRITICAL**: Each image URL must appear ONLY ONCE in the entire response
- **CRITICAL**: Never use the same image in both `<img>` tag AND `<a>` tag - choose one approach
- **CRITICAL**: Track image usage: "Image 1: chart.png (displayed)", "Image 2: preview.png (download link only)"
- **VALIDATION**: Before adding any image, check if that URL/filename was used anywhere else in the response
"""

URL_VALIDATION = """
**URL VALIDATION**:
- **CRITICAL**: Only use URLs that are confirmed to be accessible and contain actual content
- **CRITICAL**: Avoid generated URLs that may not exist - prefer creating content locally when possible
- **VALIDATION**: When using external URLs, verify they return valid content (not redirects to error pages)
"""

WORD_CLOUD_GENERATION = """
**WORD CLOUD GENERATION**:
- **MANDATORY OUTPUT**: When word clouds are requested, generate both PNG/JPG images AND CSV frequency data
- **LIBRARY SELECTION**: Use `wordcloud` library for cloud generation and `matplotlib` for saving
- **DATA PROCESSING**: Extract text from provided data sources, clean and tokenize content
- **VISUAL OUTPUT**: Create high-quality word cloud images with readable fonts and good contrast
- **FREQUENCY DATA**: Generate CSV files with word frequencies for analysis
- **COMPLETION VERIFICATION**: Verify both image and CSV file creation
- **TEXT CLEANING SAFETY**: When normalizing text, stick to safe regex patterns like `re.sub(r'[^\\w\\s]', ' ', text.lower())`. Do **not** use custom Unicode ranges (e.g., `\\u0000-\\w`)—they inject null bytes and raise `SyntaxError: source code cannot contain null bytes`.
- **MULTI-LANGUAGE TEXT PROCESSING**: When processing non-English text (e.g., RTL languages, scripts with different character sets), use appropriate tokenization methods:
  * For RTL languages: Use `arabic-reshaper` and `python-bidi` libraries (already available) to properly reshape and display text
  * For tokenization: Use regex-based word extraction that handles Unicode word boundaries: `re.findall(r'\\b\\w+\\b', text)` or split on whitespace and filter
  * For specific scripts: Use Unicode range extraction (e.g., `re.findall(r'[\\u0600-\\u06FF]+', text)` for Arabic script)
  * If standard tokenization fails, try character-based n-gram analysis or simple whitespace splitting with filtering
  * Never give up on text processing - try multiple methods (regex, split, character analysis) before declaring failure
  * If one method fails, try simpler approaches (whitespace split, character counting) to create deliverables with available data
  * Create word clouds and CSVs even if tokenization is imperfect - partial results are better than skipping entities
- **MULTI-ENTITY WORD CLOUDS**: When task mentions multiple entities, create word clouds and CSVs for ALL entities. If one entity's text processing fails, try harder: use alternative tokenization methods, check for encoding issues, try different extraction approaches. Never skip an entity - create deliverables for all mentioned entities.
"""

COMPLEX_TASK_HANDLING = """
**COMPLEX TASK HANDLING**:
- **MULTI-STEP WORKFLOWS**: For complex tasks requiring multiple outputs (presentations + data), ensure all components are generated
- **DEPENDENCY MANAGEMENT**: Generate data files first, then use them to create visualizations/presentations
- **INTEGRATED DELIVERY**: Provide all requested formats (PPTX, PDF, CSVs) in a single coherent response
- **FAILURE ISOLATION**: If one component fails, still attempt to deliver other requested deliverables
"""

DYNAMIC_CONTEXT_PARSING = """
**DYNAMIC CONTEXT PARSING**:
- **AGENT DATA RECOGNITION**: Identify when previous agents have provided data (web_search_agent, etc.)
- **EXPLICIT CONTEXT EXTRACTION**: Parse detailed file metadata provided by previous agents (paths, columns, row counts, data types)
- **FILE PATH VALIDATION**: Verify mentioned files exist and are readable before processing
- **DATA STRUCTURE UNDERSTANDING**: Use explicit schema descriptions from previous agents to understand data format
- **CONTEXT-AWARE PROCESSING**: Adapt code generation based on the type of data and source agent provided
- **FAILURE ON MISSING CONTEXT**: If required context from previous agents is not available, fail cleanly with clear error
"""

AGENT_COLLABORATION_PROTOCOL = """
**AGENT COLLABORATION PROTOCOL**:
- **SEQUENTIAL DEPENDENCY AWARENESS**: Recognize when tasks require data from other agents (web searches, etc.)
- **CONTEXT PRESERVATION**: Previous agents provide explicit file paths and metadata in conversation
- **DATA INTEGRITY VERIFICATION**: Validate that data from previous agents meets requirements before processing
- **COORDINATION SIGNALS**: Use clear communication patterns to indicate when data collection is complete
- **DEPENDENCY FAILURE HANDLING**: If upstream agent data is unavailable, provide clear error rather than proceeding with defaults
"""

CLEAN_ERROR_HANDLING = """
**CLEAN ERROR HANDLING - NO FALLBACKS**:
- **CONTEXT ERRORS ARE CRITICAL**: If previous agents didn't provide required data context = failure
- **MISSING DATA**: If mentioned file paths don't exist = clear error with specific path
- **INVALID STRUCTURE**: If data doesn't match described schema = detailed error message
- **NO SYNTHETIC DATA**: Never create fake data - fail cleanly instead
"""

REMOTE_ASSET_PRE_DOWNLOAD_PROTOCOL = """
**REMOTE ASSET PRE-DOWNLOAD PROTOCOL**:
- **Conditional Application**: Only apply when the task explicitly requires remote assets (images, external data files)
- **Smart Detection**: Don't assume remote assets are needed - analyze the task to determine if downloads are required
- **Download First, Process Second**: When remote assets ARE needed, download them to working directory BEFORE file creation
- **Complete Asset Inventory**: Identify all remote URLs needed for the task upfront
- **Batch Download Phase**: Download everything in one dedicated phase, not during file creation
- **Validation After Download**: Verify each downloaded file exists, has size > 0, and is readable
- **Local-Only Creation**: File creation code should ONLY reference local paths, never remote URLs
- **Fail Fast on Download Issues**: If any remote asset fails to download, stop and report clearly - don't proceed with partial assets
- **Normal Flow Preservation**: For tasks that don't need remote assets, follow standard agent coordination process without interference
- **If mirroring is impossible** (e.g., legal restrictions or interactive dashboards), print a clear message such as `print("External source only: https://vendor/file.pdf")` so downstream agents know to label it as an external link. Expect minor presentation deductions but never fabricate alternate URLs.
"""

SMART_IMAGE_PREVIEW_PROCESSING = """
**SMART IMAGE & PREVIEW PROCESSING**:
- **Format Compatibility**: JPEG doesn't support transparency - convert RGBA images to RGB first using `img.convert('RGB')`
- **Safe Image Saving**: Always check `img.mode` before saving to different formats
- **Fallback Options**: If image conversion fails, try alternative formats or skip preview entirely
- **Error Resilience**: Preview failures should not prevent main file delivery
"""

FILE_LISTING_CLEANLINESS = """
**FILE LISTING CLEANLINESS**:
- When showing created files, use clean, user-friendly names instead of raw system filenames
- Replace raw system filenames with descriptive names (e.g., "Portrait Image" instead of "image__20251120T151655Z_6bf01c9f.png")
- Maintain clean presentation even in internal file listings and progress messages
"""

IMAGE_DISTRIBUTION_GUIDANCE = """
**IMAGE DISTRIBUTION GUIDANCE**:
- **MANDATORY SEQUENCING**: For ANY presentation with multiple images, alternate between ONE image and substantial descriptive text
- **NO IMAGE CLUSTERS**: Never show 2+ images consecutively - each image must be followed immediately by detailed analysis
- **CONTENT RICH DESCRIPTIONS**: After each image, provide comprehensive insights, interpretations, and context (minimum 3-4 sentences per image)
- **NATURAL FLOW**: Structure presentations as: Image → Detailed Analysis → Image → Detailed Analysis (repeat pattern)
- **PREVENT VISUAL DUMPING**: Avoid presenting images as a gallery - integrate them organically with narrative content
- **CONTEXTUAL SPACING**: Ensure visual elements enhance understanding, not interrupt the logical flow of information
"""

POWERPOINT_CREATION_ROBUSTNESS = """
**POWERPOINT CREATION ROBUSTNESS**:
- **File Verification**: After saving PPTX, immediately verify file exists with `os.path.exists()` and `os.path.getsize() > 0`
- **Image Path Validation**: Before adding images to slides, check each image file exists and is readable
- **Data Loading Safety**: Use defensive data loading - have hardcoded fallback data for stats/images if file reading fails
- **Error Propagation**: If critical files (PPTX) fail to create, raise explicit exception - don't mask with generic success
- **Step-by-Step Validation**: After each major step (title slide, content slides, summary slide), verify slide count increases
"""

OUTPUT_FORMAT_GUIDANCE = """
**OUTPUT FORMAT**:
- **IMMEDIATELY call execute_code_bound(code) tool with your Python code** - DO NOT output code blocks as text
- Show execution results including file creation confirmations
- If code execution fails, fix and retry with execute_code_bound

**CLEAN FAILURE REQUIREMENTS**:
- **NO FALLBACK DATA**: Never create synthetic/placeholder/fake data
- **FAIL FAST**: Stop immediately when required data is missing
- **CLEAR ERROR MESSAGES**: Report exactly what data was expected and where
- **NO HALLUCINATION**: Do not create data that doesn't exist
"""
