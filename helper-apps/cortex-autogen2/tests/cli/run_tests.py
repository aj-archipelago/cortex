#!/usr/bin/env python3
"""
CLI runner for Cortex AutoGen2 automated tests.

Usage:
    python tests/cli/run_tests.py --all                    # Run all tests
    python tests/cli/run_tests.py --test tc001_pokemon_pptx  # Run specific test
    python tests/cli/run_tests.py --history                # View recent results
    python tests/cli/run_tests.py --trend tc001_pokemon_pptx # View score trend
"""

import os
import sys
import asyncio
import argparse
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict

# Add parent directories to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import load_dotenv
from tests.orchestrator import TestOrchestrator
from task_processor.agent_workflow_processor import set_current_runner_logger
from tests.database.repository import TestRepository
from tests.analysis.trend_analyzer import TrendAnalyzer

# Load environment variables
load_dotenv()

# Configure logging with immediate flushing and optional file logging
import sys
# Create unbuffered stream handler
class UnbufferedStreamHandler(logging.StreamHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()

# Create separate loggers for each runner
def get_runner_logger(runner_id: int, test_id: str):
    """Get a separate logger for each runner."""
    logger_name = f"runner_{runner_id}_{test_id}"
    logger = logging.getLogger(logger_name)

    # Only add handlers if not already added
    if not logger.handlers:
        # Console handler with immediate flushing
        console_handler = UnbufferedStreamHandler(sys.stdout)
        console_handler.setFormatter(logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        ))
        logger.addHandler(console_handler)

        # File handler with timestamp and immediate flushing
        timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        log_file = f"logs/{timestamp}_runner_{runner_id}_{test_id}.log"
        log_dir = Path(log_file).parent
        log_dir.mkdir(exist_ok=True)
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        ))
        logger.addHandler(file_handler)

        logger.setLevel(logging.INFO)
        # Prevent propagation to root logger to avoid duplicate logs
        logger.propagate = False

        # Override log methods to flush immediately
        original_log = logger._log
        def flushing_log(level, msg, args, exc_info=None, extra=None, stack_info=False):
            original_log(level, msg, args, exc_info, exc_info, extra, stack_info)
            for handler in logger.handlers:
                if hasattr(handler, 'flush'):
                    handler.flush()
        logger._log = flushing_log

    return logger

# Suppress verbose Azure SDK logging
logging.getLogger('azure').setLevel(logging.WARNING)
logging.getLogger('azure.core.pipeline.policies.http_logging_policy').setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


def print_header():
    """Print CLI header."""
    print("\n" + "=" * 80)
    print("🧪 Cortex AutoGen2 - Automated Quality Testing Suite")
    print("=" * 80 + "\n")


def print_test_result(result: dict):
    """Print formatted test result."""
    print(f"\n{'─' * 80}")
    print(f"📋 Test: {result.get('test_case_id', 'unknown')}")
    print(f"{'─' * 80}")
    print(f"Status: {result.get('status', 'unknown')}")
    print(f"Duration: {result.get('duration_seconds', 0):.1f}s")
    print(f"Progress Updates: {result.get('progress_updates_count', 0)}")
    print(f"Files Created: {result.get('files_created_count', 0)}")

    # Show final response data field
    final_response = result.get('final_response', '')
    if final_response:
        print(f"\n📝 Final Response Data Field ({len(final_response)} chars):")
        print(final_response)

    # Show evaluation reasoning
    progress_eval = result.get('progress_evaluation', {})
    if progress_eval.get('reasoning'):
        print(f"\n💭 Progress Reasoning:")
        print(f"  {progress_eval['reasoning']}")

    output_eval = result.get('output_evaluation', {})
    if output_eval.get('reasoning'):
        print(f"\n💭 Output Reasoning:")
        print(f"  {output_eval['reasoning']}")

    # Show strengths/weaknesses
    if output_eval.get('strengths'):
        print(f"\n✅ Strengths:")
        for strength in output_eval['strengths']:
            print(f"  • {strength}")

    if output_eval.get('weaknesses'):
        print(f"\n⚠️  Weaknesses:")
        for weakness in output_eval['weaknesses']:
            print(f"  • {weakness}")

    print(f"\n📊 Scores:")
    print(f"  Progress: {result.get('progress_evaluation', {}).get('score', 0)}/100")
    print(f"  Output: {result.get('output_evaluation', {}).get('score', 0)}/100")
    print(f"  Overall: {result.get('overall_score', 0)}/100")

    print(f"{'─' * 80}\n")


