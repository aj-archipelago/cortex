"""
Metrics collector for test performance analysis.

Calculates latency, frequency, and quality metrics from test run data.
"""

import logging
from datetime import datetime
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)


class MetricsCollector:
    """Collects and calculates performance metrics from test data."""

    @staticmethod
    def calculate_metrics(
        test_run_data: Dict,
        progress_updates: List[Dict],
        logs: List[Dict],
        files_created: List[Dict]
    ) -> Dict:
        """
        Calculate comprehensive metrics from test run data.

        Args:
            test_run_data: Test run information (started_at, completed_at, etc.)
            progress_updates: List of progress updates
            logs: List of log entries
            files_created: List of files created

        Returns:
            Dictionary with calculated metrics
        """
        logger.info("📈 Calculating metrics...")

        metrics = {}

        # Time metrics
        metrics.update(MetricsCollector._calculate_time_metrics(test_run_data, progress_updates))

        # Progress update metrics
        metrics.update(MetricsCollector._calculate_progress_metrics(progress_updates))

        # Log metrics
        metrics.update(MetricsCollector._calculate_log_metrics(logs))

        # File metrics
        metrics.update(MetricsCollector._calculate_file_metrics(files_created))

        logger.info(f"   Time to completion: {metrics.get('time_to_completion', 0):.1f}s")
        logger.info(f"   Progress updates: {metrics.get('total_progress_updates', 0)}")
        logger.info(f"   Files created: {metrics.get('files_created', 0)}")
        logger.info(f"   Errors: {metrics.get('errors_count', 0)}")

        return metrics

    @staticmethod
    def _calculate_time_metrics(test_run_data: Dict, progress_updates: List[Dict]) -> Dict:
        """Calculate timing-related metrics."""
        started_at_str = test_run_data.get('started_at')
        completed_at_str = test_run_data.get('completed_at')

        if not started_at_str:
            return {
                'time_to_first_progress': 0,
                'time_to_completion': 0
            }

        started_at = datetime.fromisoformat(started_at_str)

        # Time to first progress update
        time_to_first_progress = 0
        if progress_updates:
            first_update_time = datetime.fromisoformat(progress_updates[0]['timestamp'])
            time_to_first_progress = (first_update_time - started_at).total_seconds()

        # Time to completion
        time_to_completion = 0
        if completed_at_str:
            completed_at = datetime.fromisoformat(completed_at_str)
            time_to_completion = (completed_at - started_at).total_seconds()
        elif progress_updates:
            # Use last progress update time if no completion time
            last_update_time = datetime.fromisoformat(progress_updates[-1]['timestamp'])
            time_to_completion = (last_update_time - started_at).total_seconds()

        return {
            'time_to_first_progress': time_to_first_progress,
            'time_to_completion': time_to_completion
        }

    @staticmethod
    def _calculate_progress_metrics(progress_updates: List[Dict]) -> Dict:
        """Calculate progress update frequency metrics."""
        if not progress_updates:
            return {
                'total_progress_updates': 0,
                'avg_update_interval': 0,
                'min_update_interval': 0,
                'max_update_interval': 0
            }

        # Calculate intervals between updates
        intervals = []
        for i in range(1, len(progress_updates)):
            prev_time = datetime.fromisoformat(progress_updates[i-1]['timestamp'])
            curr_time = datetime.fromisoformat(progress_updates[i]['timestamp'])
            interval = (curr_time - prev_time).total_seconds()
            intervals.append(interval)

        avg_interval = sum(intervals) / len(intervals) if intervals else 0
        min_interval = min(intervals) if intervals else 0
        max_interval = max(intervals) if intervals else 0

        return {
            'total_progress_updates': len(progress_updates),
            'avg_update_interval': avg_interval,
            'min_update_interval': min_interval,
            'max_update_interval': max_interval
        }

    @staticmethod
    def _calculate_log_metrics(logs: List[Dict]) -> Dict:
        """Calculate log-related metrics."""
        if not logs:
            return {
                'errors_count': 0,
                'warnings_count': 0
            }

        errors = sum(1 for log in logs if log.get('level') == 'ERROR')
        warnings = sum(1 for log in logs if log.get('level') in ('WARNING', 'WARN'))

        return {
            'errors_count': errors,
            'warnings_count': warnings
        }

    @staticmethod
    def _calculate_file_metrics(files_created: List[Dict]) -> Dict:
        """Calculate file creation metrics."""
        if not files_created:
            return {
                'files_created': 0,
                'sas_urls_provided': 0
            }

        sas_urls = sum(1 for file in files_created if file.get('sas_url'))

        return {
            'files_created': len(files_created),
            'sas_urls_provided': sas_urls
        }
