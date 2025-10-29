"""
Connectivity checkers for external services.
"""

import os
import logging
from typing import Tuple

logger = logging.getLogger(__name__)


def check_ajsql_connectivity() -> Tuple[bool, str]:
    """
    Check if AJ SQL database is accessible from current IP.

    Returns:
        Tuple of (is_accessible, message)
    """
    mysql_url = os.getenv("AJ_MYSQL_URL")

    if not mysql_url:
        return False, "AJ_MYSQL_URL environment variable not set"

    try:
        import pymysql
        from urllib.parse import unquote
    except ImportError:
        return False, "pymysql library not installed"

    try:
        # Parse MySQL URL
        # Format: mysql://user:password@host:port/database or mysql+pymysql://...
        if mysql_url.startswith("mysql+pymysql://"):
            url_parts = mysql_url[16:]  # Remove mysql+pymysql://
        elif mysql_url.startswith("mysql://"):
            url_parts = mysql_url[8:]  # Remove mysql://
        else:
            return False, "Invalid AJ_MYSQL_URL format (must start with mysql:// or mysql+pymysql://)"

        # Split user:password@host:port/database
        if "@" in url_parts:
            auth_part, host_part = url_parts.split("@", 1)
            user, password = auth_part.split(":", 1) if ":" in auth_part else (auth_part, "")
            # URL-decode username and password (handles special characters like @ encoded as %40)
            user = unquote(user)
            password = unquote(password)
        else:
            return False, "Invalid AJ_MYSQL_URL format (missing credentials)"

        # Split host:port/database (database is optional)
        if "/" in host_part:
            host_port, database = host_part.split("/", 1)
            # Database can be empty (for multi-database access)
            if not database:
                database = None
        else:
            host_port = host_part
            database = None

        # Split host:port
        if ":" in host_port:
            host, port = host_port.rsplit(":", 1)
            port = int(port)
        else:
            host = host_port
            port = 3306

        # Try to connect with a short timeout
        logger.info(f"Testing AJ SQL connectivity to {host}:{port}")

        # Build connection params
        connect_params = {
            'host': host,
            'port': port,
            'user': user,
            'password': password,
            'connect_timeout': 5,
            'read_timeout': 5,
            'write_timeout': 5,
            'ssl': {'ssl': True}
        }

        # Only include database if specified
        if database:
            connect_params['database'] = database

        connection = pymysql.connect(**connect_params)

        # Run a simple query to verify access
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()

        connection.close()

        logger.info(f"✅ AJ SQL database is accessible")
        return True, "Database is accessible"

    except pymysql.err.OperationalError as e:
        error_msg = str(e)
        if "Access denied" in error_msg:
            logger.warning(f"⚠️ AJ SQL access denied: {error_msg}")
            return False, f"Access denied: {error_msg}"
        elif "Can't connect" in error_msg or "timed out" in error_msg:
            logger.warning(f"⚠️ AJ SQL connection failed (IP restriction?): {error_msg}")
            return False, f"Connection failed (likely IP restriction): {error_msg}"
        else:
            logger.warning(f"⚠️ AJ SQL operational error: {error_msg}")
            return False, f"Database error: {error_msg}"
    except Exception as e:
        logger.warning(f"⚠️ AJ SQL connectivity check failed: {e}")
        return False, f"Unexpected error: {str(e)}"
