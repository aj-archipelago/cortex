"""
Progress update collector for test orchestration.

Subscribes to Redis pub/sub channel and collects progress updates
during test execution.
"""

import redis
import json
import asyncio
import logging
from datetime import datetime
from typing import List, Dict, Optional
from collections import defaultdict

logger = logging.getLogger(__name__)


class ProgressCollector:
    """Collects progress updates from Redis pub/sub channel."""

    def __init__(self, redis_url: str, channel: str):
        """
        Initialize the progress collector.

        Args:
            redis_url: Redis connection string (e.g., "redis://localhost:6379")
            channel: Redis channel name to subscribe to
        """
        self.redis_url = redis_url
        self.channel = channel
        self.updates: List[Dict] = []
        self.is_collecting = False
        self.final_result = None

    async def start_collecting(
        self,
        request_id: str,
        timeout: int = 300,
        stop_on_final: bool = True
    ) -> List[Dict]:
        """
        Start collecting progress updates for a specific request.

        Args:
            request_id: The request ID to filter updates for
            timeout: Maximum time to collect in seconds
            stop_on_final: Stop collecting when final update (progress=1.0 or data field) is received

        Returns:
            List of progress updates collected
        """
        self.updates = []
        self.is_collecting = True
        self.final_result = None

        try:
            # Create Redis client in executor to avoid blocking
            redis_client = redis.from_url(self.redis_url)
            pubsub = redis_client.pubsub()
            pubsub.subscribe(self.channel)

            logger.info(f"📡 Progress collector started for request {request_id}")
            logger.info(f"   Subscribed to channel: {self.channel}")
            logger.info(f"   Timeout: {timeout}s")

            start_time = datetime.now()
            message_count = 0

            # Listen for messages with timeout
            for message in pubsub.listen():
                if not self.is_collecting:
                    break

                if message['type'] == 'message':
                    try:
                        data = json.loads(message['data'])

                        # Only collect updates for our request
                        if data.get('requestId') == request_id:
                            message_count += 1

                            update = {
                                'timestamp': datetime.now().isoformat(),
                                'progress': data.get('progress', 0.0),
                                'info': data.get('info', ''),
                                'data': data.get('data')
                            }

                            self.updates.append(update)

                            # Log progress update
                            progress_pct = int(update['progress'] * 100)
                            logger.info(f"   Progress: {progress_pct}% - {update['info']}")

                            # Check if this is the final update
                            if stop_on_final:
                                if update['data'] is not None:
                                    self.final_result = update['data']
                                    logger.info(f"✅ Final result received (with data field)")
                                    break
                                elif update['progress'] >= 1.0:
                                    logger.info(f"✅ Final progress reached (100%)")
                                    # Wait a bit more to catch any late final result
                                    await asyncio.sleep(2)
                                    break

                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to parse message: {e}")
                        continue
                    except Exception as e:
                        logger.error(f"Error processing message: {e}")
                        continue

                # Check timeout
                elapsed = (datetime.now() - start_time).total_seconds()
                if elapsed > timeout:
                    logger.warning(f"⏱️  Progress collection timeout after {timeout}s")
                    break

            # Cleanup
            pubsub.unsubscribe()
            pubsub.close()
            redis_client.close()

            logger.info(f"📊 Progress collection completed: {message_count} updates collected")

        except redis.ConnectionError as e:
            logger.error(f"❌ Redis connection error: {e}")
        except Exception as e:
            logger.error(f"❌ Progress collection error: {e}", exc_info=True)
        finally:
            self.is_collecting = False

        return self.updates

    def stop_collecting(self):
        """Stop collecting progress updates."""
        self.is_collecting = False
        logger.info("🛑 Progress collection stopped manually")

    def get_updates(self) -> List[Dict]:
        """Get all collected updates."""
        return self.updates

    def get_final_result(self) -> Optional[Dict]:
        """Get the final result data if received."""
        return self.final_result

    def get_summary(self) -> Dict:
        """
        Get a summary of collected progress updates.

        Returns:
            Dictionary with statistics about the updates
        """
        if not self.updates:
            return {
                'total_updates': 0,
                'duration_seconds': 0,
                'avg_interval_seconds': 0,
                'final_progress': 0
            }

        timestamps = [datetime.fromisoformat(u['timestamp']) for u in self.updates]
        intervals = []

        for i in range(1, len(timestamps)):
            interval = (timestamps[i] - timestamps[i-1]).total_seconds()
            intervals.append(interval)

        duration = (timestamps[-1] - timestamps[0]).total_seconds() if len(timestamps) > 1 else 0

        return {
            'total_updates': len(self.updates),
            'duration_seconds': duration,
            'avg_interval_seconds': sum(intervals) / len(intervals) if intervals else 0,
            'min_interval_seconds': min(intervals) if intervals else 0,
            'max_interval_seconds': max(intervals) if intervals else 0,
            'final_progress': self.updates[-1]['progress'] if self.updates else 0,
            'has_final_result': self.final_result is not None
        }
