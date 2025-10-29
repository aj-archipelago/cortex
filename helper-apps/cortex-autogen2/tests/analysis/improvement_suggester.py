"""
Improvement suggester using LLM analysis.

Analyzes test results and generates actionable suggestions
for improving system performance and quality.
"""

import os
import json
import logging
import asyncio
import httpx
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)


class ImprovementSuggester:
    """Generates improvement suggestions from test data using LLM."""

    def __init__(
        self,
        api_base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: str = "gpt-4.1"
    ):
        """
        Initialize the improvement suggester.

        Args:
            api_base_url: Cortex API base URL
            api_key: Cortex API key
            model: Model to use
        """
        self.api_base_url = api_base_url or os.getenv("CORTEX_API_BASE_URL", "http://localhost:4000/v1")
        self.api_key = api_key or os.getenv("CORTEX_API_KEY")
        self.model = model

        if not self.api_key:
            raise ValueError("CORTEX_API_KEY environment variable must be set")

    async def suggest_improvements(
        self,
        test_run_data: Dict,
        progress_updates: List[Dict],
        logs: List[Dict],
        evaluation: Dict,
        metrics: Dict
    ) -> List[Dict]:
        """
        Generate improvement suggestions from test data.

        Args:
            test_run_data: Test run information
            progress_updates: Progress update list
            logs: Log entries
            evaluation: Evaluation results
            metrics: Performance metrics

        Returns:
            List of suggestions with category and priority
        """
        logger.info("💡 Generating improvement suggestions...")

        # Build analysis prompt
        prompt = self._build_analysis_prompt(
            test_run_data,
            progress_updates,
            logs,
            evaluation,
            metrics
        )

        try:
            # Call LLM
            response = await self._call_llm(prompt)

            # Parse suggestions
            suggestions_data = json.loads(response)
            suggestions = suggestions_data.get('suggestions', [])

            logger.info(f"   Generated {len(suggestions)} suggestions")

            return suggestions

        except Exception as e:
            logger.error(f"Error generating suggestions: {e}", exc_info=True)
            return []

    def _build_analysis_prompt(
        self,
        test_run_data: Dict,
        progress_updates: List[Dict],
        logs: List[Dict],
        evaluation: Dict,
        metrics: Dict
    ) -> str:
        """Build analysis prompt for LLM."""
        # Summarize data
        error_logs = [log for log in logs if log.get('level') == 'ERROR']
        warning_logs = [log for log in logs if log.get('level') in ('WARNING', 'WARN')]

        progress_issues = evaluation.get('progress_issues', [])
        output_weaknesses = evaluation.get('output_weaknesses', [])

        prompt = f"""You are an expert system analyzer. Analyze this test run and provide actionable improvement suggestions for the code.

**Test Summary:**
- Duration: {test_run_data.get('duration_seconds', 0):.1f}s
- Status: {test_run_data.get('status', 'unknown')}
- Progress Updates: {len(progress_updates)}
- Errors: {len(error_logs)}
- Warnings: {len(warning_logs)}

**Performance Metrics:**
- Time to first progress: {metrics.get('time_to_first_progress', 0):.1f}s
- Avg update interval: {metrics.get('avg_update_interval', 0):.1f}s
- Max update interval: {metrics.get('max_update_interval', 0):.1f}s

**Evaluation Scores:**
- Progress: {evaluation.get('progress_score', 0)}/100
- Output: {evaluation.get('output_score', 0)}/100

**Identified Issues:**

Progress Issues:
{json.dumps(progress_issues, indent=2) if progress_issues else "None"}

Output Weaknesses:
{json.dumps(output_weaknesses, indent=2) if output_weaknesses else "None"}

**Error Logs:**
{json.dumps([log.get('message', '') for log in error_logs[:5]], indent=2) if error_logs else "None"}

**Instructions:**
1. Analyze the test data above
2. Identify specific code improvements that would help
3. Focus on actionable suggestions (not generic advice)
4. Categorize each suggestion (performance/quality/reliability)
5. Prioritize suggestions (high/medium/low)

**Return JSON format:**
```json
{{
  "suggestions": [
    {{
      "suggestion": "Add intermediate progress updates during image collection. Currently 30s gap detected.",
      "category": "performance",
      "priority": "high",
      "code_reference": "coder_agent or web_search_agent"
    }},
    {{
      "suggestion": "Improve error handling for PDF generation. Preview images failed to generate.",
      "category": "reliability",
      "priority": "medium",
      "code_reference": "coder_agent preview image generation"
    }}
  ]
}}
```

Provide 3-7 specific, actionable suggestions. Return ONLY the JSON response."""

        return prompt

    async def _call_llm(self, prompt: str) -> str:
        """Call Cortex LLM API."""
        url = f"{self.api_base_url}/chat/completions"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are an expert code analyzer. Always respond with valid JSON only."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.5,
            "max_tokens": 2000
        }

        max_retries = 3
        base_delay = 2.0

        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=180.0) as client:
                    response = await client.post(url, headers=headers, json=payload)
                    response.raise_for_status()

                    data = response.json()
                    content = data['choices'][0]['message']['content']

                    # Clean up markdown
                    content = content.strip()
                    if content.startswith('```json'):
                        content = content[7:]
                    if content.startswith('```'):
                        content = content[3:]
                    if content.endswith('```'):
                        content = content[:-3]

                    return content.strip()

            except (httpx.TimeoutException, httpx.ReadTimeout, httpx.ConnectTimeout) as e:
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)  # Exponential backoff
                    logger.warning(f"LLM call timeout (attempt {attempt + 1}/{max_retries}), retrying in {delay}s: {e}")
                    await asyncio.sleep(delay)
                else:
                    logger.error(f"LLM call failed after {max_retries} attempts: {e}")
                    raise
            except Exception as e:
                # Re-raise non-timeout exceptions immediately
                raise
