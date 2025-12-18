# Data validation and handling constants

EMPTY_DATA_VALIDATION_CODER = """
- **CRITICAL: EMPTY DATA VALIDATION BEFORE CHART CREATION**:
  * **MANDATORY CHECK**: Before creating ANY chart, validate data is not empty:
    - Check DataFrame is not empty: `if df.empty: raise ValueError("Cannot create chart: DataFrame is empty")`
    - Check numeric columns have non-zero values: `if df.select_dtypes(include=[np.number]).sum().sum() == 0: raise ValueError("Cannot create chart: All numeric values are zero - data appears empty")`
    - Check row count: `if len(df) == 0: raise ValueError("Cannot create chart: No data rows available")`
  * **FORBIDDEN**: Do NOT create charts when data is empty or all zeros
  * **FORBIDDEN**: Do NOT create charts with flat lines at zero and then generate insights about "spikes" or "patterns"
  * **MANDATORY**: If data validation fails, output clear error message (not status update with emoji). Skip chart creation and output error to user.
  * **MANDATORY**: Only create charts when data has meaningful values (non-zero, non-empty)
- **COMPLETENESS VALIDATION PRINCIPLE**:
  * **CRITICAL**: Distinguish between missing essential data vs missing optional enhancements
  * **VALIDATION**: Before rejecting, verify essential data exists
  * **FORBIDDEN**: Do NOT reject when essential data exists but optional enhancements are missing
  * **GENERIC**: Applies universally - validate essential completeness, not optional completeness
"""

EMPTY_DATA_VALIDATION_PRESENTER = """
- **CRITICAL: EMPTY DATA VALIDATION**:
  * **MANDATORY CHECK**: Before generating ANY insights, validate that data actually exists and is meaningful:
    - Check if charts/images show empty/flat data (all zeros, no variation)
    - Check if data files are empty or contain only zeros
    - **FORBIDDEN**: Do NOT generate insights when data is empty or shows flat lines at zero
    - **FORBIDDEN**: Do NOT describe "intense spikes" or "patterns" when charts show flat lines at zero
    - **FORBIDDEN**: Do NOT hallucinate insights from empty data - if data is empty, report that clearly
  * **MANDATORY**: If data is empty, state clearly: "The data appears to be empty or contains no meaningful values. Please check the data source."
  * **MANDATORY**: Only generate insights when data has meaningful variation and non-zero values
"""

URL_VALIDATION_GUIDANCE = """
- **CRITICAL: URL VALIDATION AND FACT-CHECKING BEFORE PRESENTATION**:
  * **MANDATORY CHECK**: Before presenting ANY external URLs (headlines, articles, images, etc.), validate they are accessible and contain the claimed content:
  - Verify URL accessibility with a HEAD request (no full download)
    - Verify the URL returns 200 status code (not 404, 403, or other errors)
    - Check that URL content matches the claimed description/title
    - For news headlines: Verify the article title matches what you're presenting
    - For images: Ensure the image URL actually serves an image (not broken/placeholder)
  * **FORBIDDEN**: Do NOT present URLs that return 404 or other error codes
  * **FORBIDDEN**: Do NOT present URLs with fabricated or mismatched content
  * **FORBIDDEN**: Do NOT use URLs from sources that may not be accessible (check HTTP status)
  * **MANDATORY**: If URL validation fails, remove the URL and present text-only information instead
  * **MANDATORY**: Only present URLs that can be verified as working and containing accurate information
  * **MANDATORY**: Validate URLs internally. Do NOT output validation status messages to users. Output only if validation fails with clear error message.
"""

