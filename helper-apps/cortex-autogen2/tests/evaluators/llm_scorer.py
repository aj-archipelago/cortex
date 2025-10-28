"""
LLM-based evaluator for scoring test results using Cortex API.

Uses Cortex LLM API to evaluate progress updates and final outputs,
providing scores (0-100) and detailed reasoning.
"""

import os
import json
import logging
import asyncio
import httpx
from typing import Dict, List, Optional, Tuple
from .prompts import (
    PROGRESS_EVALUATION_PROMPT,
    OUTPUT_EVALUATION_PROMPT,
    format_progress_updates_for_evaluation,
    format_files_for_evaluation,
    format_test_summary_for_evaluation
)

logger = logging.getLogger(__name__)


class LLMEvaluator:
    """Evaluates test results using LLM (Cortex API)."""

    def __init__(
        self,
        api_base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: str = "gpt-4.1"  # Use fast model for evaluation
    ):
        """
        Initialize the LLM evaluator.

        Args:
            api_base_url: Cortex API base URL (defaults to env var CORTEX_API_BASE_URL)
            api_key: Cortex API key (defaults to env var CORTEX_API_KEY)
            model: Model to use for evaluation
        """
        self.api_base_url = api_base_url or os.getenv("CORTEX_API_BASE_URL", "http://localhost:4000/v1")
        self.api_key = api_key or os.getenv("CORTEX_API_KEY")
        self.model = model

        if not self.api_key:
            raise ValueError("CORTEX_API_KEY environment variable must be set")

        logger.info(f"🤖 LLM Evaluator initialized")
        logger.info(f"   API URL: {self.api_base_url}")
        logger.info(f"   Model: {self.model}")

    async def score_progress_updates(
        self,
        progress_updates: List[Dict],
        task: str
    ) -> Dict:
        """
        Score progress updates (0-100).

        Args:
            progress_updates: List of progress update dictionaries
            task: The original task description

        Returns:
            Dictionary with score, reasoning, issues, and strengths
        """
        if not progress_updates:
            logger.warning("No progress updates to evaluate")
            return {
                'score': 0,
                'reasoning': "No progress updates were received during task execution.",
                'issues': ["Zero progress updates received"],
                'strengths': []
            }

        logger.info(f"📊 Evaluating {len(progress_updates)} progress updates...")

        # Format updates for prompt
        updates_formatted = format_progress_updates_for_evaluation(progress_updates)

        # Build prompt
        prompt = PROGRESS_EVALUATION_PROMPT.format(
            progress_updates=updates_formatted,
            task=task
        )

        # Call LLM
        try:
            result = await self._call_llm(prompt)

            # Parse JSON response
            evaluation = json.loads(result)

            logger.info(f"   Progress Score: {evaluation['score']}/100")
            return evaluation

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            logger.debug(f"Raw response: {result}")

            return {
                'score': 50,
                'reasoning': "LLM response could not be parsed. Manual review required.",
                'issues': ["Failed to parse LLM evaluation response"],
                'strengths': []
            }
        except Exception as e:
            logger.error(f"Error scoring progress updates: {e}", exc_info=True)

            return {
                'score': 0,
                'reasoning': f"Evaluation failed: {str(e)}",
                'issues': [str(e)],
                'strengths': []
            }

    async def score_final_output(
        self,
        task: str,
        final_result: Optional[Dict],
        files_created: List[Dict],
        test_summary: Dict
    ) -> Dict:
        """
        Score final output (0-100).

        Args:
            task: The original task description
            final_result: Final result data from progress updates
            files_created: List of files created during execution
            test_summary: Summary of test run (duration, errors, etc.)

        Returns:
            Dictionary with score, reasoning, strengths, and weaknesses
        """
        logger.info(f"📊 Evaluating final output...")

        # Format data for prompt
        final_result_str = json.dumps(final_result, indent=2) if final_result else "No final result data"
        files_str = format_files_for_evaluation(files_created)
        summary_str = format_test_summary_for_evaluation(test_summary)

        # Build prompt
        prompt = OUTPUT_EVALUATION_PROMPT.format(
            task=task,
            final_result=final_result_str,
            files_created=files_str,
            test_summary=summary_str
        )

        # Call LLM
        try:
            result = await self._call_llm(prompt)

            # Parse JSON response
            evaluation = json.loads(result)

            logger.info(f"   Output Score: {evaluation['score']}/100")
            return evaluation

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            logger.debug(f"Raw response: {result}")

            return {
                'score': 50,
                'reasoning': "LLM response could not be parsed. Manual review required.",
                'strengths': [],
                'weaknesses': ["Failed to parse LLM evaluation response"]
            }
        except Exception as e:
            logger.error(f"Error scoring final output: {e}", exc_info=True)

            return {
                'score': 0,
                'reasoning': f"Evaluation failed: {str(e)}",
                'strengths': [],
                'weaknesses': [str(e)]
            }

    async def evaluate_test_run(
        self,
        task: str,
        progress_updates: List[Dict],
        final_result: Optional[Dict],
        files_created: List[Dict],
        test_summary: Dict
    ) -> Tuple[Dict, Dict]:
        """
        Evaluate both progress updates and final output.

        Args:
            task: The original task description
            progress_updates: List of progress updates
            final_result: Final result data
            files_created: List of files created
            test_summary: Test run summary

        Returns:
            Tuple of (progress_evaluation, output_evaluation)
        """
        logger.info("🎯 Starting complete test run evaluation")

        # Score progress updates
        progress_eval = await self.score_progress_updates(progress_updates, task)

        # Score final output
        output_eval = await self.score_final_output(
            task,
            final_result,
            files_created,
            test_summary
        )

        # Calculate overall score
        overall_score = int((progress_eval['score'] + output_eval['score']) / 2)

        logger.info(f"✅ Evaluation complete:")
        logger.info(f"   Progress: {progress_eval['score']}/100")
        logger.info(f"   Output: {output_eval['score']}/100")
        logger.info(f"   Overall: {overall_score}/100")

        return progress_eval, output_eval

    async def _call_llm(self, prompt: str) -> str:
        """
        Call the Cortex LLM API.

        Args:
            prompt: The prompt to send

        Returns:
            LLM response text
        """
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
                    "content": "You are an expert evaluator. Always respond with valid JSON only, no markdown formatting or extra text."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.3,  # Low temperature for consistent evaluation
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

                    # Extract content from OpenAI-format response
                    content = data['choices'][0]['message']['content']

                    # Remove markdown code fences if present
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
