"""
In-memory / null repository for test result metadata.

There is no test database anymore. All methods are lightweight, process-local,
and safe no-ops for callers that still expect the old interface.
"""

import threading
from datetime import datetime
from typing import Any, Dict, List, Optional


class TestRepository:
    """In-memory stand-in for the former SQLite-backed repository (no DB)."""

    # Class-level storage shared across instances in the same process
    _lock = threading.RLock()
    _runs: Dict[int, Dict[str, Any]] = {}
    _progress: Dict[int, List[Dict[str, Any]]] = {}
    _logs: Dict[int, List[Dict[str, Any]]] = {}
    _files: Dict[int, List[Dict[str, Any]]] = {}
    _evaluations: Dict[int, Dict[str, Any]] = {}
    _metrics: Dict[int, Dict[str, Any]] = {}
    _suggestions: Dict[int, List[Dict[str, Any]]] = {}
    _next_id: int = 1

    def __init__(self, db_path: Optional[str] = None):
        # Signature kept for backward compatibility; db_path is unused (no DB).
        self._lock = self.__class__._lock

    # ==================== Helpers ====================
    @staticmethod
    def _iso(dt: datetime) -> str:
        return dt.isoformat()

    @classmethod
    def _new_id(cls) -> int:
        with cls._lock:
            test_run_id = cls._next_id
            cls._next_id += 1
            return test_run_id

    @classmethod
    def _get_run(cls, test_run_id: int) -> Optional[Dict[str, Any]]:
        return cls._runs.get(test_run_id)

    # ==================== Test Runs ====================
    def create_test_run(
        self,
        test_case_id: str,
        task_description: str,
        request_id: str
    ) -> int:
        """Create a new in-memory test run record."""
        now = datetime.now()
        test_run_id = self._new_id()
        run_record = {
            'id': test_run_id,
            'test_case_id': test_case_id,
            'task_description': task_description,
            'request_id': request_id,
            'started_at': self._iso(now),
            'status': 'running',
            'error_message': None,
            'final_response': None,
            'completed_at': None,
            'duration_seconds': None,
            'created_at': self._iso(now),
        }

        with self._lock:
            self._runs[test_run_id] = run_record
            self._progress[test_run_id] = []
            self._logs[test_run_id] = []
            self._files[test_run_id] = []
            self._suggestions[test_run_id] = []

        return test_run_id

    def update_test_run_status(
        self,
        test_run_id: int,
        status: str,
        completed_at: Optional[datetime] = None,
        error_message: Optional[str] = None
    ):
        """Update test run status, completion time, and duration."""
        with self._lock:
            run = self._get_run(test_run_id)
            if not run:
                return

            finished_at = completed_at or (datetime.now() if status in ('completed', 'failed', 'timeout') else None)
            if finished_at:
                run['completed_at'] = self._iso(finished_at)
                try:
                    started_at = datetime.fromisoformat(run['started_at'])
                    run['duration_seconds'] = (finished_at - started_at).total_seconds()
                except Exception:
                    run['duration_seconds'] = None

            run['status'] = status
            run['error_message'] = error_message

    def save_final_response(self, test_run_id: int, final_response: str):
        """Store the final response text for a run."""
        with self._lock:
            run = self._get_run(test_run_id)
            if run is not None:
                run['final_response'] = final_response

    def get_test_run(self, test_run_id: int) -> Optional[Dict[str, Any]]:
        """Get a copy of a test run by ID."""
        with self._lock:
            run = self._get_run(test_run_id)
            return dict(run) if run else None

    def get_recent_runs(self, test_case_id: Optional[str] = None, limit: int = 10) -> List[Dict[str, Any]]:
        """Return recent runs (newest first), optionally filtered by test case."""
        with self._lock:
            runs = list(self._runs.values())
            if test_case_id:
                runs = [r for r in runs if r.get('test_case_id') == test_case_id]
            runs.sort(key=lambda r: r.get('created_at', ''), reverse=True)
            return [dict(r) for r in runs[:limit]]

    # ==================== Progress Updates ====================
    def add_progress_update(
        self,
        test_run_id: int,
        timestamp: datetime,
        progress: float,
        info: str,
        is_final: bool = False
    ):
        """Append a progress update to the in-memory log."""
        update = {
            'timestamp': self._iso(timestamp),
            'progress': progress,
            'info': info,
            'is_final': is_final
        }
        with self._lock:
            self._progress.setdefault(test_run_id, []).append(update)

    def get_progress_updates(self, test_run_id: int) -> List[Dict[str, Any]]:
        """Get sorted progress updates for a run."""
        with self._lock:
            updates = list(self._progress.get(test_run_id, []))
        return sorted(updates, key=lambda u: u.get('timestamp', ''))

    # ==================== Logs ====================
    def add_log(
        self,
        test_run_id: int,
        timestamp: datetime,
        level: str,
        agent: Optional[str],
        message: str
    ):
        """Append a log entry for a run."""
        entry = {
            'timestamp': self._iso(timestamp),
            'level': level,
            'agent': agent,
            'message': message
        }
        with self._lock:
            self._logs.setdefault(test_run_id, []).append(entry)

    def get_logs(self, test_run_id: int, level: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get logs for a run, optionally filtered by level."""
        with self._lock:
            logs = list(self._logs.get(test_run_id, []))
        if level:
            logs = [log for log in logs if log.get('level') == level]
        return sorted(logs, key=lambda l: l.get('timestamp', ''))

    # ==================== Files ====================
    def add_file(
        self,
        test_run_id: int,
        file_path: str,
        file_type: str,
        file_size_bytes: Optional[int] = None,
        sas_url: Optional[str] = None
    ):
        """Record a created file for a run."""
        entry = {
            'file_path': file_path,
            'file_type': file_type,
            'file_size_bytes': file_size_bytes,
            'sas_url': sas_url,
            'created_at': self._iso(datetime.now())
        }
        with self._lock:
            self._files.setdefault(test_run_id, []).append(entry)

    def get_files(self, test_run_id: int) -> List[Dict[str, Any]]:
        """Return files created during a run."""
        with self._lock:
            files = list(self._files.get(test_run_id, []))
        return sorted(files, key=lambda f: f.get('created_at', ''))

    # ==================== Evaluations ====================
    def save_evaluation(
        self,
        test_run_id: int,
        progress_score: int,
        output_score: int,
        progress_reasoning: str,
        output_reasoning: str,
        progress_issues: Optional[List[str]] = None,
        output_strengths: Optional[List[str]] = None,
        output_weaknesses: Optional[List[str]] = None
    ):
        """Save evaluation scores and reasoning."""
        overall_score = int((output_score * 0.8) + (progress_score * 0.2))
        evaluation = {
            'test_run_id': test_run_id,
            'progress_score': progress_score,
            'output_score': output_score,
            'overall_score': overall_score,
            'progress_reasoning': progress_reasoning,
            'output_reasoning': output_reasoning,
            'progress_issues': progress_issues or [],
            'output_strengths': output_strengths or [],
            'output_weaknesses': output_weaknesses or []
        }
        with self._lock:
            self._evaluations[test_run_id] = evaluation

    def get_evaluation(self, test_run_id: int) -> Optional[Dict[str, Any]]:
        """Get evaluation for a test run."""
        with self._lock:
            evaluation = self._evaluations.get(test_run_id)
            return dict(evaluation) if evaluation else None

    # ==================== Metrics ====================
    def save_metrics(
        self,
        test_run_id: int,
        time_to_first_progress: float,
        time_to_completion: float,
        total_progress_updates: int,
        avg_update_interval: float,
        min_update_interval: float,
        max_update_interval: float,
        files_created: int,
        sas_urls_provided: int,
        errors_count: int,
        warnings_count: int
    ):
        """Save calculated metrics for a run."""
        metrics = {
            'test_run_id': test_run_id,
            'time_to_first_progress': time_to_first_progress,
            'time_to_completion': time_to_completion,
            'total_progress_updates': total_progress_updates,
            'avg_update_interval': avg_update_interval,
            'min_update_interval': min_update_interval,
            'max_update_interval': max_update_interval,
            'files_created': files_created,
            'sas_urls_provided': sas_urls_provided,
            'errors_count': errors_count,
            'warnings_count': warnings_count
        }
        with self._lock:
            self._metrics[test_run_id] = metrics

    def get_metrics(self, test_run_id: int) -> Optional[Dict[str, Any]]:
        """Get metrics for a test run."""
        with self._lock:
            metrics = self._metrics.get(test_run_id)
            return dict(metrics) if metrics else None

    # ==================== Suggestions ====================
    def add_suggestion(
        self,
        test_run_id: int,
        suggestion: str,
        category: str = 'other',
        priority: str = 'medium',
        code_reference: Optional[str] = None
    ):
        """Add an improvement suggestion."""
        entry = {
            'suggestion': suggestion,
            'category': category,
            'priority': priority,
            'code_reference': code_reference,
            'created_at': self._iso(datetime.now())
        }
        with self._lock:
            self._suggestions.setdefault(test_run_id, []).append(entry)

    def get_suggestions(self, test_run_id: int) -> List[Dict[str, Any]]:
        """Get suggestions for a run."""
        with self._lock:
            suggestions = list(self._suggestions.get(test_run_id, []))
        return sorted(suggestions, key=lambda s: (s.get('priority', ''), s.get('created_at', '')))

    # ==================== Analytics ====================
    def get_average_scores(self, test_case_id: Optional[str] = None, limit: int = 10) -> Dict[str, float]:
        """Compute average scores from stored evaluations."""
        with self._lock:
            evals = list(self._evaluations.values())
            if test_case_id:
                allowed_ids = {rid for rid, run in self._runs.items() if run.get('test_case_id') == test_case_id}
                evals = [e for e in evals if e['test_run_id'] in allowed_ids]

            # Consider only the most recent `limit` runs
            recent_runs = self.get_recent_runs(test_case_id=test_case_id, limit=limit)
            recent_ids = {r['id'] for r in recent_runs}
            evals = [e for e in evals if e['test_run_id'] in recent_ids]

        if not evals:
            return {'avg_progress_score': 0, 'avg_output_score': 0, 'avg_overall_score': 0}

        avg_progress = sum(e['progress_score'] for e in evals) / len(evals)
        avg_output = sum(e['output_score'] for e in evals) / len(evals)
        avg_overall = sum(e['overall_score'] for e in evals) / len(evals)

        return {
            'avg_progress_score': avg_progress,
            'avg_output_score': avg_output,
            'avg_overall_score': avg_overall
        }

    def get_score_trend(self, test_case_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Get score trend over time for a specific test case."""
        recent_runs = self.get_recent_runs(test_case_id=test_case_id, limit=limit)
        recent_ids = {r['id'] for r in recent_runs}

        trend = []
        with self._lock:
            for run in sorted(recent_runs, key=lambda r: r.get('created_at', '')):
                eval_data = self._evaluations.get(run['id'])
                if not eval_data:
                    continue
                trend.append({
                    'created_at': run.get('created_at'),
                    'progress_score': eval_data.get('progress_score', 0),
                    'output_score': eval_data.get('output_score', 0),
                    'overall_score': eval_data.get('overall_score', 0)
                })

        return trend
