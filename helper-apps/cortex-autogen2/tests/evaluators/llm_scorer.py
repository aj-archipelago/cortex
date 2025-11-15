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
from typing import Dict, List, Optional, Tuple, Union
from .prompts import (
    PROGRESS_EVALUATION_PROMPT,
    OUTPUT_EVALUATION_PROMPT,
    format_progress_updates_for_evaluation,
    format_files_for_evaluation,
    format_test_summary_for_evaluation,
    format_global_expectations_for_evaluation
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

            # Parse JSON response with robust handling
            evaluation = self._parse_llm_json_response(result)

            logger.info(f"   Progress Score: {evaluation['score']}/100")
            return evaluation

        except (json.JSONDecodeError, ValueError) as e:
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

    def _check_for_hallucinated_urls(self, task: str, final_result: Optional[Union[Dict, str]]) -> Dict:
        """
        Check if the output contains hallucinated URLs that are not real Azure SAS URLs.
        Returns dict with 'is_hallucinated' bool and list of invalid URLs.
        """
        import re

        # Extract all URLs from the final result
        urls = []
        if isinstance(final_result, str):
            # Find all URLs in the string
            url_pattern = r'https?://[^\s<>"{}|\\^`\[\]]+'
            urls = re.findall(url_pattern, final_result)
        elif isinstance(final_result, dict):
            # Recursively find URLs in dict values
            def find_urls(obj):
                found = []
                if isinstance(obj, dict):
                    for value in obj.values():
                        found.extend(find_urls(value))
                elif isinstance(obj, list):
                    for item in obj:
                        found.extend(find_urls(item))
                elif isinstance(obj, str):
                    found.extend(re.findall(r'https?://[^\s<>"{}|\\^`\[\]]+', obj))
                return found
            urls = find_urls(final_result)

        # Check each URL for validity
        hallucinated_urls = []
        for url in urls:
            url_lower = url.lower()

            # Skip URLs that are clearly not file download URLs
            if any(skip_domain in url_lower for skip_domain in ['localhost', '127.0.0.1', 'example.com']):
                continue

            # Check if it's a real Azure SAS URL
            is_real_azure_url = (
                'blob.core.windows.net' in url_lower and
                ('?sv=' in url or '&sv=' in url) and  # SAS version parameter
                ('sig=' in url)  # SAS signature parameter
            )

            # Check for hallucinated domains
            is_hallucinated = (
                ('files.bld.ai' in url_lower) or  # Our test showed this hallucinated domain
                ('example.com' in url_lower and 'download' in url_lower) or
                (not is_real_azure_url and any(file_ext in url_lower for file_ext in ['.pptx', '.pdf', '.csv', '.png', '.xlsx']))
            )

            if is_hallucinated:
                hallucinated_urls.append(url)

        return {
            'is_hallucinated': len(hallucinated_urls) > 0,
            'hallucinated_urls': hallucinated_urls
        }


    async def score_final_output(
        self,
        task: str,
        final_result: Optional[Union[Dict, str]],
        files_created: List[Dict],
        test_summary: Dict,
        test_case_id: str = "",
        global_expectations: Optional[List[str]] = None,
        test_case_quality_criteria: Optional[List[str]] = None
    ) -> Dict:
        """
        Score final output (0-100).

        Args:
            task: The original task description
            final_result: Final result data from progress updates (can be Dict or str/markdown)
            files_created: List of files created during execution
            test_summary: Summary of test run (duration, errors, etc.)
            test_case_id: ID of the test case
            global_expectations: Global expectations for all tests
            test_case_quality_criteria: Specific quality criteria for this test case

        Returns:
            Dictionary with score, reasoning, strengths, and weaknesses
        """
        logger.info(f"📊 Evaluating final output...")

        # CRITICAL: Check for hallucinated URLs - automatic 0 score
        hallucination_check = self._check_for_hallucinated_urls(task, final_result)
        if hallucination_check['is_hallucinated']:
            logger.warning(f"🚨 HALLUCINATED URLS DETECTED: {hallucination_check['hallucinated_urls']}")
            return {
                'score': 0,
                'reasoning': f"CRITICAL FAIL: Hallucinated URLs detected. Real Azure SAS URLs must contain 'blob.core.windows.net' and SAS tokens. Found invalid URLs: {', '.join(hallucination_check['hallucinated_urls'])}",
                'strengths': [],
                'weaknesses': [
                    "CRITICAL: Hallucinated URLs - system created fake download links",
                    "Real Azure SAS URLs must contain 'blob.core.windows.net' domain",
                    "URLs must include SAS token parameters (?sv=, sig=, etc.)",
                    "System must never create fake URLs - only use real Azure Blob Storage URLs"
                ]
            }


        # CRITICAL: Special validation for Pokemon PPTX test - check file size for image content
        if test_case_id == "tc001_pokemon_pptx":
            pptx_files = [f for f in files_created if f.get('filename', '').lower().endswith('.pptx')]
            if pptx_files:
                for pptx_file in pptx_files:
                    # Check if PPTX file size indicates it contains images (>500KB)
                    try:
                        import os
                        file_path = pptx_file.get('local_path', '')
                        if file_path and os.path.exists(file_path):
                            file_size_kb = os.path.getsize(file_path) / 1024
                            if file_size_kb < 500:
                                logger.warning(f"❌ Pokemon PPTX test failed: PPTX file too small ({file_size_kb:.1f}KB < 500KB), likely missing images")
                                return {
                                    'score': 0,
                                    'reasoning': f"CRITICAL FAIL: Pokemon PPTX file is too small ({file_size_kb:.1f}KB < 500KB), indicating missing Pokemon images. PPTX must contain actual Pokemon images to pass.",
                                    'strengths': [],
                                    'weaknesses': [
                                        "CRITICAL: PPTX file lacks image content (file size too small)",
                                        "Pokemon PPTX must include actual Pokemon images",
                                        "File size <500KB indicates missing or no images in presentation",
                                        "Test requires visual Pokemon content, not empty slides"
                                    ]
                                }
                        else:
                            logger.warning(f"❌ Could not check PPTX file size: {file_path}")
                    except Exception as e:
                        logger.warning(f"❌ Error checking PPTX file size: {e}")

        # Format data for prompt
        # CRITICAL: final_result can be a string (markdown) or dict - handle both cases
        if final_result is None:
            final_result_str = "No final result data"
        elif isinstance(final_result, str):
            # If it's a string (markdown), use it directly - don't JSON-dump it!
            # JSON-dumping a string would escape it and break URL extraction
            final_result_str = final_result
        else:
            # If it's a dict, JSON-dump it
            final_result_str = json.dumps(final_result, indent=2)
        files_str = format_files_for_evaluation(files_created)
        summary_str = format_test_summary_for_evaluation(test_summary)

        # Build prompt
        prompt = OUTPUT_EVALUATION_PROMPT.format(
            task=task,
            final_result=final_result_str,
            files_created=files_str,
            test_summary=summary_str,
            global_expectations=format_global_expectations_for_evaluation(global_expectations) if global_expectations else "",
            test_case_quality_criteria=format_global_expectations_for_evaluation(test_case_quality_criteria) if test_case_quality_criteria else ""
        )

        # Call LLM
        try:
            result = await self._call_llm(prompt)

            # Parse JSON response with robust handling
            evaluation = self._parse_llm_json_response(result)

            logger.info(f"   Output Score: {evaluation['score']}/100")
            return evaluation

        except (json.JSONDecodeError, ValueError) as e:
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
        final_result: Optional[Union[Dict, str]],
        files_created: List[Dict],
        test_summary: Dict,
        test_case_id: str = "",
        global_expectations: Optional[List[str]] = None,
        test_case_quality_criteria: Optional[List[str]] = None
    ) -> Tuple[Dict, Dict]:
        """
        Evaluate both progress updates and final output.

        Args:
            task: The original task description
            progress_updates: List of progress updates
            final_result: Final result data
            files_created: List of files created
            test_summary: Test run summary
            test_case_id: ID of the test case
            global_expectations: Global expectations for all tests
            test_case_quality_criteria: Specific quality criteria for this test case

        Returns:
            Tuple of (progress_evaluation, output_evaluation)
        """
        logger.info("🎯 Starting complete test run evaluation")

        # Score progress updates
        progress_eval = await self.score_progress_updates(progress_updates, task)

        # Validate PDF content before scoring output
        work_dir = test_summary.get('work_dir', '')
        pdf_valid, pdf_error = self._validate_pdf_content(files_created, work_dir)

        if not pdf_valid:
            logger.error(f"❌ CRITICAL: PDF validation failed: {pdf_error}")
            # Return 0 score for output if PDF contains error content
            output_eval = {
                'score': 0,
                'reasoning': f"CRITICAL FAILURE: {pdf_error}. PDF contains error messages instead of actual content.",
                'strengths': [],
                'weaknesses': [pdf_error]
            }
        else:
            # Score final output normally
            output_eval = await self.score_final_output(
            task,
            final_result,
            files_created,
            test_summary,
            test_case_id,
            global_expectations,
            test_case_quality_criteria
        )

        # Calculate overall score
        overall_score = int((progress_eval['score'] + output_eval['score']) / 2)

        logger.info(f"✅ Evaluation complete:")
        logger.info(f"   Progress: {progress_eval['score']}/100")
        logger.info(f"   Output: {output_eval['score']}/100")
        logger.info(f"   Overall: {overall_score}/100")

        return progress_eval, output_eval

    def _parse_llm_json_response(self, response: str) -> dict:
        """
        Parse JSON response from LLM, handling various formats and edge cases.

        Args:
            response: Raw LLM response text

        Returns:
            Parsed JSON dictionary

        Raises:
            json.JSONDecodeError: If response cannot be parsed as JSON
        """
        import re

        # Debug logging for failed parses
        logger.debug(f"🤖 Raw LLM response: {response[:500]}...")

        # Clean the response
        response = response.strip()

        # Remove markdown code blocks
        if response.startswith('```json'):
            response = response[7:]
        elif response.startswith('```'):
            response = response[3:]
        if response.endswith('```'):
            response = response[:-3]

        response = response.strip()

        # Try to find JSON object in the response using regex
        json_match = re.search(r'\{.*\}', response, re.DOTALL)
        if json_match:
            json_str = json_match.group()
            try:
                return json.loads(json_str)
            except json.JSONDecodeError:
                pass

        # If regex didn't work, try parsing the entire cleaned response
        return json.loads(response)

    def _validate_pdf_content(self, files_created: List[str], work_dir: str) -> Tuple[bool, str]:
        """Validate PDF content to ensure it doesn't contain error messages."""
        import os
        from tools.file_tools import extract_pdf_text

        for file_info in files_created:
            if isinstance(file_info, dict) and file_info.get('type') == 'pdf':
                filename = file_info.get('filename', '')
                if filename:
                    # Find the actual file path
                    pdf_path = None
                    for root, dirs, files in os.walk(work_dir):
                        for file in files:
                            if file == filename:
                                pdf_path = os.path.join(root, file)
                                break
                        if pdf_path:
                            break

                    if pdf_path:
                        try:
                            result = extract_pdf_text(pdf_path)
                            import json
                            validation_data = json.loads(result)

                            if not validation_data.get('is_valid', True):
                                errors = validation_data.get('validation_errors', [])
                                return False, f"PDF validation failed: {', '.join(errors)}"
                        except Exception as e:
                            return False, f"PDF validation error: {str(e)}"

        return True, ""

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