def print_history(limit: int = 10):
    """Print recent test history."""
    db = TestRepository()
    runs = db.get_recent_runs(limit=limit)

    print("\n📜 Recent Test Runs:\n")

    if not runs:
        print("  No test runs found in database.")
        return

    print(f"{'ID':<6} {'Test Case':<30} {'Status':<12} {'Duration':<10} {'Scores (P/O/Overall)':<20} {'Date'}")
    print("─" * 110)

    for run in runs:
        test_id = run['id']
        test_case = run['test_case_id'][:28]
        status = run['status']
        duration = f"{run.get('duration_seconds', 0):.1f}s"
        created_at = run['created_at'][:19]

        # Get evaluation scores
        eval_data = db.get_evaluation(test_id)
        if eval_data:
            progress_score = eval_data.get('progress_score', 0)
            output_score = eval_data.get('output_score', 0)
            overall_score = eval_data.get('overall_score', 0)
            scores = f"{progress_score}/{output_score}/{overall_score}"
        else:
            scores = "N/A"

        print(f"{test_id:<6} {test_case:<30} {status:<12} {duration:<10} {scores:<20} {created_at}")

    print()


def print_trend(test_case_id: str, limit: int = 20):
    """Print score trend for a test case."""
    analyzer = TrendAnalyzer()
    trend_data = analyzer.get_score_trend(test_case_id, limit=limit)

    print(f"\n📈 Score Trend for {test_case_id}:\n")

    if not trend_data:
        print(f"  No historical data found for test case: {test_case_id}")
        return

    print(f"{'Date':<20} {'Progress':<10} {'Output':<10} {'Overall':<10}")
    print("─" * 52)

    for entry in trend_data:
        date = entry['created_at'][:19]
        progress = entry['progress_score']
        output = entry['output_score']
        overall = entry['overall_score']

        print(f"{date:<20} {progress:<10} {output:<10} {overall:<10}")

    # Calculate trend
    if len(trend_data) >= 2:
        first_overall = trend_data[0]['overall_score']
        last_overall = trend_data[-1]['overall_score']
        change = last_overall - first_overall

        print(f"\n📊 Trend Analysis:")
        print(f"  First score: {first_overall}/100")
        print(f"  Latest score: {last_overall}/100")
        print(f"  Change: {change:+d} points")

        if change > 10:
            print(f"  Status: 📈 Improving")
        elif change < -10:
            print(f"  Status: 📉 Declining (regression detected!)")
        else:
            print(f"  Status: ➡️  Stable")

    print()


async def run_all_tests_parallel(max_concurrent: int = 2):
    """Run all test cases with dynamic parallel execution."""
    print_header()
    print(f"🚀 Running all test cases with max {max_concurrent} concurrent executions...\n")

    orchestrator = TestOrchestrator()
    test_cases, _ = orchestrator.load_test_cases()

    results = []
    pending_tests = test_cases.copy()
    running_tasks = {}  # test_id -> task
    runner_ids = {}  # test_id -> runner_id
    completed_count = 0
    next_runner_id = 1

    async def run_single_test_with_completion(test_case: Dict, runner_id: int) -> Dict:
        """Run a single test and handle completion."""
        # Get separate logger for this runner
        runner_logger = get_runner_logger(runner_id, test_case['id'])

        # Write a marker to the log file to show this runner started
        runner_logger.info(f"🚀 Runner {runner_id} started test: {test_case['id']}")
        print(f"DEBUG: Runner {runner_id} starting test {test_case['id']}")

        try:
            # Run each test in its own thread to avoid blocking the event loop
            import asyncio
            runner_orchestrator = TestOrchestrator(logger=runner_logger)
            runner_orchestrator._current_runner_id = runner_id  # Set runner ID for logging
            result = await asyncio.to_thread(runner_orchestrator.run_test_sync, test_case)
            runner_logger.info(f"✅ Runner {runner_id} completed test: {test_case['id']}")
            return result
        except Exception as e:
            runner_logger.error(f"❌ Runner {runner_id} test {test_case['id']} failed with exception: {e}")
            return {
                'test_case_id': test_case['id'],
                'overall_score': 0,
                'progress_score': 0,
                'output_score': 0,
                'duration': 0,
                'error': str(e)
            }

    # Process completed tasks and start new ones to maintain max_concurrent parallel execution
    logger.info(f"🚀 Starting parallel execution: max_concurrent={max_concurrent}, total_tests={len(test_cases)}")
    while running_tasks or pending_tests:
        if running_tasks:
            # Wait for any task to complete
            done, pending = await asyncio.wait(
                list(running_tasks.values()),
                return_when=asyncio.FIRST_COMPLETED
            )

            # Process completed tasks
            for task in done:
                # Find which test this was
                completed_test_id = None
                for test_id, running_task in running_tasks.items():
                    if running_task == task:
                        completed_test_id = test_id
                        break

                if completed_test_id:
                    try:
                        result = await task
                        results.append(result)
                        completed_count += 1
                        print_test_result(result)
                        logger.info(f"✅ Completed test: {completed_test_id} ({completed_count}/{len(test_cases)})")

                        # Check if this test failed - log but continue with all tests
                        if (result.get('overall_score', 0) < 90 or
                            result.get('progress_score', 0) < 90 or
                            result.get('output_score', 0) < 90):
                            logger.warning(f"❌ Test {completed_test_id} failed with score < 90. Continuing with remaining tests.")
                            # Continue execution instead of stopping

                    except Exception as e:
                        logger.error(f"❌ Task {completed_test_id} failed with exception: {e}")
                        # Continue with other tasks

                    finally:
                        # Remove completed task
                        del running_tasks[completed_test_id]

        # Start new tests to maintain max_concurrent parallel execution
        while len(running_tasks) < max_concurrent and pending_tests:
            test_case = pending_tests.pop(0)
            runner_id = next_runner_id
            next_runner_id += 1
            logger.info(f"🔄 Starting test: {test_case['id']} with runner {runner_id}")
            task = asyncio.create_task(run_single_test_with_completion(test_case, runner_id))
            running_tasks[test_case['id']] = task
            runner_ids[test_case['id']] = runner_id
            logger.info(f"✅ Started test: {test_case['id']} (running: {len(running_tasks)}, pending: {len(pending_tests)}, runner: {runner_id})")

    # Print final summary
    print("\n" + "=" * 80)
    print("📊 Final Summary")
    print("=" * 80 + "\n")

    passed = sum(1 for r in results
                  if r.get('overall_score', 0) >= 90 and
                     r.get('progress_score', 0) >= 90 and
                     r.get('output_score', 0) >= 90)
    failed = len(results) - passed

    print(f"Total Tests: {len(results)}")
    print(f"Passed (all ≥90): {passed}")
    print(f"Failed (any <90): {failed}")

    avg_overall = sum(r.get('overall_score', 0) for r in results) / len(results) if results else 0
    print(f"Average Overall Score: {avg_overall:.1f}/100")

    print(f"\n{'=' * 80}\n")


