"""
Pytest configuration file.

This file can be used for pytest-based testing in the future.
For now, use the CLI runner: python tests/cli/run_tests.py
"""

import pytest
import logging

# Configure logging for tests
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
