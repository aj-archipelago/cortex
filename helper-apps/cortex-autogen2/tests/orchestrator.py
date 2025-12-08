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
import re
import tempfile
from io import BytesIO
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from pathlib import Path
import os

# Add parent directory to path to import project modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from azure.storage.queue import QueueClient
from tests.database.repository import TestRepository  # null/in-memory (no DB)
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
        redis_channel: Optional[str] = None,
        logger: Optional[logging.Logger] = None
    ):
        """
        Initialize the test orchestrator.

        Args:
            db_path: Unused placeholder for backward compatibility (no database is written)
            redis_url: Redis connection URL (defaults to env var)
            redis_channel: Redis channel name (defaults to env var)
            logger: Logger instance to use (defaults to module logger)
        """
        self.db = TestRepository(db_path)
        self.evaluator = LLMEvaluator()
        self.logger = logger or logging.getLogger(__name__)

        self.redis_url = redis_url or os.getenv("REDIS_CONNECTION_STRING", "redis://localhost:6379")
        self.redis_channel = redis_channel or os.getenv("REDIS_CHANNEL", "requestProgress")

        self.azure_queue_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
        self.azure_queue_name = os.getenv("AZURE_QUEUE_NAME", "cortex-tasks")

        if not self.azure_queue_conn_str:
            raise ValueError("AZURE_STORAGE_CONNECTION_STRING environment variable must be set")

        # Load test cases and global expectations
        self.test_cases = self.load_test_cases()
        # Import global expectations from shared source of truth
        # This is the same GLOBAL_QUALITY_EXPECTATIONS used by execution_completion_verifier_agent
        # Source: agents/constants/global_quality_standards.py
        from dynamic_agent_loader import constants
        GLOBAL_QUALITY_EXPECTATIONS = constants.GLOBAL_QUALITY_EXPECTATIONS
        self.global_expectations = GLOBAL_QUALITY_EXPECTATIONS

        # Performance monitoring
        self.performance_metrics = {
            'tests_run': 0,
            'tests_passed': 0,
            'tests_failed': 0,
            'tests_skipped': 0,
            'total_duration': 0,
            'agent_errors': {},
            'file_errors': 0,
            'data_errors': 0,
            'sequence_errors': 0
        }

        self.logger.info("🎬 Test Orchestrator initialized")
        self.logger.info(f"   Redis: {self.redis_url}")
        self.logger.info(f"   Queue: {self.azure_queue_name}")

    def _track_performance_metric(self, metric: str, value: int = 1):
        """Track performance metrics during test execution."""
        if metric in self.performance_metrics:
            self.performance_metrics[metric] += value
        elif metric == 'duration':
            self.performance_metrics['total_duration'] += value

    def _analyze_error_patterns(self, error_message: str):
        """Analyze error messages to categorize error types."""
        error_lower = error_message.lower()

        if 'sequence' in error_lower or 'order' in error_lower:
            self._track_performance_metric('sequence_errors')
        elif 'file' in error_lower or 'path' in error_lower:
            self._track_performance_metric('file_errors')
        elif 'data' in error_lower or 'dataframe' in error_lower:
            self._track_performance_metric('data_errors')
        elif any(agent in error_lower for agent in ['aj_sql_agent', 'coder_agent', 'web_search_agent', 'presenter_agent']):
            agent_name = 'unknown'
            for agent in ['aj_sql_agent', 'coder_agent', 'web_search_agent', 'presenter_agent']:
                if agent in error_lower:
                    agent_name = agent
                    break
            if agent_name not in self.performance_metrics['agent_errors']:
                self.performance_metrics['agent_errors'][agent_name] = 0
            self.performance_metrics['agent_errors'][agent_name] += 1

    def get_performance_report(self) -> Dict:
        """Generate a comprehensive performance report."""
        metrics = self.performance_metrics

        report = {
            'summary': {
                'total_tests': metrics['tests_run'],
                'passed': metrics['tests_passed'],
                'failed': metrics['tests_failed'],
                'skipped': metrics['tests_skipped'],
                'success_rate': (metrics['tests_passed'] / max(metrics['tests_run'], 1)) * 100,
                'average_duration': metrics['total_duration'] / max(metrics['tests_run'], 1)
            },
            'error_breakdown': {
                'agent_errors': metrics['agent_errors'],
                'file_errors': metrics['file_errors'],
                'data_errors': metrics['data_errors'],
                'sequence_errors': metrics['sequence_errors']
            },
            'recommendations': []
        }

        # Generate recommendations based on error patterns
        if metrics['sequence_errors'] > 0:
            report['recommendations'].append("Agent sequence validation needs improvement")
        if metrics['file_errors'] > 0:
            report['recommendations'].append("File path handling needs standardization")
        if metrics['data_errors'] > 0:
            report['recommendations'].append("Data validation framework needs enhancement")
        if metrics['agent_errors']:
            most_problematic_agent = max(metrics['agent_errors'], key=metrics['agent_errors'].get)
            report['recommendations'].append(f"Focus on improving {most_problematic_agent} reliability")

        return report

    def print_performance_report(self):
        """Print a formatted performance report to the console."""
        report = self.get_performance_report()

        print("\n" + "="*80)
        print("📊 PERFORMANCE REPORT")
        print("="*80)

        summary = report['summary']
        print("📈 SUMMARY:")
        print(f"   Total Tests: {summary['total_tests']}")
        print(f"   Passed: {summary['passed']} ({summary['success_rate']:.1f}%)")
        print(f"   Failed: {summary['failed']}")
        print(f"   Skipped: {summary['skipped']}")
        print(f"   Average Duration: {summary['average_duration']:.1f}s")
        errors = report['error_breakdown']
        print("🚨 ERROR BREAKDOWN:")
        print(f"   Agent Errors: {errors['agent_errors']}")
        print(f"   File Errors: {errors['file_errors']}")
        print(f"   Data Errors: {errors['data_errors']}")
        print(f"   Sequence Errors: {errors['sequence_errors']}")

        if report['recommendations']:
            print("💡 RECOMMENDATIONS:")
            for rec in report['recommendations']:
                print(f"   • {rec}")

        print("="*80 + "\n")

    def _create_error_result(self, test_case_id: str, error_message: str) -> Dict:
        """Create a standardized error result for test failures."""
        return {
            'test_case_id': test_case_id,
            'status': 'error',
            'error_message': error_message,
            'timestamp': datetime.now().isoformat(),
            'duration_seconds': 0,
            'progress_updates': 0,
            'files_created': 0,
            'scores': {'overall': 0, 'progress': 0, 'output': 0}
        }

    def load_test_cases(self, test_cases_path: Optional[str] = None) -> List[Dict]:
        """
        Load test cases from YAML file.

        Args:
            test_cases_path: Path to test_cases.yaml (defaults to tests/test_cases.yaml)

        Returns:
            List of test cases
        """
        if test_cases_path is None:
            test_cases_path = Path(__file__).parent / "test_cases.yaml"

        with open(test_cases_path, 'r') as f:
            data = yaml.safe_load(f)

        test_cases = data.get('test_cases', [])

        self.logger.info(f"📋 Loaded {len(test_cases)} test cases")

        return test_cases

    def run_test_sync(self, test_case: Dict) -> Dict:
        """Synchronous wrapper for run_test to run in thread pool."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(self.run_test(test_case))
        finally:
            loop.close()

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

        # Set runner info for logging
        self._current_test_case_id = test_case_id
        self._current_runner_id = getattr(self, '_current_runner_id', 0)  # Will be set by test runner

        self.logger.info(f"\n{'='*80}")
        self.logger.info(f"🧪 Running Test: {test_case['name']}")
        self.logger.info(f"   ID: {test_case_id}")
        self.logger.info(f"   Timeout: {timeout}s")
        if requires_ajsql:
            self.logger.info("   Requires AJ SQL: Yes")

        # Comprehensive prerequisite validation
        self.logger.info("🔍 Running prerequisite validation...")

        # Check API keys and environment variables
        required_env_vars = ['CORTEX_API_KEY', 'AZURE_STORAGE_CONNECTION_STRING']
        missing_vars = [var for var in required_env_vars if not os.getenv(var)]
        if missing_vars:
            self.logger.error(f"❌ MISSING ENVIRONMENT VARIABLES: {missing_vars}")
            self.logger.error(f"⏭️ SKIPPING test {test_case_id} - required environment variables not set")
            return self._create_error_result(test_case_id, f"Missing environment variables: {missing_vars}")

        # Check Azure Queue configuration
        if not self.azure_queue_conn_str:
            self.logger.error("❌ MISSING AZURE QUEUE CONFIGURATION")
            self.logger.error(f"⏭️ SKIPPING test {test_case_id} - Azure queue not configured")
            return self._create_error_result(test_case_id, "Azure queue not configured")

        # Check work directory permissions
        work_dir = os.environ.get('CORTEX_WORK_DIR', '/tmp')
        if not os.path.exists(work_dir):
            try:
                os.makedirs(work_dir, exist_ok=True)
                self.logger.info(f"✅ Created work directory: {work_dir}")
            except Exception as e:
                self.logger.error(f"❌ CANNOT CREATE WORK DIRECTORY: {work_dir} - {e}")
                self.logger.error(f"⏭️ SKIPPING test {test_case_id} - cannot create work directory")
                return self._create_error_result(test_case_id, f"Cannot create work directory: {e}")

        # Check write permissions
        try:
            test_file = os.path.join(work_dir, f"test_write_{test_case_id}.tmp")
            with open(test_file, 'w') as f:
                f.write("test")
            os.remove(test_file)
            self.logger.info(f"✅ Work directory write permissions confirmed: {work_dir}")
        except Exception as e:
            self.logger.error(f"❌ NO WRITE PERMISSIONS in work directory: {work_dir} - {e}")
            self.logger.error(f"⏭️ SKIPPING test {test_case_id} - no write permissions in work directory")
            return self._create_error_result(test_case_id, f"No write permissions in work directory: {e}")

        # Check AJ SQL connectivity if required
        if requires_ajsql:
            self.logger.info("🔍 Checking AJ SQL database connectivity...")
            is_accessible, message = check_ajsql_connectivity()

            if not is_accessible:
                self.logger.warning(f"⚠️ AJ SQL database not accessible: {message}")
                self.logger.warning(f"⏭️ SKIPPING test {test_case_id} - requires AJ SQL database access")
                return self._create_error_result(test_case_id, f"AJ SQL not accessible: {message}")

        self.logger.info("✅ All prerequisites validated successfully")

        # Generate unique request ID
        request_id = f"test_{test_case_id}_{uuid.uuid4().hex[:8]}"

        # Create test run record in database (run in thread to avoid blocking)
        test_run_id = await asyncio.to_thread(
            self.db.create_test_run,
            test_case_id=test_case_id,
            task_description=task_description,
            request_id=request_id
        )

        self.logger.info(f"📝 Test run created: ID={test_run_id}, Request={request_id}")

        # Start collectors
        progress_collector = ProgressCollector(self.redis_url, self.redis_channel, self.logger)
        log_collector = LogCollector("cortex-autogen2-cortex-autogen-function-1")

        # Submit task to Azure Queue first to get the message ID
        try:
            azure_message_id = await self._submit_task(request_id, task_description)
            self.logger.info(f"✅ Task submitted to queue (Azure message ID: {azure_message_id})")
        except Exception as e:
            self.logger.error(f"❌ Failed to submit task: {e}")
            self.db.update_test_run_status(test_run_id, 'failed', error_message=str(e))
            return {'test_run_id': test_run_id, 'status': 'failed', 'error': str(e)}

        # Collect data concurrently - start IMMEDIATELY after task submission
        # NOTE: Use Azure Queue message ID, not our custom request_id!
        # The system publishes progress updates with the Azure Queue message ID.
        try:
            self.logger.info("📡 Starting data collection...")

            # For parallel execution, use appropriate timeout
            parallel_timeout = timeout  # Use the timeout defined in test_cases.yaml
            self.logger.info(f"⏱️ Using parallel timeout: {parallel_timeout}s")

            # Start progress collection immediately to catch all updates from the start
            progress_updates = await progress_collector.start_collecting(azure_message_id, timeout=parallel_timeout)

            # Now that progress is complete, collect logs using docker logs command
            logs = await log_collector.collect_logs_since_task(azure_message_id)

            self.logger.info("✅ Data collection complete")
            self.logger.info(f"   Progress updates: {len(progress_updates)}")
            self.logger.info(f"   Log entries: {len(logs)}")

        except Exception as e:
            self.logger.error(f"❌ Data collection error: {e}", exc_info=True)
            self.db.update_test_run_status(test_run_id, 'failed', error_message=str(e))
            return {'test_run_id': test_run_id, 'status': 'failed', 'error': str(e)}

        # Store progress updates and logs in database
        for update in progress_updates:
            progress_pct = update.get('progress', 0.0)
            info = update.get('info', '')
            self.db.add_progress_update(
                test_run_id=test_run_id,
                timestamp=datetime.fromisoformat(update['timestamp']),
                progress=progress_pct,
                info=info,
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
        final_response_text = ""  # Initialize to ensure it's always defined

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
                self.logger.info(f"💾 Saved final response to database ({len(final_response_text)} chars)")

                # Log the final response content for visibility during test runs
                self.logger.info("📝 Final Response:")
                self.logger.info(f"{final_response_text}")
            except Exception as e:
                self.logger.warning(f"⚠️ Failed to save final response to database: {e}")
                final_response_text = f"Error saving final response: {str(e)}"

        # Update test run status - completed if we received any progress updates (including final message)
        status = 'completed' if len(progress_updates) > 0 else 'timeout'
        self.db.update_test_run_status(test_run_id, status)

        test_run_data = self.db.get_test_run(test_run_id)

        # Extract files from final result if available
        files_created = []
        if final_result:
            files_created = self._extract_files_from_final_result(final_result, test_run_id)

        # Fallback: if no final_result captured (e.g., timeout) try to recover last presenter message from logs
        if not final_result:
            recovered = self._recover_final_result_from_logs(azure_message_id)
            if recovered:
                self.logger.warning("⚠️ final_result missing; recovered presenter output from logs")
                final_result = recovered
                final_response_text = recovered if isinstance(recovered, str) else str(recovered)
                self.db.save_final_response(test_run_id, final_response_text)
                files_created = self._extract_files_from_final_result(final_result, test_run_id)

        # Calculate metrics
        self.logger.info("\n📊 Calculating metrics...")
        metrics = MetricsCollector.calculate_metrics(
            test_run_data,
            progress_updates,
            logs,
            files_created
        )

        self.db.save_metrics(test_run_id, **metrics)

        # Run LLM evaluation
        self.logger.info("\n🤖 Running LLM evaluation...")

        test_summary = {
            'duration_seconds': test_run_data.get('duration_seconds', 0),
            'total_progress_updates': metrics.get('total_progress_updates', 0),
            'errors_count': metrics.get('errors_count', 0),
            'warnings_count': metrics.get('warnings_count', 0)
        }

        # Convert logs to messages format for bug validation
        messages = []
        for log_entry in logs:
            agent = log_entry.get('agent')
            if agent:  # Only include logs with agent information
                messages.append({
                    'source': agent,
                    'content': log_entry.get('message', ''),
                    'timestamp': log_entry.get('timestamp')
                })
            elif 'aj_sql_agent' in str(log_entry.get('message', '')) or 'Processing task' in str(log_entry.get('message', '')):
                # Also check for agent mentions in message content
                messages.append({
                    'source': 'aj_sql_agent' if 'aj_sql_agent' in str(log_entry.get('message', '')) else 'unknown',
                    'content': log_entry.get('message', ''),
                    'timestamp': log_entry.get('timestamp')
                })

        # Helper to build comprehensive accomplishments from logs
        def build_accomplishments_text_from_logs(work_dir: str, final_response: str, message_list: list) -> str:
            """Build comprehensive accomplishments text from all log sources."""
            import os
            parts = [final_response]
            
            logs_dir = os.path.join(work_dir, "logs")
            
            # Add agent journey (high-level proof)
            journey_path = os.path.join(logs_dir, "agent_journey.log")
            if os.path.exists(journey_path):
                try:
                    with open(journey_path, 'r') as f:
                        parts.append("\n\n=== AGENT JOURNEY ===\n" + f.read())
                except Exception:
                    pass
            
            # Add accomplishments (detailed actions)
            acc_path = os.path.join(logs_dir, "accomplishments.log")
            if os.path.exists(acc_path):
                try:
                    with open(acc_path, 'r') as f:
                        parts.append("\n\n=== ACCOMPLISHMENTS ===\n" + f.read())
                except Exception:
                    pass
            
            # Add messages (legacy)
            parts.append(f"\n\n=== MESSAGES ===\n{str(message_list)}")
            
            return "".join(parts)

        # Extract agent sequence from JSONL logs for bug validation
        agent_sequence = []

        # Primary method: Extract from logs.jsonl and messages.jsonl
        logs_dir = f"./logs/req_{azure_message_id}/logs"
        logs_jsonl_path = os.path.join(logs_dir, "logs.jsonl")
        messages_jsonl_path = os.path.join(logs_dir, "messages.jsonl")

        # Read agent messages from logs.jsonl
        if os.path.exists(logs_jsonl_path):
            try:
                with open(logs_jsonl_path, 'r') as f:
                    for line in f:
                        try:
                            entry = json.loads(line.strip())
                            agent_name = entry.get('agent_name')
                            if agent_name and agent_name not in agent_sequence:
                                # Only add actual agents, not 'system'
                                if agent_name in ['aj_sql_agent', 'coder_agent', 'web_search_agent',
                                                'aj_article_writer_agent', 'cognitive_search_agent', 'planner_agent']:
                                    agent_sequence.append(agent_name)
                                    self.logger.info(f"🤖 DEBUG: Added {agent_name} to sequence from logs.jsonl")
                        except json.JSONDecodeError:
                            continue
            except Exception as e:
                self.logger.warning(f"Could not read logs.jsonl: {e}")

        # Also check messages.jsonl for any additional agent activity
        if os.path.exists(messages_jsonl_path):
            try:
                with open(messages_jsonl_path, 'r') as f:
                    for line in f:
                        try:
                            entry = json.loads(line.strip())
                            agent_name = entry.get('agent_name')
                            if agent_name and agent_name not in agent_sequence:
                                if agent_name in ['aj_sql_agent', 'coder_agent', 'web_search_agent',
                                                'aj_article_writer_agent', 'cognitive_search_agent', 'planner_agent']:
                                    agent_sequence.append(agent_name)
                                    self.logger.info(f"🤖 DEBUG: Added {agent_name} to sequence from messages.jsonl")
                        except json.JSONDecodeError:
                            continue
            except Exception as e:
                self.logger.warning(f"Could not read messages.jsonl: {e}")

        # Secondary method: Check progress messages for agent names (keep existing)
        for update in progress_updates:
            message = update.get('info', '').lower()
            for agent_name in ['aj_sql_agent', 'coder_agent', 'web_search_agent', 'aj_article_writer_agent', 'cognitive_search_agent', 'planner_agent']:
                if agent_name in message and agent_name not in agent_sequence:
                    agent_sequence.append(agent_name)

        self.logger.info(f"🤖 DEBUG: Final agent_sequence from JSONL: {agent_sequence}")

        # Build accomplishments text from JSONL logs to provide evidence for evaluator
        accomplishments_text = ""
        accomplishments_parts = []
        
        # Extract evidence from logs.jsonl
        if os.path.exists(logs_jsonl_path):
            try:
                with open(logs_jsonl_path, 'r') as f:
                    for line in f:
                        try:
                            entry = json.loads(line.strip())
                            agent_name = entry.get('agent_name', '')
                            content = entry.get('content', '')
                            message = entry.get('message', '')
                            
                            # Check for aj_sql_agent activity
                            if agent_name == 'aj_sql_agent' or 'aj_sql_agent' in str(content).lower() or 'aj_sql_agent' in str(message).lower():
                                accomplishments_parts.append(f"aj_sql_agent: {content or message}")
                            
                            # Check for SQL query execution patterns
                            content_str = str(content) + str(message)
                            if any(pattern in content_str for pattern in [
                                'EXECUTING SQL QUERY',
                                'SQL QUERY COMPLETED',
                                'execute_aj_sql_query',
                                'transfer_to_aj_sql_agent',
                                'aj_sql_agent:'
                            ]):
                                accomplishments_parts.append(content_str)
                        except json.JSONDecodeError:
                            continue
            except Exception as e:
                self.logger.warning(f"Could not read logs.jsonl for accomplishments: {e}")
        
        # Extract evidence from messages.jsonl
        if os.path.exists(messages_jsonl_path):
            try:
                with open(messages_jsonl_path, 'r') as f:
                    for line in f:
                        try:
                            entry = json.loads(line.strip())
                            agent_name = entry.get('agent_name', '')
                            content = entry.get('content', '')
                            
                            # Check for aj_sql_agent activity
                            if agent_name == 'aj_sql_agent':
                                accomplishments_parts.append(f"aj_sql_agent: {content}")
                            
                            # Check for SQL query execution patterns
                            content_str = str(content)
                            if any(pattern in content_str for pattern in [
                                'EXECUTING SQL QUERY',
                                'SQL QUERY COMPLETED',
                                'execute_aj_sql_query',
                                'transfer_to_aj_sql_agent',
                                'aj_sql_agent:'
                            ]):
                                accomplishments_parts.append(content_str)
                        except json.JSONDecodeError:
                            continue
            except Exception as e:
                self.logger.warning(f"Could not read messages.jsonl for accomplishments: {e}")
        
        # Read accomplishments.log if it exists
        acc_path = os.path.join(logs_dir, "accomplishments.log")
        if os.path.exists(acc_path):
            try:
                with open(acc_path, 'r') as f:
                    accomplishments_parts.append(f.read())
            except Exception as e:
                self.logger.warning(f"Could not read accomplishments.log: {e}")
        
        # Combine all evidence into accomplishments_text
        accomplishments_text = "\n".join(accomplishments_parts)
        
        if accomplishments_text:
            self.logger.info(f"📋 Built accomplishments_text ({len(accomplishments_text)} chars) with evidence from logs")

        try:
            # Get test case specific quality criteria
            test_case_quality_criteria = test_case.get('quality_criteria', [])

            progress_eval, output_eval = await self.evaluator.evaluate_test_run(
                task=task_description,
                progress_updates=progress_updates,
                final_result=final_result,
                files_created=files_created,
                test_summary=test_summary,
                test_case_id=test_case_id,
                global_expectations=self.global_expectations,
                test_case_quality_criteria=test_case_quality_criteria,
                agent_activity_data={
                    'agent_sequence': agent_sequence,
                    'accomplishments_text': accomplishments_text,
                    'requires_ajsql': test_case.get('requires_ajsql', False)
                }
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


            self.logger.info("\n**Progress Evaluation:**")
            self.logger.info(f"{progress_eval['reasoning']}")

            self.logger.info("\n**Output Evaluation:**")
            self.logger.info(f"{output_eval['reasoning']}")


            # Weighted: 80% output quality, 20% progress reporting (output matters most!)
            overall = int((output_eval['score'] * 0.8) + (progress_eval['score'] * 0.2))
            # Make evaluation results highly visible during test runs
            self.logger.info(f"**Duration:** {test_run_data.get('duration_seconds', 0):.1f}s")
            self.logger.info(f"**Progress Score:** {progress_eval['score']}/100")
            self.logger.info(f"**Output Score:** {output_eval['score']}/100")



            self.logger.info(f"**Overall Score:** {overall}/100 🏁.")

        except Exception as e:
            self.logger.error(f"❌ Evaluation error: {e}", exc_info=True)
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
            'final_response': final_response_text,
            'messages': messages,  # Add messages for bug validation
            'metrics': metrics,
            'progress_evaluation': progress_eval,
            'output_evaluation': output_eval,
            'progress_score': progress_eval['score'],
            'output_score': output_eval['score'],
            'overall_score': int((output_eval['score'] * 0.8) + (progress_eval['score'] * 0.2))
        }

        results['agent_sequence'] = agent_sequence

        # Run bug-specific validations
        bug_validations = {
            "minimal_output": self.validate_minimal_output(results, test_case),
            "aj_routing": self.validate_aj_routing(results, test_case),
            "no_hallucination": self.validate_no_hallucination(results),
            "upload_markers": self.validate_upload_markers(results)
        }

        # Add to overall results
        results["bug_validations"] = bug_validations
        results["bug_validation_passed"] = all(v["passed"] for v in bug_validations.values())

        # CRITICAL: If bug validations fail, set overall score to 0
        if not results["bug_validation_passed"]:
            results["overall_score"] = 0
            results["progress_score"] = 0
            results["output_score"] = 0
            self.logger.warning("🚨 BUG VALIDATIONS FAILED - Setting overall score to 0")

        # Log detailed bug validation results
        for validation_name, validation_result in bug_validations.items():
            if not validation_result["passed"]:
                for issue in validation_result["issues"]:
                    self.logger.warning(f"Bug Validation FAILED - {validation_name}: {issue}")

        # Track performance metrics
        self._track_performance_metric('tests_run')

        test_status = results.get('status', 'unknown')
        if test_status == 'completed' and results.get('bug_validation_passed', False):
            self._track_performance_metric('tests_passed')
        elif test_status in ['error', 'failed']:
            self._track_performance_metric('tests_failed')
            # Analyze error patterns
            error_msg = results.get('error_message', '')
            if error_msg:
                self._analyze_error_patterns(error_msg)
        elif test_status == 'skipped':
            self._track_performance_metric('tests_skipped')

        # Track duration
        duration = results.get('duration_seconds', 0)
        self._track_performance_metric('duration', duration)

        self.logger.info(f"\n{'='*80}")
        self.logger.info(f"✅ Test Complete: {test_case['name']}")
        self.logger.info(f"Bug Validations: {'✅ PASSED' if results['bug_validation_passed'] else '❌ FAILED'}")
        self.logger.info(f"{'='*80}\n")

        return results

    async def run_tests_parallel(self, test_cases: List[Dict]) -> List[Dict]:
        """
        Run a batch of test cases in parallel.

        Args:
            test_cases: List of test case dictionaries

        Returns:
            List of test results
        """
        async def run_single_test_with_error_handling(test_case: Dict) -> Dict:
            """Run a single test with error handling."""
            try:
                return await self.run_test(test_case)
            except Exception as e:
                self.logger.error(f"❌ Test {test_case['id']} failed with exception: {e}")
                return {
                    'test_case_id': test_case['id'],
                    'overall_score': 0,
                    'progress_score': 0,
                    'output_score': 0,
                    'duration': 0,
                    'error': str(e)
                }

        # Run tests in parallel
        tasks = [run_single_test_with_error_handling(tc) for tc in test_cases]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Handle any exceptions that occurred
        processed_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                self.logger.error(f"❌ Parallel execution failed for test {test_cases[i]['id']}: {result}")
                processed_results.append({
                    'test_case_id': test_cases[i]['id'],
                    'overall_score': 0,
                    'progress_score': 0,
                    'output_score': 0,
                    'duration': 0,
                    'error': str(result)
                })
            else:
                processed_results.append(result)

        return processed_results

    async def run_all_tests(self, test_cases_path: Optional[str] = None) -> List[Dict]:
        """
        Run all test cases sequentially.

        Args:
            test_cases_path: Path to test_cases.yaml

        Returns:
            List of test results
        """
        test_cases, _ = self.load_test_cases(test_cases_path)
        results = []

        self.logger.info(f"\n🚀 Running {len(test_cases)} test cases...\n")

        for i, test_case in enumerate(test_cases, 1):
            self.logger.info(f"\n{'#'*80}")

            # Show progress summary for completed tests
            if results:
                completed_count = len(results)
                passed = sum(1 for r in results if r.get('overall_score', 0) > 90)
                avg_score = sum(r.get('overall_score', 0) for r in results) / completed_count

                # Calculate average progress and output scores
                avg_progress = sum(r.get('progress_score', 0) for r in results) / completed_count
                avg_output = sum(r.get('output_score', 0) for r in results) / completed_count

                self.logger.info(f"# Progress: {completed_count} completed | {passed} passed (>80) | Avg: {avg_score:.1f}/100")
                self.logger.info(f"# Scores - Progress: {avg_progress:.1f}/100 | Output: {avg_output:.1f}/100 | Overall: {avg_score:.1f}/100")

            self.logger.info(f"# Test {i}/{len(test_cases)}: {test_case['name']}")
            self.logger.info(f"{'#'*80}\n")

            result = await self.run_test(test_case)
            results.append(result)

        # Print summary
        self._print_summary(results)

        # Generate and save report
        self.logger.info("📄 Generating test report...")
        report = self._generate_test_report(results, test_cases)

        # Save report to file with timestamp
        from datetime import datetime
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        report_path = Path(__file__).parent.parent / f"TEST_RUN_RESULTS_{timestamp}.md"

        with open(report_path, 'w') as f:
            f.write(report)

        self.logger.info(f"📄 Test report saved to: {report_path}")
        self.logger.info("   You can review detailed results and final messages in this file.\n")

        # Print performance report
        self.print_performance_report()

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
            "content": task,
            "runner_info": {
                "test_case_id": getattr(self, '_current_test_case_id', 'unknown'),
                "runner_id": getattr(self, '_current_runner_id', 0)
            }
        }

        # Debug logging
        self.logger.info(f"📤 Submitting task with runner_info: {getattr(self, '_current_test_case_id', 'none')} / runner {getattr(self, '_current_runner_id', 'none')}")

        message_json = json.dumps(message_data)
        message_b64 = base64.b64encode(message_json.encode('utf-8')).decode('utf-8')

        result = queue_client.send_message(message_b64)
        queue_client.close()

        # Return the Azure Queue message ID - this is what the system uses for progress updates!
        return result.id

    def _print_summary(self, results: List[Dict]):
        """Print summary of all test results."""
        self.logger.info(f"\n\n{'='*80}")
        self.logger.info("📊 TEST SUMMARY")
        self.logger.info(f"{'='*80}\n")

        total_tests = len(results)
        skipped = sum(1 for r in results if r.get('status') == 'skipped')
        completed_results = [r for r in results if r.get('status') != 'skipped']
        completed_count = len(completed_results)

        passed = sum(1 for r in completed_results if r.get('overall_score', 0) > 90)
        failed = completed_count - passed

        total_progress_score = sum(r.get('progress_evaluation', {}).get('score', 0) for r in completed_results)
        total_output_score = sum(r.get('output_evaluation', {}).get('score', 0) for r in completed_results)
        total_overall_score = sum(r.get('overall_score', 0) for r in completed_results)

        avg_progress = total_progress_score / completed_count if completed_count > 0 else 0
        avg_output = total_output_score / completed_count if completed_count > 0 else 0
        avg_overall = total_overall_score / completed_count if completed_count > 0 else 0

        self.logger.info(f"Total Tests: {total_tests}")
        self.logger.info(f"Completed: {completed_count}")
        if skipped > 0:
            self.logger.info(f"Skipped: {skipped} (AJ SQL database not accessible)")
        self.logger.info(f"Passed (≥70): {passed}")
        self.logger.info(f"Failed (<70): {failed}")
        self.logger.info("")

        if completed_count > 0:
            self.logger.info("Average Scores:")
            self.logger.info(f"  Progress: {avg_progress:.1f}/100")
            self.logger.info(f"  Output: {avg_output:.1f}/100")
            self.logger.info(f"  Overall: {avg_overall:.1f}/100")

        self.logger.info(f"\n{'='*80}\n")

    def _generate_test_report(self, results: List[Dict], test_cases: List[Dict]) -> str:
        """Generate a comprehensive markdown test report."""
        from datetime import datetime

        # Calculate summary stats
        total_tests = len(results)
        skipped = sum(1 for r in results if r.get('status') == 'skipped')
        completed_results = [r for r in results if r.get('status') != 'skipped']
        completed_count = len(completed_results)

        passed = sum(1 for r in completed_results if r.get('overall_score', 0) > 90)
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

**Duration:** {duration:.1f}s
**Progress Score:** {progress_score}/100
**Output Score:** {output_score}/100
**Overall Score:** {score}/100 {'✅' if score >= 70 else '❌'}

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

    def validate_minimal_output(self, test_results: Dict, test_case: Dict) -> Dict:
        """Validate that minimal requests don't produce unwanted files using generic intent detection."""
        validation_results = {
            "passed": True,
            "issues": []
        }

        task_text = test_case.get("task", "").lower()

        # Generic minimal intent patterns (not specific keywords)
        minimal_patterns = [
            # Direct data delivery requests
            r'\bjust\s+(give|send|create)\s+(me\s+)?(?:the\s+)?(?:a\s+)?(?:csv|data|list|titles?)\b',
            r'\bonly\s+(need|want)\s+(the\s+)?(?:csv|data|list|titles?)\b',
            r'\b(?:give|send)\s+me\s+(?:just\s+)?(?:the\s+)?(?:csv|data|list|titles?)\b',

            # Simplicity signals
            r'\b(?:keep\s+it\s+)?(?:simple|basic|minimal|straightforward)\b',
            r'\bno\s+(?:charts?|graphs?|visuals?|analysis)\b',

            # Single deliverable focus
            r'\bonly\s+(?:the\s+)?(?:csv|data|file|list)\b',
            r'\bjust\s+(?:the\s+)?(?:csv|data|file|list)\b',

            # Concise answer expectations
            r'\bhow\s+many\b.*\?',  # "how many articles?"
            r'\bwhat(?:\'s)?\s+the\s+(?:count|number|total)\b.*\?',  # "what's the count?"
        ]

        is_minimal_request = any(re.search(pattern, task_text) for pattern in minimal_patterns)

        if is_minimal_request:
            uploaded_files = test_results.get("uploaded_files", [])
            # Allow only CSV/data files for minimal requests
            non_data_files = [f for f in uploaded_files
                             if not f.get("filename", "").endswith((".csv", ".json", ".txt", ".xml"))]

            if non_data_files:
                validation_results["passed"] = False
                validation_results["issues"].append(
                    f"❌ Minimal request produced non-data files: {[f['filename'] for f in non_data_files]}"
                )

        return validation_results

    def validate_aj_routing(self, test_results: Dict, test_case: Dict) -> Dict:
        """Validate that AJ data tasks properly route through aj_sql_agent."""
        validation_results = {
            "passed": True,
            "issues": []
        }

        if test_case.get("requires_ajsql", False):
            agent_sequence = test_results.get("agent_sequence", [])

            # Check if aj_sql_agent was called
            if "aj_sql_agent" not in agent_sequence:
                validation_results["passed"] = False
                validation_results["issues"].append("❌ AJ data task did not call aj_sql_agent")

            # Check if aj_sql_agent was called before coder_agent for AJ tasks
            aj_sql_idx = agent_sequence.index("aj_sql_agent") if "aj_sql_agent" in agent_sequence else -1
            coder_idx = agent_sequence.index("coder_agent") if "coder_agent" in agent_sequence else -1

            if aj_sql_idx > coder_idx and coder_idx != -1:
                validation_results["passed"] = False
                validation_results["issues"].append("❌ coder_agent called before aj_sql_agent for AJ data task")

        return validation_results

    def validate_no_hallucination(self, test_results: Dict) -> Dict:
        """Validate that presenter_agent doesn't respond without actual files."""
        validation_results = {
            "passed": True,
            "issues": []
        }

        messages = test_results.get("messages", [])
        presenter_messages = [msg for msg in messages if msg.get("source") == "presenter_agent"]

        for msg in presenter_messages[:-1]:  # Check all but the last message
            content = msg.get("content", "")
            if "📁 Ready for upload:" not in content and not content.strip().startswith("❌"):
                validation_results["passed"] = False
                validation_results["issues"].append(f"❌ Premature presenter response without files: {content[:100]}...")

        return validation_results

    def validate_upload_markers(self, test_results: Dict) -> Dict:
        """Validate that all uploaded files had proper upload markers."""
        validation_results = {
            "passed": True,
            "issues": []
        }

        uploaded_files = test_results.get("uploaded_files", [])
        messages = test_results.get("messages", [])

        # Count upload markers in code_executor messages
        upload_markers = 0
        for msg in messages:
            if msg.get("source") == "code_executor":
                content = msg.get("content", "")
                upload_markers += content.count("📁 Ready for upload:")

        if upload_markers != len(uploaded_files):
            validation_results["passed"] = False
            validation_results["issues"].append(f"❌ Upload marker count ({upload_markers}) doesn't match uploaded files ({len(uploaded_files)})")

        return validation_results

    # ------------------------------------------------------------------
    # Helpers: final_result recovery and file extraction
    # ------------------------------------------------------------------
    def _recover_final_result_from_logs(self, azure_message_id: str) -> Optional[str]:
        """
        Recover the last presenter_agent message from request logs if final_result is missing.
        Looks in ./logs/req_{id}/logs/messages.jsonl and logs.jsonl.
        """
        candidate_paths = [
            os.path.join("logs", f"req_{azure_message_id}", "logs", "messages.jsonl"),
            os.path.join("logs", f"req_{azure_message_id}", "logs", "logs.jsonl"),
        ]
        for path in candidate_paths:
            if not os.path.exists(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                # Scan from bottom to find latest presenter_agent message
                for line in reversed(lines):
                    try:
                        obj = json.loads(line)
                        if obj.get("agent_name") == "presenter_agent" or obj.get("source") == "presenter_agent":
                            content = obj.get("content")
                            if content:
                                return content
                    except Exception:
                        continue
            except Exception as e:
                self.logger.debug(f"Recover final_result: failed to read {path}: {e}")
        return None

    def _extract_files_from_final_result(self, final_result, test_run_id: int) -> List[Dict]:
        """
        Parse final_result (dict or str) and register files in the in-memory repository.
        Returns list of files for the run.
        """
        if not final_result:
            return []

        # If dict with deliverables
        if isinstance(final_result, dict):
            deliverables = final_result.get("deliverables", [])
            if not isinstance(deliverables, list):
                deliverables = []
            for item in deliverables:
                if isinstance(item, dict):
                    self.db.add_file(
                        test_run_id=test_run_id,
                        file_path=item.get("path", "unknown"),
                        file_type=item.get("type", "unknown"),
                        sas_url=item.get("sas_url"),
                    )
            return self.db.get_files(test_run_id)

        # If string (HTML/Markdown with SAS URLs)
        if isinstance(final_result, str):
            html_pattern = r'(?:href|src)=["\'](https://[^"\']+\.blob\.core\.windows\.net/[^"\']+\?[^"\']+)["\']'
            markdown_pattern = r'(?:\[[^\]]*\]|!\[[^\]]*\])\s*\(\s*(https://[^)]+\.blob\.core\.windows\.net/[^)]+\?[^)]+)\s*\)'
            html_matches = re.findall(html_pattern, final_result)
            markdown_matches = re.findall(markdown_pattern, final_result)
            unique_urls = list(set(html_matches + markdown_matches))

            file_type_map = {
                "csv": "csv",
                "json": "json",
                "png": "image",
                "jpg": "image",
                "jpeg": "image",
                "pdf": "pdf",
                "pptx": "presentation",
                "xlsx": "spreadsheet",
                "docx": "document",
            }

            for url in unique_urls:
                blob_match = re.search(r"/([^/?]+\.(csv|json|png|pdf|pptx|xlsx|docx|jpg|jpeg))", url)
                if blob_match:
                    blob_name = blob_match.group(1)
                    file_ext = blob_match.group(2).lower()
                    file_type = file_type_map.get(file_ext, "unknown")
                    self.db.add_file(
                        test_run_id=test_run_id,
                        file_path=blob_name,
                        file_type=file_type,
                        sas_url=url,
                    )

            return self.db.get_files(test_run_id)

        return []