async def run_all_tests():
    """Run all test cases sequentially (legacy function)."""
    await run_all_tests_parallel(1)


async def run_single_test(test_case_id: str):
    """Run a single test case."""
    print_header()
    print(f"🎯 Running test case: {test_case_id}\n")

    # Set up runner logging for single test execution
    runner_logger = get_runner_logger(1, test_case_id)
    set_current_runner_logger(runner_logger)

    orchestrator = TestOrchestrator(logger=runner_logger)
    test_cases, _ = orchestrator.load_test_cases()

    # Find the test case
    test_case = next((tc for tc in test_cases if tc['id'] == test_case_id), None)

    if not test_case:
        print(f"❌ Test case not found: {test_case_id}")
        print(f"\nAvailable test cases:")
        for tc in test_cases:
            print(f"  • {tc['id']} - {tc['name']}")
        return

    # Set runner ID for logging
    orchestrator._current_runner_id = 1
    orchestrator._current_test_case_id = test_case_id

    result = await orchestrator.run_test(test_case)
    print_test_result(result)


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Cortex AutoGen2 Automated Testing Suite",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        '--all',
        action='store_true',
        help='Run all test cases'
    )

    parser.add_argument(
        '--parallel',
        type=int,
        default=1,
        metavar='N',
        help='Run tests in parallel (N at a time, default: 1)'
    )

    parser.add_argument(
        '--test',
        type=str,
        metavar='TEST_ID',
        help='Run specific test case (e.g., tc001_pokemon_pptx)'
    )

    parser.add_argument(
        '--history',
        action='store_true',
        help='View recent test history'
    )

    parser.add_argument(
        '--trend',
        type=str,
        metavar='TEST_ID',
        help='View score trend for specific test case'
    )

    parser.add_argument(
        '--limit',
        type=int,
        default=10,
        help='Limit number of results (default: 10)'
    )

    args = parser.parse_args()

    # Handle commands
    if args.all:
        asyncio.run(run_all_tests_parallel(args.parallel))

    elif args.test:
        asyncio.run(run_single_test(args.test))

    elif args.history:
        print_header()
        print_history(limit=args.limit)

    elif args.trend:
        print_header()
        print_trend(args.trend, limit=args.limit)

    else:
        parser.print_help()
        print("\nExamples:")
        print("  python tests/cli/run_tests.py --all")
        print("  python tests/cli/run_tests.py --test tc001_pokemon_pptx")
        print("  python tests/cli/run_tests.py --history --limit 20")
        print("  python tests/cli/run_tests.py --trend tc001_pokemon_pptx")


if __name__ == "__main__":
    main()

