"""
Docker log collector for test orchestration.

Streams Docker container logs and parses them into structured format.
"""

import asyncio
import re
import logging
from datetime import datetime
from typing import List, Dict, Optional
from collections import Counter

logger = logging.getLogger(__name__)


class LogCollector:
    """Streams and parses Docker container logs."""

    def __init__(self, container_name: str = "cortex-autogen-function"):
        """
        Initialize the log collector.

        Args:
            container_name: Name of the Docker container to collect logs from
        """
        self.container_name = container_name
        self.logs: List[Dict] = []
        self.is_collecting = False
        self.process: Optional[asyncio.subprocess.Process] = None

    async def start_collecting(
        self,
        request_id: Optional[str] = None,
        timeout: int = 300,
        filter_levels: Optional[List[str]] = None
    ) -> List[Dict]:
        """
        Start collecting Docker logs.

        Args:
            request_id: Optional request ID to filter logs for
            timeout: Maximum time to collect in seconds
            filter_levels: Optional list of log levels to collect (e.g., ['ERROR', 'WARNING'])

        Returns:
            List of parsed log entries
        """
        self.logs = []
        self.is_collecting = True

        try:
            # Start docker logs process
            self.process = await asyncio.create_subprocess_exec(
                'docker', 'logs', '-f', '--tail=0', self.container_name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            logger.info(f"📝 Log collector started for container: {self.container_name}")
            if request_id:
                logger.info(f"   Filtering for request ID: {request_id}")
            if filter_levels:
                logger.info(f"   Filtering levels: {', '.join(filter_levels)}")

            # Read logs from both stdout and stderr
            async def read_stream(stream, stream_name):
                while self.is_collecting:
                    line = await stream.readline()
                    if not line:
                        break

                    try:
                        line_str = line.decode('utf-8').strip()
                        if not line_str:
                            continue

                        # Parse the log line
                        log_entry = self._parse_log_line(line_str)

                        if log_entry:
                            # Apply filters
                            if request_id and request_id not in line_str:
                                continue

                            if filter_levels and log_entry.get('level') not in filter_levels:
                                continue

                            self.logs.append(log_entry)

                    except Exception as e:
                        logger.debug(f"Error parsing log line: {e}")
                        continue

            # Collect logs with timeout
            try:
                await asyncio.wait_for(
                    asyncio.gather(
                        read_stream(self.process.stdout, 'stdout'),
                        read_stream(self.process.stderr, 'stderr')
                    ),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                logger.info(f"⏱️  Log collection timeout after {timeout}s")

        except Exception as e:
            logger.error(f"❌ Log collection error: {e}", exc_info=True)
        finally:
            await self.stop_collecting()

        logger.info(f"📊 Log collection completed: {len(self.logs)} log entries collected")
        return self.logs

    async def stop_collecting(self):
        """Stop collecting logs and cleanup."""
        self.is_collecting = False

        if self.process:
            try:
                self.process.kill()
                await self.process.wait()
            except Exception as e:
                logger.debug(f"Error stopping log collection process: {e}")
            finally:
                self.process = None

        logger.info("🛑 Log collection stopped")

    def _parse_log_line(self, line: str) -> Optional[Dict]:
        """
        Parse a log line into structured format.

        Supports multiple log formats:
        - Standard format: "2024-10-25 12:34:56 - INFO - [agent_name] Message"
        - Python format: "2024-10-25 12:34:56,123 - module - INFO - Message"
        - Simple format: "INFO: Message"

        Args:
            line: Log line string

        Returns:
            Parsed log entry dict or None if parsing fails
        """
        # Try standard format first: "YYYY-MM-DD HH:MM:SS - LEVEL - [agent] Message"
        pattern1 = r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})[,\s-]+([A-Z]+)\s*-?\s*\[?([^\]]*)\]?\s*[-:]?\s*(.*)'
        match = re.search(pattern1, line)

        if match:
            timestamp_str = match.group(1)
            level = match.group(2).strip()
            agent = match.group(3).strip() if match.group(3) else None
            message = match.group(4).strip()

            try:
                timestamp = datetime.strptime(timestamp_str, '%Y-%m-%d %H:%M:%S')
            except:
                timestamp = datetime.now()

            return {
                'timestamp': timestamp.isoformat(),
                'level': level,
                'agent': agent if agent else None,
                'message': message,
                'raw': line
            }

        # Try simple level format: "LEVEL: Message" or "LEVEL - Message"
        pattern2 = r'^([A-Z]+)[\s:-]+(.+)$'
        match = re.search(pattern2, line)

        if match:
            return {
                'timestamp': datetime.now().isoformat(),
                'level': match.group(1).strip(),
                'agent': None,
                'message': match.group(2).strip(),
                'raw': line
            }

        # If no pattern matches, store as unparsed
        return {
            'timestamp': datetime.now().isoformat(),
            'level': 'UNKNOWN',
            'agent': None,
            'message': line,
            'raw': line
        }

    def get_logs(
        self,
        level: Optional[str] = None,
        agent: Optional[str] = None
    ) -> List[Dict]:
        """
        Get collected logs with optional filtering.

        Args:
            level: Filter by log level
            agent: Filter by agent name

        Returns:
            Filtered list of log entries
        """
        filtered = self.logs

        if level:
            filtered = [log for log in filtered if log.get('level') == level]

        if agent:
            filtered = [log for log in filtered if log.get('agent') == agent]

        return filtered

    def get_summary(self) -> Dict:
        """
        Get a summary of collected logs.

        Returns:
            Dictionary with log statistics
        """
        if not self.logs:
            return {
                'total_logs': 0,
                'by_level': {},
                'by_agent': {},
                'errors': 0,
                'warnings': 0
            }

        level_counts = Counter(log.get('level', 'UNKNOWN') for log in self.logs)
        agent_counts = Counter(log.get('agent', 'unknown') for log in self.logs if log.get('agent'))

        return {
            'total_logs': len(self.logs),
            'by_level': dict(level_counts),
            'by_agent': dict(agent_counts),
            'errors': level_counts.get('ERROR', 0),
            'warnings': level_counts.get('WARNING', 0) + level_counts.get('WARN', 0),
            'first_log': self.logs[0]['timestamp'] if self.logs else None,
            'last_log': self.logs[-1]['timestamp'] if self.logs else None
        }

    def get_errors(self) -> List[Dict]:
        """Get all ERROR level logs."""
        return self.get_logs(level='ERROR')

    def get_warnings(self) -> List[Dict]:
        """Get all WARNING level logs."""
        warnings = self.get_logs(level='WARNING')
        warnings.extend(self.get_logs(level='WARN'))
        return warnings
