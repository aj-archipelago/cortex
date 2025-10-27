-- Cortex AutoGen2 Test Results Database Schema
-- SQLite database for storing test runs, evaluations, and metrics

-- Test runs table - stores information about each test execution
CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_case_id TEXT NOT NULL,
    task_description TEXT NOT NULL,
    request_id TEXT UNIQUE,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    duration_seconds REAL,
    status TEXT CHECK(status IN ('running', 'completed', 'failed', 'timeout')) NOT NULL DEFAULT 'running',
    error_message TEXT,
    final_response TEXT,  -- Stores the complete final message sent to user with file URLs
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Progress updates collected during test execution
CREATE TABLE IF NOT EXISTS progress_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    progress REAL,
    info TEXT,
    is_final BOOLEAN DEFAULT 0,
    FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- Docker logs collected during test execution
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    level TEXT,
    agent TEXT,
    message TEXT,
    FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- Files created during test execution
CREATE TABLE IF NOT EXISTS files_created (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER NOT NULL,
    file_path TEXT,
    file_type TEXT,
    file_size_bytes INTEGER,
    sas_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- LLM-based evaluation scores
CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER UNIQUE NOT NULL,
    progress_score INTEGER CHECK(progress_score BETWEEN 0 AND 100),
    output_score INTEGER CHECK(output_score BETWEEN 0 AND 100),
    overall_score INTEGER CHECK(overall_score BETWEEN 0 AND 100),
    progress_reasoning TEXT,
    output_reasoning TEXT,
    progress_issues TEXT,  -- JSON array of issues found
    output_strengths TEXT,  -- JSON array of strengths
    output_weaknesses TEXT,  -- JSON array of weaknesses
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- Performance metrics
CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER UNIQUE NOT NULL,
    time_to_first_progress REAL,
    time_to_completion REAL,
    total_progress_updates INTEGER,
    avg_update_interval REAL,
    min_update_interval REAL,
    max_update_interval REAL,
    files_created INTEGER,
    sas_urls_provided INTEGER,
    errors_count INTEGER,
    warnings_count INTEGER,
    FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- Improvement suggestions from LLM analysis
CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER NOT NULL,
    suggestion TEXT NOT NULL,
    category TEXT CHECK(category IN ('performance', 'quality', 'reliability', 'other')) DEFAULT 'other',
    priority TEXT CHECK(priority IN ('high', 'medium', 'low')) DEFAULT 'medium',
    code_reference TEXT,  -- File path or agent name related to suggestion
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_test_runs_test_case ON test_runs(test_case_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
CREATE INDEX IF NOT EXISTS idx_test_runs_created_at ON test_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_progress_updates_run ON progress_updates(test_run_id);
CREATE INDEX IF NOT EXISTS idx_progress_updates_timestamp ON progress_updates(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(test_run_id);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_files_created_run ON files_created(test_run_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_run ON suggestions(test_run_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_priority ON suggestions(priority);
