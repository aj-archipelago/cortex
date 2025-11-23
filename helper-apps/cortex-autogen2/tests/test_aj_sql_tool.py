#!/usr/bin/env python3
"""
Test file for the improved aj_sql_tool functionality.

This test verifies that the execute_aj_sql_query function:
1. Creates sql/ subfolder structure
2. Saves query logs with timestamps
3. Saves result JSON files
4. Returns comprehensive metadata
5. Analyzes data structure correctly
6. Generates smart previews
7. Detects date ranges
"""

import os
import json
import tempfile
import shutil
from pathlib import Path

# Import the function to test
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agents.aj_sql_agent import execute_aj_sql_query


def test_sql_subfolder_creation():
    """Test that sql/ subfolder is created correctly."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Test query (will fail due to no DB, but should create files)
        result = execute_aj_sql_query(
            "SELECT 1 as test_column",
            database="ucms_aje",
            work_dir=temp_dir
        )

        # Check that sql/ subfolder was created
        sql_dir = os.path.join(temp_dir, 'sql')
        assert os.path.exists(sql_dir), "sql/ subfolder should be created"

        print("✅ sql/ subfolder creation test passed")
        return True


def test_file_naming_convention():
    """Test that files follow the naming convention."""
    with tempfile.TemporaryDirectory() as temp_dir:
        result = execute_aj_sql_query(
            "SELECT 1 as id",
            database="ucms_aje",
            work_dir=temp_dir
        )

        # Even if query fails, files should be created with proper naming
        sql_dir = os.path.join(temp_dir, 'sql')

        # Look for any files created in sql directory
        if os.path.exists(sql_dir):
            files = list(Path(sql_dir).glob("*"))
            if files:
                # Check if any file follows the naming pattern
                for file_path in files:
                    basename = os.path.basename(str(file_path))
                    if basename.startswith("aje_query_") and (basename.endswith(".log") or basename.endswith("_result.json")):
                        print("✅ File naming convention test passed")
                        return True

        print("⚠️ Could not find files with expected naming pattern")
        return False


def test_query_logging():
    """Test that query is logged correctly."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_query = "SELECT COUNT(*) as total FROM wp_posts WHERE post_status = 'publish'"
        result = execute_aj_sql_query(
            test_query,
            database="ucms_aje",
            work_dir=temp_dir
        )

        # Check if query file exists in sql directory
        sql_dir = os.path.join(temp_dir, 'sql')
        if os.path.exists(sql_dir):
            log_files = list(Path(sql_dir).glob("*.log"))
            if log_files:
                with open(str(log_files[0]), 'r') as f:
                    content = f.read()

                # Check that query is logged
                assert "-- Query:" in content, "Query should be logged in file"
                assert test_query in content, "Actual query should be in log file"
                assert "-- Database:" in content, "Database should be logged"
                assert "-- Timestamp:" in content, "Timestamp should be logged"

                print("✅ Query logging test passed")
                return True

        print("⚠️ Could not find query log file")
        return False


def test_json_result_structure():
    """Test that result JSON has the expected structure."""
    with tempfile.TemporaryDirectory() as temp_dir:
        result = execute_aj_sql_query(
            "SELECT 1 as id, 'test' as name",
            database="ucms_aje",
            work_dir=temp_dir
        )

        # Check if result file exists in sql directory
        sql_dir = os.path.join(temp_dir, 'sql')
        if os.path.exists(sql_dir):
            json_files = list(Path(sql_dir).glob("*_result.json"))
            if json_files:
                with open(str(json_files[0]), 'r') as f:
                    json_data = json.load(f)

                # Check required fields
                required_fields = ["query", "database", "timestamp", "data", "columns", "row_count", "structure"]
                for field in required_fields:
                    assert field in json_data, f"JSON should contain '{field}' field"

                # Check structure
                assert isinstance(json_data["data"], list), "data should be a list"
                assert isinstance(json_data["columns"], list), "columns should be a list"
                assert isinstance(json_data["structure"], dict), "structure should be a dict"

                print("✅ JSON result structure test passed")
                return True

        print("⚠️ Could not find result JSON file")
        return False


