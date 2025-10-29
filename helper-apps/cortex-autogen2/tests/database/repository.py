"""
Database repository for test results storage and retrieval.

This module provides a clean interface for storing and querying test data
from the SQLite database.
"""

import sqlite3
import json
import os
from datetime import datetime
from typing import List, Dict, Optional, Any
from pathlib import Path


class TestRepository:
    """Repository for managing test results in SQLite database."""

    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the repository.

        Args:
            db_path: Path to SQLite database file. If None, uses default location.
        """
        if db_path is None:
            db_dir = Path(__file__).parent
            db_path = db_dir / "test_results.db"

        self.db_path = str(db_path)
        self._initialize_database()

    def _initialize_database(self):
        """Create database and tables if they don't exist."""
        schema_path = Path(__file__).parent / "schema.sql"

        with open(schema_path, 'r') as f:
            schema = f.read()

        conn = sqlite3.connect(self.db_path)
        conn.executescript(schema)
        conn.commit()
        conn.close()

    def _get_connection(self) -> sqlite3.Connection:
        """Get a database connection with row factory."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    # ==================== Test Runs ====================

    def create_test_run(
        self,
        test_case_id: str,
        task_description: str,
        request_id: str
    ) -> int:
        """
        Create a new test run record.

        Returns:
            test_run_id: The ID of the created test run
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO test_runs (test_case_id, task_description, request_id, started_at, status)
            VALUES (?, ?, ?, ?, 'running')
        """, (test_case_id, task_description, request_id, datetime.now()))

        test_run_id = cursor.lastrowid
        conn.commit()
        conn.close()

        return test_run_id

    def update_test_run_status(
        self,
        test_run_id: int,
        status: str,
        completed_at: Optional[datetime] = None,
        error_message: Optional[str] = None
    ):
        """Update test run status and completion time."""
        conn = self._get_connection()
        cursor = conn.cursor()

        if completed_at is None and status in ('completed', 'failed', 'timeout'):
            completed_at = datetime.now()

        # Calculate duration if completed
        duration_seconds = None
        if completed_at:
            cursor.execute("SELECT started_at FROM test_runs WHERE id = ?", (test_run_id,))
            row = cursor.fetchone()
            if row:
                started_at = datetime.fromisoformat(row['started_at'])
                duration_seconds = (completed_at - started_at).total_seconds()

        cursor.execute("""
            UPDATE test_runs
            SET status = ?, completed_at = ?, duration_seconds = ?, error_message = ?
            WHERE id = ?
        """, (status, completed_at, duration_seconds, error_message, test_run_id))

        conn.commit()
        conn.close()

    def save_final_response(self, test_run_id: int, final_response: str):
        """
        Save the final response message sent to the user.

        This stores the complete final message including file URLs,
        making it easy to retrieve outputs from any test run.

        Args:
            test_run_id: ID of the test run
            final_response: The complete final message text with URLs
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            UPDATE test_runs
            SET final_response = ?
            WHERE id = ?
        """, (final_response, test_run_id))

        conn.commit()
        conn.close()

    def get_test_run(self, test_run_id: int) -> Optional[Dict[str, Any]]:
        """Get test run by ID."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM test_runs WHERE id = ?", (test_run_id,))
        row = cursor.fetchone()
        conn.close()

        return dict(row) if row else None

    def get_recent_runs(self, test_case_id: Optional[str] = None, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent test runs, optionally filtered by test case."""
        conn = self._get_connection()
        cursor = conn.cursor()

        if test_case_id:
            cursor.execute("""
                SELECT * FROM test_runs
                WHERE test_case_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            """, (test_case_id, limit))
        else:
            cursor.execute("""
                SELECT * FROM test_runs
                ORDER BY created_at DESC
                LIMIT ?
            """, (limit,))

        rows = cursor.fetchall()
        conn.close()

        return [dict(row) for row in rows]

    # ==================== Progress Updates ====================

    def add_progress_update(
        self,
        test_run_id: int,
        timestamp: datetime,
        progress: float,
        info: str,
        is_final: bool = False
    ):
        """Add a progress update to the database."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO progress_updates (test_run_id, timestamp, progress, info, is_final)
            VALUES (?, ?, ?, ?, ?)
        """, (test_run_id, timestamp, progress, info, is_final))

        conn.commit()
        conn.close()

    def get_progress_updates(self, test_run_id: int) -> List[Dict[str, Any]]:
        """Get all progress updates for a test run."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM progress_updates
            WHERE test_run_id = ?
            ORDER BY timestamp ASC
        """, (test_run_id,))

        rows = cursor.fetchall()
        conn.close()

        return [dict(row) for row in rows]

    # ==================== Logs ====================

    def add_log(
        self,
        test_run_id: int,
        timestamp: datetime,
        level: str,
        agent: Optional[str],
        message: str
    ):
        """Add a log entry."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO logs (test_run_id, timestamp, level, agent, message)
            VALUES (?, ?, ?, ?, ?)
        """, (test_run_id, timestamp, level, agent, message))

        conn.commit()
        conn.close()

    def get_logs(self, test_run_id: int, level: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get logs for a test run, optionally filtered by level."""
        conn = self._get_connection()
        cursor = conn.cursor()

        if level:
            cursor.execute("""
                SELECT * FROM logs
                WHERE test_run_id = ? AND level = ?
                ORDER BY timestamp ASC
            """, (test_run_id, level))
        else:
            cursor.execute("""
                SELECT * FROM logs
                WHERE test_run_id = ?
                ORDER BY timestamp ASC
            """, (test_run_id,))

        rows = cursor.fetchall()
        conn.close()

        return [dict(row) for row in rows]

    # ==================== Files ====================

    def add_file(
        self,
        test_run_id: int,
        file_path: str,
        file_type: str,
        file_size_bytes: Optional[int] = None,
        sas_url: Optional[str] = None
    ):
        """Add a file created during test execution."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO files_created (test_run_id, file_path, file_type, file_size_bytes, sas_url)
            VALUES (?, ?, ?, ?, ?)
        """, (test_run_id, file_path, file_type, file_size_bytes, sas_url))

        conn.commit()
        conn.close()

    def get_files(self, test_run_id: int) -> List[Dict[str, Any]]:
        """Get all files created during a test run."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM files_created
            WHERE test_run_id = ?
            ORDER BY created_at ASC
        """, (test_run_id,))

        rows = cursor.fetchall()
        conn.close()

        return [dict(row) for row in rows]

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

        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT OR REPLACE INTO evaluations (
                test_run_id, progress_score, output_score, overall_score,
                progress_reasoning, output_reasoning,
                progress_issues, output_strengths, output_weaknesses
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            test_run_id, progress_score, output_score, overall_score,
            progress_reasoning, output_reasoning,
            json.dumps(progress_issues or []),
            json.dumps(output_strengths or []),
            json.dumps(output_weaknesses or [])
        ))

        conn.commit()
        conn.close()

    def get_evaluation(self, test_run_id: int) -> Optional[Dict[str, Any]]:
        """Get evaluation for a test run."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM evaluations WHERE test_run_id = ?", (test_run_id,))
        row = cursor.fetchone()
        conn.close()

        if row:
            result = dict(row)
            # Parse JSON fields
            result['progress_issues'] = json.loads(result['progress_issues'])
            result['output_strengths'] = json.loads(result['output_strengths'])
            result['output_weaknesses'] = json.loads(result['output_weaknesses'])
            return result

        return None

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
        """Save performance metrics."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT OR REPLACE INTO metrics (
                test_run_id, time_to_first_progress, time_to_completion,
                total_progress_updates, avg_update_interval,
                min_update_interval, max_update_interval,
                files_created, sas_urls_provided,
                errors_count, warnings_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            test_run_id, time_to_first_progress, time_to_completion,
            total_progress_updates, avg_update_interval,
            min_update_interval, max_update_interval,
            files_created, sas_urls_provided,
            errors_count, warnings_count
        ))

        conn.commit()
        conn.close()

    def get_metrics(self, test_run_id: int) -> Optional[Dict[str, Any]]:
        """Get metrics for a test run."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM metrics WHERE test_run_id = ?", (test_run_id,))
        row = cursor.fetchone()
        conn.close()

        return dict(row) if row else None

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
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO suggestions (test_run_id, suggestion, category, priority, code_reference)
            VALUES (?, ?, ?, ?, ?)
        """, (test_run_id, suggestion, category, priority, code_reference))

        conn.commit()
        conn.close()

    def get_suggestions(self, test_run_id: int) -> List[Dict[str, Any]]:
        """Get all suggestions for a test run."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM suggestions
            WHERE test_run_id = ?
            ORDER BY priority DESC, created_at ASC
        """, (test_run_id,))

        rows = cursor.fetchall()
        conn.close()

        return [dict(row) for row in rows]

    # ==================== Analytics ====================

    def get_average_scores(self, test_case_id: Optional[str] = None, limit: int = 10) -> Dict[str, float]:
        """Get average scores for recent test runs."""
        conn = self._get_connection()
        cursor = conn.cursor()

        if test_case_id:
            cursor.execute("""
                SELECT AVG(e.progress_score) as avg_progress,
                       AVG(e.output_score) as avg_output,
                       AVG(e.overall_score) as avg_overall
                FROM evaluations e
                JOIN test_runs tr ON e.test_run_id = tr.id
                WHERE tr.test_case_id = ? AND tr.status = 'completed'
                AND tr.id IN (
                    SELECT id FROM test_runs
                    WHERE test_case_id = ?
                    ORDER BY created_at DESC
                    LIMIT ?
                )
            """, (test_case_id, test_case_id, limit))
        else:
            cursor.execute("""
                SELECT AVG(e.progress_score) as avg_progress,
                       AVG(e.output_score) as avg_output,
                       AVG(e.overall_score) as avg_overall
                FROM evaluations e
                JOIN test_runs tr ON e.test_run_id = tr.id
                WHERE tr.status = 'completed'
                AND tr.id IN (
                    SELECT id FROM test_runs
                    ORDER BY created_at DESC
                    LIMIT ?
                )
            """, (limit,))

        row = cursor.fetchone()
        conn.close()

        if row:
            return {
                'avg_progress_score': row['avg_progress'] or 0,
                'avg_output_score': row['avg_output'] or 0,
                'avg_overall_score': row['avg_overall'] or 0
            }

        return {'avg_progress_score': 0, 'avg_output_score': 0, 'avg_overall_score': 0}

    def get_score_trend(self, test_case_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Get score trend over time for a specific test case."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT tr.created_at, e.progress_score, e.output_score, e.overall_score
            FROM test_runs tr
            JOIN evaluations e ON tr.id = e.test_run_id
            WHERE tr.test_case_id = ? AND tr.status = 'completed'
            ORDER BY tr.created_at ASC
            LIMIT ?
        """, (test_case_id, limit))

        rows = cursor.fetchall()
        conn.close()

        return [dict(row) for row in rows]