LLM_DATA_VALIDATION_FRAMEWORK = """
- **SEMANTIC VALIDATION**: Before processing ANY data, validate if downloaded data matches task requirements using LLM reasoning:
  * Extract task requirements from conversation context
  * Analyze actual data structure and sample content using pandas
  * Use LLM to determine semantic correctness: `print(f"🔍 VALIDATING DATA: Task requires [requirement], data contains [actual_content] - Match: [YES/NO]")`
  * If mismatch detected: `raise ValueError(f"❌ DATA MISMATCH: Task requires [requirement] but data contains [actual_content]. Wrong data downloaded - needs replanning.")`
- **CONTENT ANALYSIS**: Use LLM to analyze data quality and relevance:
  * Check geographic scope matches requirements
  * Verify data contains expected metrics matching task requirements
  * Validate temporal scope matches requirements (if task specifies a time period, data must match that exact period, not adjacent periods)
  * Validate data completeness (if task specifies a count or set of entities, verify all are present - not fewer or more)
  * Verify data realism (financial metrics should be in appropriate units and ranges - not zeros, negative, or impossible values for the domain)
  * Detect placeholder/synthetic vs real data
  * For time-specific tasks, verify data actually covers the specified period, not different time periods
  * For financial/performance tasks, verify metrics are realistic for the domain (appropriate units, reasonable ranges, not placeholder values)
- **REPLANNING TRIGGERS**: If validation fails, provide specific guidance:
  * Wrong geographic scope: "Task requires specific geographic data but downloaded different scope - replan with correct geographic sources"
  * Wrong data type: "Task requires specific data type but downloaded unrelated data - replan with correct data type"
  * Outdated data: "Task requires latest data but downloaded outdated data - replan with current sources"
  * Wrong time period: "Task requires specific time period data but downloaded different period - replan with correct time period sources (official filings, reports, authoritative data sources for that period)"
  * Incomplete data: "Task requires specific entities/items but data missing some - replan to collect missing items from authoritative sources"
  * Unrealistic data: "Task requires realistic domain metrics but data contains unrealistic values (zeros, negative, or impossible numbers) - replan with authoritative sources (official filings, reports, domain-specific data APIs)"
  * Missing key metrics: "Task requires specific metrics but data missing these - replan to collect complete metrics from authoritative sources"
- **ATTEMPT TRACKING**: Track replanning attempts (max 3) with escalating strategies:
  * Attempt 1: Try alternative sources within same data provider
  * Attempt 2: Switch to different data providers entirely
  * Attempt 3: Use web scraping of official websites as fallback
- **MANDATORY VALIDATION BEFORE FILE CREATION**: Data validation MUST occur BEFORE creating any files. If validation fails, raise ValueError to trigger replanning - DO NOT create files with invalid/placeholder data.
- **VALIDATION CODE PATTERN**:
```python
import pandas as pd
# Validate data BEFORE creating files
df_sample = df.head(10)
data_preview = df_sample.to_string()
task_requirements = "[extract from context]"
# Use LLM or logic to validate
validation_prompt = f"Task requires: {{task_requirements}}. Data preview: {{data_preview}}. Does this data match? Answer YES/NO and explain why."
if not data_matches_requirements:
    raise ValueError(f"❌ DATA MISMATCH: Task requires {{task_requirements}} but data contains {{actual_content}}. Wrong data downloaded - needs replanning.")
# Only create files if validation passes
```
    - **CRITICAL: NO PLACEHOLDER FILES**: If data validation fails or data is unavailable, raise ValueError for replanning. Never create files with placeholder, synthetic, or invalid data.
    - **FORBIDDEN: ERROR MESSAGE FILES**: Never create files that contain only error messages, explanations of data unavailability, or placeholder text. Files must contain actual data/content, not error descriptions. If data is unavailable, raise ValueError for replanning - do NOT create files with error messages. Creating files with error messages instead of data = automatic score 0.
"""

FACTUAL_ACCURACY_VALIDATION = """
- **CRITICAL: FACTUAL ACCURACY VALIDATION** - ALL insights MUST match what's actually visible in the charts/data:
  * **MANDATORY CHECK**: Before stating any numerical claim or pattern, verify it matches the actual chart/data:
    - If you claim "3x the average" or "surged X%" - verify this matches the actual numbers visible
    - If you claim "past two weeks" - verify the dates actually match what's shown
    - If you claim "one group's spike" - verify which group actually spiked and when
    - If you claim "long flat stretches" - verify the chart actually shows flat periods
    - If you claim "start of second half" - verify the dates match the actual period shown
  * **FORBIDDEN**: Do NOT make specific numerical claims (like "3x", "doubled", "surged 40%") unless you can verify them from the actual chart/data
  * **FORBIDDEN**: Do NOT claim temporal patterns (like "past two weeks", "second half") unless the dates match what's actually shown
  * **FORBIDDEN**: Do NOT describe patterns that aren't visible in the chart (like "long flat stretches" when data shows consistent variation)
  * **MANDATORY**: Only describe what you can actually see and verify in the charts/images
  * **MANDATORY**: If making comparative claims, verify both data points exist and the comparison is accurate
  * **MANDATORY**: When describing spikes/peaks, verify the actual dates and values match what's shown
"""