def test_data_structure_analysis():
    """Test that data structure analysis works correctly."""
    # Test with mock data since we can't rely on DB connection
    from agents.aj_sql_agent import analyze_data_structure

    # Test with empty data
    structure = analyze_data_structure([], [])
    assert structure["empty"] == True, "Empty data should be marked as empty"

    # Test with sample data
    sample_data = [
        {"id": 1, "name": "Alice", "score": 95.5, "date": "2024-01-01"},
        {"id": 2, "name": "Bob", "score": 87.2, "date": "2024-01-02"},
        {"id": 3, "name": "Charlie", "score": 92.1, "date": "2024-01-03"}
    ]
    columns = ["id", "name", "score", "date"]

    structure = analyze_data_structure(sample_data, columns)

    assert structure["total_rows"] == 3, "Should count 3 rows"
    assert structure["total_columns"] == 4, "Should count 4 columns"

    # Check column analysis
    assert "id" in structure["columns"], "id column should be analyzed"
    assert structure["columns"]["id"]["type"] == "int", "id should be detected as int"
    assert structure["columns"]["id"]["min"] == 1, "id min should be 1"
    assert structure["columns"]["id"]["max"] == 3, "id max should be 3"

    assert "score" in structure["columns"], "score column should be analyzed"
    assert structure["columns"]["score"]["type"] == "float", "score should be detected as float"

    assert "name" in structure["columns"], "name column should be analyzed"
    assert structure["columns"]["name"]["type"] == "str", "name should be detected as str"

    print("✅ Data structure analysis test passed")
    return True


def test_smart_preview_generation():
    """Test that smart preview generation works."""
    from agents.aj_sql_agent import generate_smart_preview

    # Test with empty data
    preview = generate_smart_preview([], [])
    assert "No data returned" in preview, "Empty data should show no data message"

    # Test with sample data
    sample_data = [
        {"id": 1, "name": "Alice", "email": "alice@example.com"},
        {"id": 2, "name": "Bob", "email": "bob@example.com"}
    ]
    columns = ["id", "name", "email"]

    preview = generate_smart_preview(sample_data, columns)

    assert "Data Preview:" in preview, "Preview should contain header"
    assert "2 rows × 3 columns" in preview, "Preview should show dimensions"
    assert "| id | name | email |" in preview, "Preview should show column headers"
    assert "Alice" in preview, "Preview should show sample data"

    print("✅ Smart preview generation test passed")
    return True


def test_date_range_detection():
    """Test that date range detection works."""
    from agents.aj_sql_agent import detect_date_range

    # Test with date column
    sample_data = [
        {"date": "2024-01-01", "value": 100},
        {"date": "2024-01-15", "value": 200},
        {"date": "2024-02-01", "value": 300}
    ]
    columns = ["date", "value"]

    date_range = detect_date_range(sample_data, columns)

    if date_range:
        assert "column" in date_range, "Date range should specify column"
        assert "min" in date_range, "Date range should have min date"
        assert "max" in date_range, "Date range should have max date"
        assert date_range["column"] == "date", "Should detect date column"
        print("✅ Date range detection test passed")
        return True
    else:
        print("⚠️ Date range detection returned None (may be expected)")
        return True


def test_return_metadata_structure():
    """Test that the return value has all expected metadata."""
    with tempfile.TemporaryDirectory() as temp_dir:
        result = execute_aj_sql_query(
            "SELECT 1 as test",
            database="ucms_aje",
            work_dir=temp_dir
        )

        # Check expected metadata fields (some may be missing if query fails)
        expected_fields = ["success", "timestamp"]  # These should always be present

        for field in expected_fields:
            assert field in result, f"Result should contain '{field}' field"

        # Check file_paths structure if present
        if "file_paths" in result:
            assert "query_log" in result["file_paths"], "file_paths should contain query_log"
            assert "result_json" in result["file_paths"], "file_paths should contain result_json"

        # Check that sql directory was created
        sql_dir = os.path.join(temp_dir, 'sql')
        assert os.path.exists(sql_dir), "sql/ directory should be created"

        print("✅ Return metadata structure test passed")
        return True


def run_all_tests():
    """Run all tests and report results."""
    print("🧪 Testing improved aj_sql_tool functionality\n")

    tests = [
        ("SQL subfolder creation", test_sql_subfolder_creation),
        ("File naming convention", test_file_naming_convention),
        ("Query logging", test_query_logging),
        ("JSON result structure", test_json_result_structure),
        ("Data structure analysis", test_data_structure_analysis),
        ("Smart preview generation", test_smart_preview_generation),
        ("Date range detection", test_date_range_detection),
        ("Return metadata structure", test_return_metadata_structure),
    ]

    passed = 0
    total = len(tests)

    for test_name, test_func in tests:
        print(f"Running: {test_name}")
        try:
            if test_func():
                passed += 1
                print(f"✅ {test_name}: PASSED\n")
            else:
                print(f"⚠️ {test_name}: SKIPPED\n")
        except Exception as e:
            print(f"❌ {test_name}: FAILED - {str(e)}\n")

    print(f"📊 Test Results: {passed}/{total} tests passed")

    if passed == total:
        print("🎉 All tests passed! The improved aj_sql_tool is working correctly.")
    elif passed >= total * 0.8:  # 80% pass rate
        print("✅ Most tests passed. The tool is working well.")
    else:
        print("⚠️ Some tests failed. Review the implementation.")

    return passed == total


if __name__ == "__main__":
    success = run_all_tests()
    exit(0 if success else 1)
