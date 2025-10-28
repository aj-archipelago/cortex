"""
Test orchestrator for automating Cortex AutoGen2 test execution.

Coordinates task submission, data collection, evaluation, and storage.
"""

import os
import sys
import yaml
import uuid
import json
import base64
import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional
from pathlib import Path

# Add parent directory to path to import project modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from azure.storage.queue import QueueClient
from tests.database.repository import TestRepository
from tests.collectors.progress_collector import ProgressCollector
from tests.collectors.log_collector import LogCollector
from tests.evaluators.llm_scorer import LLMEvaluator
from tests.metrics.collector import MetricsCollector
from tests.utils.connectivity import check_ajsql_connectivity

logger = logging.getLogger(__name__)


class TestOrchestrator:
    """Orchestrates end-to-end test execution and evaluation."""

    def __init__(
        self,
        db_path: Optional[str] = None,
        redis_url: Optional[str] = None,
        redis_channel: Optional[str] = None
    ):
        """
        Initialize the test orchestrator.

        Args:
            db_path: Path to SQLite database (defaults to tests/database/test_results.db)
            redis_url: Redis connection URL (defaults to env var)
            redis_channel: Redis channel name (defaults to env var)
        """
        self.db = TestRepository(db_path)
        self.evaluator = LLMEvaluator()

        self.redis_url = redis_url or os.getenv("REDIS_CONNECTION_STRING", "redis://localhost:6379")
        self.redis_channel = redis_channel or os.getenv("REDIS_CHANNEL", "cortex_progress")

        self.azure_queue_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
        self.azure_queue_name = os.getenv("AZURE_QUEUE_NAME", "cortex-tasks")

        if not self.azure_queue_conn_str:
            raise ValueError("AZURE_STORAGE_CONNECTION_STRING environment variable must be set")

        logger.info("🎬 Test Orchestrator initialized")
        logger.info(f"   Redis: {self.redis_url}")
        logger.info(f"   Queue: {self.azure_queue_name}")

    def load_test_cases(self, test_cases_path: Optional[str] = None) -> List[Dict]:
        """
        Load test cases from YAML file.

        Args:
            test_cases_path: Path to test_cases.yaml (defaults to tests/test_cases.yaml)

        Returns:
            List of test case dictionaries
        """
        if test_cases_path is None:
            test_cases_path = Path(__file__).parent / "test_cases.yaml"

        with open(test_cases_path, 'r') as f:
            data = yaml.safe_load(f)

        test_cases = data.get('test_cases', [])
        logger.info(f"📋 Loaded {len(test_cases)} test cases")

        return test_cases

    async def run_test(self, test_case: Dict) -> Dict:
        """
        Run a single test case end-to-end.

        Args:
            test_case: Test case dictionary from YAML

        Returns:
            Complete test results including scores and metrics
        """
        test_case_id = test_case['id']
        task_description = test_case['task']
        timeout = test_case.get('timeout_seconds', 300)
        requires_ajsql = test_case.get('requires_ajsql', False)

        logger.info(f"\n{'='*80}")
        logger.info(f"🧪 Running Test: {test_case['name']}")
        logger.info(f"   ID: {test_case_id}")
        logger.info(f"   Timeout: {timeout}s")
        if requires_ajsql:
            logger.info(f"   Requires AJ SQL: Yes")
        logger.info(f"{'='*80}\n")

        # Check AJ SQL connectivity if required
        if requires_ajsql:
            logger.info("🔍 Checking AJ SQL database connectivity...")
            is_accessible, message = check_ajsql_connectivity()

            if not is_accessible:
                logger.warning(f"⚠️ AJ SQL database not accessible: {message}")
                logger.warning(f"⏭️ SKIPPING test {test_case_id} - requires AJ SQL database access")

                return {
                    'test_case_id': test_case_id,
                    'status': 'skipped',
                    'skip_reason': f'AJ SQL database not accessible: {message}',
                    'message': 'Test skipped due to missing database access (likely IP restriction)'
                }
            else:
                # Note: Success message already logged by check_ajsql_connectivity()
                pass

        # Generate unique request ID
        request_id = f"test_{test_case_id}_{uuid.uuid4().hex[:8]}"

        # Create test run record in database
        test_run_id = self.db.create_test_run(
            test_case_id=test_case_id,
            task_description=task_description,
            request_id=request_id
        )

        logger.info(f"📝 Test run created: ID={test_run_id}, Request={request_id}")

        # Start collectors
        progress_collector = ProgressCollector(self.redis_url, self.redis_channel)
        log_collector = LogCollector()

        # Submit task to Azure Queue
        try:
            azure_message_id = await self._submit_task(request_id, task_description)
            logger.info(f"✅ Task submitted to queue (Azure message ID: {azure_message_id})")
        except Exception as e:
            logger.error(f"❌ Failed to submit task: {e}")
            self.db.update_test_run_status(test_run_id, 'failed', error_message=str(e))
            return {'test_run_id': test_run_id, 'status': 'failed', 'error': str(e)}

        # Collect data concurrently
        # NOTE: Use Azure Queue message ID, not our custom request_id!
        # The system publishes progress updates with the Azure Queue message ID.
        try:
            logger.info(f"📡 Starting data collection...")

            # Run collectors concurrently - use Azure message ID for progress tracking!
            progress_task = asyncio.create_task(
                progress_collector.start_collecting(azure_message_id, timeout=timeout)
            )
            log_task = asyncio.create_task(
                log_collector.start_collecting(azure_message_id, timeout=timeout)
            )

            # Wait for both to complete
            progress_updates, logs = await asyncio.gather(progress_task, log_task)

            logger.info(f"✅ Data collection complete")
            logger.info(f"   Progress updates: {len(progress_updates)}")
            logger.info(f"   Log entries: {len(logs)}")

        except Exception as e:
            logger.error(f"❌ Data collection error: {e}", exc_info=True)
            self.db.update_test_run_status(test_run_id, 'failed', error_message=str(e))
            return {'test_run_id': test_run_id, 'status': 'failed', 'error': str(e)}

        # Store progress updates and logs in database
        for update in progress_updates:
            self.db.add_progress_update(
                test_run_id=test_run_id,
                timestamp=datetime.fromisoformat(update['timestamp']),
                progress=update.get('progress', 0.0),
                info=update.get('info', ''),
                is_final=update.get('data') is not None
            )

        for log_entry in logs:
            self.db.add_log(
                test_run_id=test_run_id,
                timestamp=datetime.fromisoformat(log_entry['timestamp']),
                level=log_entry.get('level', 'INFO'),
                agent=log_entry.get('agent'),
                message=log_entry.get('message', '')
            )

        # Get final result
        final_result = progress_collector.get_final_result()

        # Save final response to database if available
        if final_result:
            try:
                # final_result can be either a string or a dict
                if isinstance(final_result, str):
                    final_response_text = final_result
                elif isinstance(final_result, dict):
                    # Try to extract text from dict (could have 'message', 'text', or other fields)
                    final_response_text = final_result.get('message') or final_result.get('text') or str(final_result)
                else:
                    final_response_text = str(final_result)

                self.db.save_final_response(test_run_id, final_response_text)
                logger.info(f"💾 Saved final response to database ({len(final_response_text)} chars)")
            except Exception as e:
                logger.warning(f"⚠️ Failed to save final response to database: {e}")

        # Update test run status
        status = 'completed' if len(progress_updates) > 0 else 'timeout'
        self.db.update_test_run_status(test_run_id, status)

        test_run_data = self.db.get_test_run(test_run_id)

        # Extract files from final result if available
        files_created = []
        if final_result and isinstance(final_result, dict):
            deliverables = final_result.get('deliverables', [])
            for item in deliverables:
                if isinstance(item, dict):
                    self.db.add_file(
                        test_run_id=test_run_id,
                        file_path=item.get('path', 'unknown'),
                        file_type=item.get('type', 'unknown'),
                        sas_url=item.get('sas_url')
                    )
            files_created = self.db.get_files(test_run_id)

        # Calculate metrics
        logger.info(f"\n📊 Calculating metrics...")
        metrics = MetricsCollector.calculate_metrics(
            test_run_data,
            progress_updates,
            logs,
            files_created
        )

        self.db.save_metrics(test_run_id, **metrics)

        # Run LLM evaluation
        logger.info(f"\n🤖 Running LLM evaluation...")

        test_summary = {
            'duration_seconds': test_run_data.get('duration_seconds', 0),
            'total_progress_updates': metrics.get('total_progress_updates', 0),
            'errors_count': metrics.get('errors_count', 0),
            'warnings_count': metrics.get('warnings_count', 0)
        }

        try:
            progress_eval, output_eval = await self.evaluator.evaluate_test_run(
                task=task_description,
                progress_updates=progress_updates,
                final_result=final_result,
                files_created=files_created,
                test_summary=test_summary
            )

            # Store evaluation in database
            self.db.save_evaluation(
                test_run_id=test_run_id,
                progress_score=progress_eval['score'],
                output_score=output_eval['score'],
                progress_reasoning=progress_eval['reasoning'],
                output_reasoning=output_eval['reasoning'],
                progress_issues=progress_eval.get('issues', []),
                output_strengths=output_eval.get('strengths', []),
                output_weaknesses=output_eval.get('weaknesses', [])
            )

            logger.info(f"\n✨ Evaluation complete:")
            logger.info(f"   Progress Score: {progress_eval['score']}/100")
            logger.info(f"   Output Score: {output_eval['score']}/100")
            # Weighted: 75% output quality, 25% progress reporting (output matters most!)
            overall = int((output_eval['score'] * 0.75) + (progress_eval['score'] * 0.25))
            logger.info(f"   Overall Score: {overall}/100")

        except Exception as e:
            logger.error(f"❌ Evaluation error: {e}", exc_info=True)
            progress_eval = {'score': 0, 'reasoning': f"Evaluation failed: {str(e)}", 'issues': []}
            output_eval = {'score': 0, 'reasoning': f"Evaluation failed: {str(e)}", 'strengths': [], 'weaknesses': []}

        # Compile results
        results = {
            'test_run_id': test_run_id,
            'test_case_id': test_case_id,
            'request_id': request_id,
            'status': status,
            'duration_seconds': test_run_data.get('duration_seconds', 0),
            'progress_updates_count': len(progress_updates),
            'logs_count': len(logs),
            'files_created_count': len(files_created),
            'final_response': final_response_text if 'final_response_text' in locals() else '',
            'metrics': metrics,
            'progress_evaluation': progress_eval,
            'output_evaluation': output_eval,
            'overall_score': int((output_eval['score'] * 0.75) + (progress_eval['score'] * 0.25))
        }

        logger.info(f"\n{'='*80}")
        logger.info(f"✅ Test Complete: {test_case['name']}")
        logger.info(f"{'='*80}\n")

        return results

    async def run_all_tests(self, test_cases_path: Optional[str] = None) -> List[Dict]:
        """
        Run all test cases sequentially.

        Args:
            test_cases_path: Path to test_cases.yaml

        Returns:
            List of test results
        """
        test_cases = self.load_test_cases(test_cases_path)
        results = []

        logger.info(f"\n🚀 Running {len(test_cases)} test cases...\n")

        for i, test_case in enumerate(test_cases, 1):
            logger.info(f"\n{'#'*80}")
            logger.info(f"# Test {i}/{len(test_cases)}: {test_case['name']}")

            # Show progress summary for completed tests
            if results:
                completed_count = len(results)
                passed = sum(1 for r in results if r.get('overall_score', 0) > 80)
                avg_score = sum(r.get('overall_score', 0) for r in results) / completed_count
                logger.info(f"# Progress: {completed_count} completed | {passed} passed (>80) | Avg: {avg_score:.1f}/100")

            logger.info(f"{'#'*80}\n")

            result = await self.run_test(test_case)
            results.append(result)

        # Print summary
        self._print_summary(results)

        # Generate and save report
        logger.info(f"📄 Generating test report...")
        report = self._generate_test_report(results, test_cases)

        # Save report to file with timestamp
        from datetime import datetime
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        report_path = Path(__file__).parent.parent / f"TEST_RUN_RESULTS_{timestamp}.md"

        with open(report_path, 'w') as f:
            f.write(report)

        logger.info(f"📄 Test report saved to: {report_path}")
        logger.info(f"   You can review detailed results and final messages in this file.\n")

        return results

    async def _submit_task(self, request_id: str, task: str) -> str:
        """Submit task to Azure Queue and return the Azure Queue message ID."""
        queue_client = QueueClient.from_connection_string(
            self.azure_queue_conn_str,
            self.azure_queue_name
        )

        # Match send_task.py format exactly: "content" and "request_id"
        message_data = {
            "request_id": request_id,
            "message_id": str(uuid.uuid4()),
            "content": task
        }

        message_json = json.dumps(message_data)
        message_b64 = base64.b64encode(message_json.encode('utf-8')).decode('utf-8')

        result = queue_client.send_message(message_b64)
        queue_client.close()

        # Return the Azure Queue message ID - this is what the system uses for progress updates!
        return result.id

    def _print_summary(self, results: List[Dict]):
        """Print summary of all test results."""
        logger.info(f"\n\n{'='*80}")
        logger.info(f"📊 TEST SUMMARY")
        logger.info(f"{'='*80}\n")

        total_tests = len(results)
        skipped = sum(1 for r in results if r.get('status') == 'skipped')
        completed_results = [r for r in results if r.get('status') != 'skipped']
        completed_count = len(completed_results)

        passed = sum(1 for r in completed_results if r.get('overall_score', 0) > 80)
        failed = completed_count - passed

        total_progress_score = sum(r.get('progress_evaluation', {}).get('score', 0) for r in completed_results)
        total_output_score = sum(r.get('output_evaluation', {}).get('score', 0) for r in completed_results)
        total_overall_score = sum(r.get('overall_score', 0) for r in completed_results)

        avg_progress = total_progress_score / completed_count if completed_count > 0 else 0
        avg_output = total_output_score / completed_count if completed_count > 0 else 0
        avg_overall = total_overall_score / completed_count if completed_count > 0 else 0

        logger.info(f"Total Tests: {total_tests}")
        logger.info(f"Completed: {completed_count}")
        if skipped > 0:
            logger.info(f"Skipped: {skipped} (AJ SQL database not accessible)")
        logger.info(f"Passed (≥70): {passed}")
        logger.info(f"Failed (<70): {failed}")
        logger.info(f"")

        if completed_count > 0:
            logger.info(f"Average Scores:")
            logger.info(f"  Progress: {avg_progress:.1f}/100")
            logger.info(f"  Output: {avg_output:.1f}/100")
            logger.info(f"  Overall: {avg_overall:.1f}/100")

        logger.info(f"\n{'='*80}\n")

    def _generate_test_report(self, results: List[Dict], test_cases: List[Dict]) -> str:
        """Generate a comprehensive markdown test report."""
        from datetime import datetime

        # Calculate summary stats
        total_tests = len(results)
        skipped = sum(1 for r in results if r.get('status') == 'skipped')
        completed_results = [r for r in results if r.get('status') != 'skipped']
        completed_count = len(completed_results)

        passed = sum(1 for r in completed_results if r.get('overall_score', 0) > 80)
        failed = completed_count - passed

        total_progress_score = sum(r.get('progress_evaluation', {}).get('score', 0) for r in completed_results)
        total_output_score = sum(r.get('output_evaluation', {}).get('score', 0) for r in completed_results)
        total_overall_score = sum(r.get('overall_score', 0) for r in completed_results)

        avg_progress = total_progress_score / completed_count if completed_count > 0 else 0
        avg_output = total_output_score / completed_count if completed_count > 0 else 0
        avg_overall = total_overall_score / completed_count if completed_count > 0 else 0

        # Build markdown report
        report = f"""# Test Run Results
Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Executive Summary

**{'✅ ALL TESTS PASSED' if failed == 0 and completed_count == total_tests else '⚠️ SOME TESTS FAILED'}! Average Overall Score: {avg_overall:.1f}/100**

## Test Results Summary

| Test # | Test Name | Score | Status | Notes |
|--------|-----------|-------|--------|-------|
"""

        # Add table rows for each test
        for i, result in enumerate(results, 1):
            test_case_id = result.get('test_case_id', 'unknown')
            test_case = next((tc for tc in test_cases if tc['id'] == test_case_id), {})
            test_name = test_case.get('name', 'Unknown Test')

            if result.get('status') == 'skipped':
                report += f"| {i} | {test_name} | N/A | ⏭️ SKIPPED | {result.get('skip_reason', 'Unknown')} |\n"
            else:
                score = result.get('overall_score', 0)
                status = '✅ PASS' if score >= 70 else '❌ FAIL'
                report += f"| {i} | {test_name} | **{score}/100** | {status} | |\n"

        report += f"""
**Average Score: {avg_overall:.1f}/100** (Target: ≥70/100) {'✅' if avg_overall >= 70 else '❌'}

## Detailed Results

"""

        # Add detailed results for each test
        for i, result in enumerate(results, 1):
            test_case_id = result.get('test_case_id', 'unknown')
            test_case = next((tc for tc in test_cases if tc['id'] == test_case_id), {})
            test_name = test_case.get('name', 'Unknown Test')

            if result.get('status') == 'skipped':
                report += f"""### Test {i}: {test_name} ⏭️ SKIPPED

**Reason:** {result.get('skip_reason', 'Unknown')}

---

"""
                continue

            score = result.get('overall_score', 0)
            progress_score = result.get('progress_evaluation', {}).get('score', 0)
            output_score = result.get('output_evaluation', {}).get('score', 0)
            duration = result.get('duration_seconds', 0)

            report += f"""### Test {i}: {test_name}

**Overall Score:** {score}/100 {'✅' if score >= 70 else '❌'}
**Progress Score:** {progress_score}/100
**Output Score:** {output_score}/100
**Duration:** {duration:.1f}s

**Progress Evaluation:**
{result.get('progress_evaluation', {}).get('reasoning', 'N/A')}

**Output Evaluation:**
{result.get('output_evaluation', {}).get('reasoning', 'N/A')}

"""

            # Add final response if available
            test_run_id = result.get('test_run_id')
            if test_run_id:
                test_run = self.db.get_test_run(test_run_id)
                final_response = test_run.get('final_response') if test_run else None

                if final_response:
                    report += f"""**Final Response:**
```
{final_response}
```

"""

            report += "---\n\n"

        # Add summary metrics
        report += f"""## Performance Summary

- **Total Tests:** {total_tests}
- **Completed:** {completed_count}
- **Skipped:** {skipped}
- **Passed (≥70):** {passed}
- **Failed (<70):** {failed}

**Average Scores:**
- Progress: {avg_progress:.1f}/100
- Output: {avg_output:.1f}/100
- Overall: {avg_overall:.1f}/100

---

*Report generated automatically by Cortex AutoGen2 Test Orchestrator*
"""

        return report
