"""
Trend analyzer for tracking quality metrics over time.

Analyzes historical test results to identify trends, regressions,
and improvements.
"""

import logging
from typing import List, Dict, Optional
from tests.database.repository import TestRepository

logger = logging.getLogger(__name__)


class TrendAnalyzer:
    """Analyzes trends in test scores and metrics over time."""

    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the trend analyzer.

        Args:
            db_path: Unused placeholder retained for compatibility (no database writes)
        """
        self.db = TestRepository(db_path)

    def get_score_trend(self, test_case_id: str, limit: int = 20) -> List[Dict]:
        """
        Get score trend for a test case.

        Args:
            test_case_id: Test case ID
            limit: Number of historical runs to analyze

        Returns:
            List of score data points
        """
        return self.db.get_score_trend(test_case_id, limit=limit)

    def detect_regression(self, test_case_id: str, threshold: int = 10) -> Optional[Dict]:
        """
        Detect if a regression has occurred.

        Args:
            test_case_id: Test case ID
            threshold: Score drop threshold to consider regression (default: 10 points)

        Returns:
            Regression info dict if detected, None otherwise
        """
        trend = self.get_score_trend(test_case_id, limit=5)

        if len(trend) < 2:
            return None

        # Compare latest score to previous average
        latest_score = trend[-1]['overall_score']
        previous_scores = [run['overall_score'] for run in trend[:-1]]
        avg_previous = sum(previous_scores) / len(previous_scores)

        drop = avg_previous - latest_score

        if drop >= threshold:
            return {
                'test_case_id': test_case_id,
                'latest_score': latest_score,
                'previous_avg': avg_previous,
                'drop': drop,
                'severity': 'high' if drop >= 20 else 'medium'
            }

        return None

    def get_average_scores(
        self,
        test_case_id: Optional[str] = None,
        limit: int = 10
    ) -> Dict[str, float]:
        """
        Get average scores for recent runs.

        Args:
            test_case_id: Optional test case ID to filter by
            limit: Number of runs to average

        Returns:
            Dict with average scores
        """
        return self.db.get_average_scores(test_case_id, limit=limit)

    def compare_test_cases(self, limit: int = 10) -> List[Dict]:
        """
        Compare performance across different test cases.

        Args:
            limit: Number of recent runs per test case to analyze

        Returns:
            List of test case comparisons
        """
        # Get all unique test case IDs
        recent_runs = self.db.get_recent_runs(limit=100)
        test_case_ids = list(set(run['test_case_id'] for run in recent_runs))

        comparisons = []

        for test_case_id in test_case_ids:
            scores = self.get_average_scores(test_case_id, limit=limit)
            trend = self.get_score_trend(test_case_id, limit=limit)

            # Calculate stability (variance in scores)
            if len(trend) >= 3:
                overall_scores = [run['overall_score'] for run in trend]
                avg = sum(overall_scores) / len(overall_scores)
                variance = sum((score - avg) ** 2 for score in overall_scores) / len(overall_scores)
                stability = max(0, 100 - variance)  # Higher is more stable
            else:
                stability = None

            comparisons.append({
                'test_case_id': test_case_id,
                'avg_progress_score': scores['avg_progress_score'],
                'avg_output_score': scores['avg_output_score'],
                'avg_overall_score': scores['avg_overall_score'],
                'runs_count': len(trend),
                'stability': stability
            })

        # Sort by overall score
        comparisons.sort(key=lambda x: x['avg_overall_score'], reverse=True)

        return comparisons

    def get_summary_report(self) -> Dict:
        """
        Generate comprehensive summary report.

        Returns:
            Summary statistics
        """
        # Get recent runs
        recent_runs = self.db.get_recent_runs(limit=50)

        if not recent_runs:
            return {
                'total_runs': 0,
                'message': 'No test runs found'
            }

        # Overall statistics
        overall_scores = self.get_average_scores(limit=20)

        # Test case breakdown
        test_case_comparisons = self.compare_test_cases(limit=10)

        # Detect regressions
        regressions = []
        for comparison in test_case_comparisons:
            test_case_id = comparison['test_case_id']
            regression = self.detect_regression(test_case_id)
            if regression:
                regressions.append(regression)

        # Success rate
        completed = sum(1 for run in recent_runs if run['status'] == 'completed')
        success_rate = (completed / len(recent_runs) * 100) if recent_runs else 0

        return {
            'total_runs': len(recent_runs),
            'success_rate': success_rate,
            'overall_scores': overall_scores,
            'test_case_comparisons': test_case_comparisons,
            'regressions_detected': regressions,
            'regression_count': len(regressions)
        }

    def print_summary_report(self):
        """Print formatted summary report to console."""
        report = self.get_summary_report()

        print("\n" + "=" * 80)
        print("📊 Test Quality Summary Report")
        print("=" * 80 + "\n")

        print(f"Total Test Runs: {report['total_runs']}")
        print(f"Success Rate: {report['success_rate']:.1f}%")
        print(f"\nOverall Average Scores:")
        print(f"  Progress: {report['overall_scores']['avg_progress_score']:.1f}/100")
        print(f"  Output: {report['overall_scores']['avg_output_score']:.1f}/100")
        print(f"  Overall: {report['overall_scores']['avg_overall_score']:.1f}/100")

        print(f"\n📋 Test Case Performance:")
        print(f"{'Test Case':<40} {'Overall':<10} {'Stability':<12} {'Runs'}")
        print("─" * 75)

        for tc in report['test_case_comparisons']:
            test_case = tc['test_case_id'][:38]
            overall = f"{tc['avg_overall_score']:.1f}"
            stability = f"{tc['stability']:.1f}" if tc['stability'] else "N/A"
            runs = tc['runs_count']

            print(f"{test_case:<40} {overall:<10} {stability:<12} {runs}")

        if report['regressions_detected']:
            print(f"\n⚠️  Regressions Detected: {report['regression_count']}")
            for reg in report['regressions_detected']:
                print(f"  • {reg['test_case_id']}: {reg['latest_score']:.1f} (down {reg['drop']:.1f} points)")
        else:
            print(f"\n✅ No regressions detected")

        print(f"\n{'=' * 80}\n")
