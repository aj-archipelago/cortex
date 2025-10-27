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

# Add parent directories to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import load_dotenv
from tests.orchestrator import TestOrchestrator
from tests.database.repository import TestRepository
from tests.analysis.trend_analyzer import TrendAnalyzer

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

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
    print(f"\n📊 Scores:")
    print(f"  Progress: {result.get('progress_evaluation', {}).get('score', 0)}/100")
    print(f"  Output: {result.get('output_evaluation', {}).get('score', 0)}/100")
    print(f"  Overall: {result.get('overall_score', 0)}/100")

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


async def run_all_tests():
    """Run all test cases."""
    print_header()
    print("🚀 Running all test cases...\n")

    orchestrator = TestOrchestrator()
    results = await orchestrator.run_all_tests()

    # Print individual results
    for result in results:
        print_test_result(result)

    # Print final summary
    print("\n" + "=" * 80)
    print("📊 Final Summary")
    print("=" * 80 + "\n")

    passed = sum(1 for r in results if r.get('overall_score', 0) >= 70)
    failed = len(results) - passed

    print(f"Total Tests: {len(results)}")
    print(f"Passed (≥70): {passed}")
    print(f"Failed (<70): {failed}")

    avg_overall = sum(r.get('overall_score', 0) for r in results) / len(results) if results else 0
    print(f"Average Overall Score: {avg_overall:.1f}/100")

    print(f"\n{'=' * 80}\n")


async def run_single_test(test_case_id: str):
    """Run a single test case."""
    print_header()
    print(f"🎯 Running test case: {test_case_id}\n")

    orchestrator = TestOrchestrator()
    test_cases = orchestrator.load_test_cases()

    # Find the test case
    test_case = next((tc for tc in test_cases if tc['id'] == test_case_id), None)

    if not test_case:
        print(f"❌ Test case not found: {test_case_id}")
        print(f"\nAvailable test cases:")
        for tc in test_cases:
            print(f"  • {tc['id']} - {tc['name']}")
        return

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
        asyncio.run(run_all_tests())

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
