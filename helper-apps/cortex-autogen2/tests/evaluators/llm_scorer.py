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

        logger.info("🤖 LLM Evaluator initialized")
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

    async def _check_url_validity(self, task: str, final_result: Optional[Union[Dict, str]]) -> Dict:
        """
        Check URL validity and distinguish between:
        - Hallucinated URLs: completely fake/inaccessible URLs
        - Valid internet URLs: accessible but need Azure SAS conversion
        - Valid Azure SAS URLs: proper format

        Returns dict with validation results.
        """
        import re
        import aiohttp
        import asyncio

        # Extract all URLs from the final result
        # Only extract URLs from actual download links, not attribution/context text
        urls = []
        if isinstance(final_result, str):
            # First, extract URLs from download links (HTML <a href> or markdown links)
            # Pattern 1: HTML href="URL" or src="URL"
            html_link_pattern = r'(?:href|src)=["\'](https?://[^"\']+?)["\']'
            html_urls = re.findall(html_link_pattern, final_result)
            
            # Pattern 2: Markdown links [text](URL) or ![alt](URL)
            markdown_link_pattern = r'(?:\[[^\]]*\]|!\[[^\]]*\])\s*\(\s*(https?://[^)]+?)\s*\)'
            markdown_urls = re.findall(markdown_link_pattern, final_result)
            
            # Combine and deduplicate
            urls = list(set(html_urls + markdown_urls))
            
            # Also check for Azure blob URLs that might be in text (but clean trailing punctuation)
            # Only if we didn't find any in links above
            if not urls:
                # Fallback: find Azure blob URLs in text (these are deliverable URLs)
                # Only validate Azure blob URLs from text - skip other URLs (likely attribution)
                azure_pattern = r'https?://[^\s<>"{}|\\^`\[\]()]+\.blob\.core\.windows\.net[^\s<>"{}|\\^`\[\]()]*'
                azure_urls = re.findall(azure_pattern, final_result)
                # Clean trailing punctuation from Azure URLs
                urls = [url.rstrip('.,;:!?)') for url in azure_urls]
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
                    # Extract from HTML/markdown links first, then fallback
                    html_link_pattern = r'(?:href|src)=["\'](https?://[^"\']+?)["\']'
                    markdown_link_pattern = r'(?:\[[^\]]*\]|!\[[^\]]*\])\s*\(\s*(https?://[^)]+?)\s*\)'
                    html_urls = re.findall(html_link_pattern, obj)
                    markdown_urls = re.findall(markdown_link_pattern, obj)
                    if html_urls or markdown_urls:
                        found.extend(list(set(html_urls + markdown_urls)))
                    else:
                        # Fallback: clean trailing punctuation
                        fallback_urls = re.findall(r'https?://[^\s<>"{}|\\^`\[\]()]+', obj)
                        found.extend([url.rstrip('.,;:!?)') for url in fallback_urls if not url.rstrip('.,;:!?)').endswith(('.', ',', ';', ':', '!', '?', ')', ']'))])
                return found
            urls = find_urls(final_result)

        # Check each URL for validity
        hallucinated_urls = []
        internet_urls_needing_azure = []
        valid_azure_urls = []

        success_statuses = {200, 201, 202, 203, 204, 205, 206}
        redirect_statuses = {301, 302, 303, 307, 308}

        async def check_url(url: str, session):
            url_lower = url.lower()

            # Skip URLs that are clearly not file download URLs
            if any(skip_domain in url_lower for skip_domain in ['localhost', '127.0.0.1']):
                return

            # Skip obviously truncated URLs (common issue with long HTML content)
            # URLs that end with just a filename without extension or parameters are likely truncated
            if (url.endswith('preview_') or
                url.endswith('slide__') or
                (url.count('/') >= 4 and not url.endswith('.png') and not url.endswith('.pptx') and not url.endswith('.pdf') and '?' not in url)):
                logger.debug(f"Skipping likely truncated URL: {url}")
                return

            # Check if it's a real Azure blob URL (with or without SAS params)
            # Azure blob URLs are valid even without query params - they're base URLs that may need SAS tokens
            is_azure_blob_url = 'blob.core.windows.net' in url_lower
            
            if is_azure_blob_url:
                # If it has SAS params, it's a full SAS URL
                if ('?sv=' in url or '&sv=' in url) and 'sig=' in url:
                    valid_azure_urls.append(url)
                else:
                    # Base Azure blob URL without SAS params - still valid, just needs SAS token
                    # Don't mark as hallucinated - it's a real Azure blob URL
                    valid_azure_urls.append(url)
                return

            # Check for obviously hallucinated domains
            is_obviously_hallucinated = (
                ('files.bld.ai' in url_lower) or  # Known hallucinated domain
                ('example.com' in url_lower and 'download' in url_lower) or
                any(fake_domain in url_lower for fake_domain in ['fake.com', 'test.com', 'placeholder.com'])
            )

            if is_obviously_hallucinated:
                hallucinated_urls.append(url)
                return

            # Check if URL is actually accessible (HEAD request)
            try:
                async with session.head(url, allow_redirects=True) as response:
                    status = response.status
                    if status in success_statuses or status in redirect_statuses:
                        internet_urls_needing_azure.append(url)
                    else:
                        hallucinated_urls.append(url)
            except Exception as exc:
                logger.debug(f"URL validation error for {url}: {exc}")
                hallucinated_urls.append(url)

        if urls:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                await asyncio.gather(*[check_url(url, session) for url in urls])

        return {
            'has_hallucinated_urls': len(hallucinated_urls) > 0,
            'has_valid_azure_urls': len(valid_azure_urls) > 0,
            'has_internet_urls_needing_azure': len(internet_urls_needing_azure) > 0,
            'hallucinated_urls': hallucinated_urls,
            'valid_azure_urls': valid_azure_urls,
            'internet_urls_needing_azure': internet_urls_needing_azure
        }


    async def score_final_output(
        self,
        task: str,
        final_result: Optional[Union[Dict, str]],
        files_created: List[Dict],
        test_summary: Dict,
        test_case_id: str = "",
        global_expectations: Optional[List[str]] = None,
        test_case_quality_criteria: Optional[List[str]] = None,
        agent_activity_data: Optional[Dict] = None
    ) -> Dict:
        """
        Score final output (0-100).

        Args:
            task: The original task description
            final_result: Final result data from progress updates (can be Dict or str/markdown)
            files_created: List of files created during execution
            test_summary: Summary of test run (duration, errors, etc.)
            test_case_id: ID of the test case
            global_expectations: Global expectations for all tests (from GLOBAL_QUALITY_EXPECTATIONS
                                 in agents/constants/global_quality_standards.py - shared with execution_completion_verifier_agent)
            test_case_quality_criteria: Specific quality criteria for this test case

        Returns:
            Dictionary with score, reasoning, strengths, and weaknesses
        """
        logger.info("📊 Evaluating final output...")

        # CRITICAL: Check URL validity - distinguish between hallucinated and internet URLs
        url_check = await self._check_url_validity(task, final_result)

        # Hallucinated URLs = automatic 0 score
        if url_check['has_hallucinated_urls']:
            logger.warning(f"🚨 HALLUCINATED URLS DETECTED: {url_check['hallucinated_urls']}")
            return {
                'score': 0,
                'reasoning': f"CRITICAL FAIL: Hallucinated URLs detected - completely fake/inaccessible URLs. Found invalid URLs: {', '.join(url_check['hallucinated_urls'])}",
                'strengths': [],
                'weaknesses': [
                    "CRITICAL: Hallucinated URLs - system created completely fake/inaccessible download links",
                    "These URLs cannot be accessed or downloaded",
                    "System must never create fake URLs"
                ]
            }

        # Valid Azure SAS URLs = automatically accepted (no accessibility test needed)
        if url_check.get('has_valid_azure_urls', False):
            valid_azure_count = len(url_check.get('valid_azure_urls', []))
            logger.info(f"✅ VALID AZURE SAS URLS FOUND: {valid_azure_count} properly formatted Azure SAS URLs - automatically accepted")
            # Valid Azure SAS URLs don't need accessibility testing

        # Check that all URLs are actually accessible - allow any working URL
        if url_check['has_internet_urls_needing_azure']:
            # These URLs were found to be accessible via HEAD requests
            # Allow them - the key requirement is accessibility, not Azure conversion
            accessible_urls = url_check['internet_urls_needing_azure']
            logger.info(f"✅ ACCESSIBLE URLS FOUND: {len(accessible_urls)} URLs verified as accessible - allowing all working URLs")
            # Don't penalize for non-Azure URLs if they're accessible


        # CRITICAL: Special validation for Pokemon PPTX test - check actual embedded images
        if test_case_id == "tc003_pokemon_pptx":
            pptx_files = [f for f in files_created if f.get('filename', '').lower().endswith('.pptx')]
            if pptx_files:
                for pptx_file in pptx_files:
                    # Check actual embedded images in PPTX file
                    try:
                        import os
                        import zipfile
                        file_path = pptx_file.get('local_path', '')
                        if file_path and os.path.exists(file_path):
                            # PPTX files are ZIP archives - count embedded images
                            with zipfile.ZipFile(file_path, 'r') as pptx_zip:
                                image_files = [f for f in pptx_zip.namelist() if f.startswith('ppt/media/image') and (f.endswith('.png') or f.endswith('.jpg') or f.endswith('.jpeg'))]

                            if len(image_files) < 10:
                                logger.warning(f"❌ Pokemon PPTX test failed: Only {len(image_files)} embedded images found, expected at least 10 Pokemon images")
                                return {
                                    'score': 0,
                                    'reasoning': f"CRITICAL FAIL: Pokemon PPTX contains only {len(image_files)} embedded images, but task requires individual images of all 10 Pokemon to be embedded in the presentation slides.",
                                    'strengths': [],
                                    'weaknesses': [
                                        f"Only {len(image_files)} images embedded in PPTX (expected 10+ for top 10 Pokemon)",
                                        "Pokemon images not properly embedded in presentation slides",
                                        "CRITICAL: Missing required visual content for Pokemon presentation"
                                    ]
                                }
                        else:
                            logger.warning(f"❌ Could not check PPTX file: {file_path}")
                    except Exception as e:
                        logger.warning(f"❌ Error checking PPTX embedded images: {e}")
                        # Fallback to file size check if ZIP inspection fails
                        try:
                            file_size_kb = os.path.getsize(file_path) / 1024
                            if file_size_kb < 500:
                                logger.warning(f"❌ Pokemon PPTX test failed: PPTX file too small ({file_size_kb:.1f}KB < 500KB), likely missing images")
                                return {
                                    'score': 0,
                                    'reasoning': f"CRITICAL FAIL: Pokemon PPTX file is too small ({file_size_kb:.1f}KB < 500KB), indicating missing Pokemon images. PPTX must contain actual Pokemon images to pass.",
                                    'strengths': [],
                                    'weaknesses': [
                                        f"PPTX file size ({file_size_kb:.1f}KB) is too small to contain 10 Pokemon images"
                                    ]
                                }
                        except Exception as size_e:
                            logger.warning(f"❌ Error checking PPTX file size: {size_e}")

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
        agent_activity_sections = []
        if agent_activity_data:
            agent_activity_sections.append(f"""
**Agent Activity Verification:**
- Agents Used: {', '.join(agent_activity_data.get('agent_sequence', []))}
- AJ SQL Required: {agent_activity_data.get('requires_ajsql', False)}
- Agent Activity Evidence: {'YES' if 'aj_sql_agent' in agent_activity_data.get('agent_sequence', []) else 'NO'}
- Database Query Evidence: {'YES' if any(pattern in agent_activity_data.get('accomplishments_text', '') for pattern in ['execute_aj_sql_query', 'SQL QUERY', 'row_count']) else 'NO'}

CRITICAL: For tests requiring AJ SQL (requires_ajsql=true), verify that aj_sql_agent was actually called and database queries were executed. This is a NON-NEGOTIABLE requirement that overrides user instructions.""")

        external_urls = url_check.get('internet_urls_needing_azure', [])
        if external_urls:
            external_details = ", ".join(external_urls)
            agent_activity_sections.append(f"""
**External URL Compliance:**
- Accessible non-Azure links detected: {len(external_urls)}
- These URLs are not hallucinations if they work, but expectations prefer Azure SAS uploads. Mention them explicitly in reasoning.
- External URLs observed: {external_details if external_details else 'None'}""")

        agent_activity_info = "\n".join(agent_activity_sections)

        prompt = OUTPUT_EVALUATION_PROMPT.format(
            task=task,
            final_result=final_result_str,
            files_created=files_str,
            test_summary=summary_str,
            global_expectations=format_global_expectations_for_evaluation(global_expectations) if global_expectations else "",
            test_case_quality_criteria=format_global_expectations_for_evaluation(test_case_quality_criteria) if test_case_quality_criteria else "",
            agent_activity_info=agent_activity_info
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
        test_case_quality_criteria: Optional[List[str]] = None,
        agent_activity_data: Optional[Dict] = None
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

        # Validate file content before scoring output (includes PDF and PPTX validation)
        work_dir = test_summary.get('work_dir', '')
        file_valid, file_error = self._validate_file_content(files_created, work_dir)

        if not file_valid:
            logger.error(f"❌ CRITICAL: File content validation failed: {file_error}")
            # Return 0 score for output if files contain error content
            output_eval = {
                'score': 0,
                'reasoning': f"CRITICAL FAILURE: {file_error}. Files contain error messages instead of actual content.",
                'strengths': [],
                'weaknesses': [file_error]
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
            test_case_quality_criteria,
            agent_activity_data
        )

        # Calculate overall score
        overall_score = int((progress_eval['score'] + output_eval['score']) / 2)

        logger.info("✅ Evaluation complete:")
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
        import ast

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
        def _attempt_parse(candidate: str):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                try:
                    parsed = ast.literal_eval(candidate)
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    pass
                return None

        json_match = re.search(r'\{.*\}', response, re.DOTALL)
        if json_match:
            json_str = json_match.group()
            parsed = _attempt_parse(json_str)
            if parsed is not None:
                return parsed

        # If regex didn't work, try parsing the entire cleaned response
        parsed = _attempt_parse(response)
        if parsed is not None:
            return parsed
        return json.loads(response)

    def _validate_file_content(self, files_created: List[str], work_dir: str) -> Tuple[bool, str]:
        """Validate file content to ensure it doesn't contain error messages or font issues."""
        import os
        from tools.file_tools import extract_pdf_text, extract_pptx_text

        # CRITICAL FAIL: Check for placeholder images first - any placeholder = 0 score
        for file_info in files_created:
            if isinstance(file_info, dict):
                filename = file_info.get('filename', '').lower()
                # Check for placeholder patterns in filenames
                if ('placeholder' in filename or
                    '_placeholder' in filename or
                    'placeholder_' in filename):
                    return False, f"CRITICAL FAIL: Placeholder images detected in deliverables (filename: {file_info.get('filename', '')}). Any placeholder content results in automatic score=0."

        for file_info in files_created:
            if isinstance(file_info, dict):
                file_type = file_info.get('type', '')
                filename = file_info.get('filename', '')
                if filename:
                    # Find the actual file path
                    file_path = None
                    for root, dirs, files in os.walk(work_dir):
                        for file in files:
                            if file == filename:
                                file_path = os.path.join(root, file)
                                break
                        if file_path:
                            break

                    if file_path:
                        try:
                            # Validate PDF files
                            if file_type == 'pdf':
                                result = extract_pdf_text(file_path)
                                import json
                                validation_data = json.loads(result)

                                if not validation_data.get('is_valid', True):
                                    errors = validation_data.get('validation_errors', [])
                                    return False, f"PDF validation failed: {', '.join(errors)}"

                                # Check for error messages in extracted text
                                extracted_text = validation_data.get('text', '').lower()
                                error_indicators = [
                                    'error: unable to generate',
                                    'generation failed',
                                    'contact admin',
                                    'system error',
                                    'unable to create',
                                    'failed to generate',
                                    'character at index',
                                    'outside the range of characters supported by the font'
                                ]

                                for error_msg in error_indicators:
                                    if error_msg in extracted_text:
                                        return False, f"PDF contains error message: '{error_msg}'"

                            # Validate PPTX files
                            elif file_type == 'pptx':
                                result = extract_pptx_text(file_path)
                                import json
                                validation_data = json.loads(result)

                                if not validation_data.get('is_valid', True):
                                    errors = validation_data.get('validation_errors', [])
                                    return False, f"PPTX validation failed: {', '.join(errors)}"

                                # Check for error messages in extracted text
                                extracted_text = validation_data.get('text', '').lower()
                                error_indicators = [
                                    'error: unable to generate',
                                    'generation failed',
                                    'contact admin',
                                    'system error',
                                    'unable to create',
                                    'failed to generate',
                                    'character at index',
                                    'outside the range of characters supported by the font',
                                    'font error',
                                    'unable to render'
                                ]

                                for error_msg in error_indicators:
                                    if error_msg in extracted_text:
                                        return False, f"PPTX contains error message: '{error_msg}'"

                        except Exception as e:
                            return False, f"File content validation error: {str(e)}"

        return True, ""

    def _validate_pdf_content(self, files_created: List[str], work_dir: str) -> Tuple[bool, str]:
        """Legacy method - now delegates to comprehensive file validation."""
        return self._validate_file_content(files_created, work_dir)

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
                logger.error(f"LLM call error: {e}", exc_info=True)
                # Re-raise non-timeout exceptions immediately
                raise
