import redis
import json
import logging
import asyncio
import time
from typing import Dict, Any, Optional, List

import os

logger = logging.getLogger(__name__)

# Global Redis client - persistent connection like the working version
redis_client = None

def connect_redis() -> bool:
    """Check and ensure Redis connection is active - matches working version pattern"""
    global redis_client
    
    redis_conn_string = os.getenv("REDIS_CONNECTION_STRING")

    # Initialize client if not exists
    if redis_client is None:
        try:
            redis_client = redis.from_url(redis_conn_string)
        except Exception as e:
            logger.warning(f"Failed to create Redis client: {e}")
            return False
    
    # Test connection
    try:
        redis_client.ping()
        return True
    except redis.ConnectionError as e:
        logger.warning(f"Redis connection error: {e}")
        try:
            # Try to reconnect
            redis_client = redis.from_url(redis_conn_string)
            redis_client.ping()
            return True
        except Exception as reconnect_error:
            logger.error(f"Error reconnecting to Redis: {reconnect_error}")
            return False
    except Exception as e:
        logger.warning(f"Redis ping failed: {e}")
        # Handle the case where client is closed
        if "Client must be connected" in str(e) or "closed" in str(e).lower():
            logger.info("Redis client was closed, attempting to create new connection...")
            try:
                redis_client = redis.from_url(redis_conn_string)
                redis_client.ping()
                return True
            except Exception as reconnect_error:
                logger.error(f"Error creating new Redis connection: {reconnect_error}")
                return False
        return False

_last_logged_progress: Dict[str, Any] = {}

def publish_request_progress(data: Dict[str, Any]) -> bool:
    """Publish progress data to Redis channel with minimal logging (only when message changes)."""
    if connect_redis():
        try:
            message = json.dumps(data)
            result = redis_client.publish(os.getenv("REDIS_CHANNEL"), message)
            try:
                rid = data.get('requestId')
                info = data.get('info')
                pct = data.get('progress')
                prev = _last_logged_progress.get(rid)
                # Log only if info or integer progress changed
                pct_bucket = None
                try:
                    pct_bucket = int(float(pct) * 100)
                except Exception:
                    pct_bucket = None
                if not prev or prev.get('info') != info or prev.get('pct_bucket') != pct_bucket:
                    _last_logged_progress[rid] = {'info': info, 'pct_bucket': pct_bucket}
                    logger.info(f"Published progress update for request {rid}: progress={pct}, subscribers={result}")
            except Exception:
                # Safe fallback if logging diff fails
                logger.debug("Progress publish logged without diff due to exception")
            return True
        except Exception as e:
            logger.error(f"Error publishing message to Redis: {e}")
            return False
    else:
        logger.error(f"Redis not connected, failed to publish progress update for request {data.get('requestId')}")
        return False

class RedisPublisher:
    """Wrapper class for compatibility with existing code"""
    
    def __init__(self):
        self.connected = False
        # Heartbeat + transient caching
        self._heartbeat_task: Optional[asyncio.Task] = None
        try:
            # Clamp to at most 1.0s to ensure the UI gets updates every second
            interval = float(os.getenv("PROGRESS_HEARTBEAT_INTERVAL", "1.0"))
            if interval > 1.0:
                interval = 1.0
            if interval <= 0:
                interval = 1.0
            self._interval_seconds = interval
        except Exception:
            self._interval_seconds = 1.0
        # We cache only summarized progress strings (emoji sentence) with progress float
        self._transient_latest: Dict[str, Dict[str, Any]] = {}
        self._transient_all: Dict[str, List[Dict[str, Any]]] = {}
        self._finalized: Dict[str, bool] = {}
        self._lock = asyncio.Lock()
        
    async def connect(self):
        """Initialize Redis connection"""
        self.connected = connect_redis()
        if self.connected:
            logger.info("Connected to Redis successfully")
        else:
            logger.warning("Failed to connect to Redis")
            logger.warning("Redis progress publishing will be disabled")
        # Start heartbeat loop once per process
        if self._heartbeat_task is None:
            try:
                self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
                logger.info("Started Redis progress heartbeat task")
            except Exception as e:
                logger.warning(f"Failed to start heartbeat task: {e}")
    
    def publish_request_progress(self, data: Dict[str, Any]) -> bool:
        """Publish progress data to Redis channel"""
        return publish_request_progress(data)
    
    async def publish_progress(self, request_id: str, progress: float, info: str = "", data: str = None) -> bool:
        """Publish progress update for a specific request - async version"""
        message_data = {
            "requestId": request_id,
            "progress": progress,
            "info": info
        }
        
        # Add data field for final results
        if data is not None:
            message_data["data"] = data
            
        return self.publish_request_progress(message_data)

    async def set_transient_update(self, request_id: str, progress: float, info: str) -> None:
        """Cache the latest summarized transient progress (short sentence with emoji).
        Heartbeat will re-publish this every second until final. No raw chat content here."""
        try:
            async with self._lock:
                # Skip if already finalized
                if self._finalized.get(request_id):
                    return
                self._transient_latest[request_id] = {"progress": progress, "info": info, "ts": time.time()}
                lst = self._transient_all.get(request_id)
                if lst is None:
                    lst = []
                    self._transient_all[request_id] = lst
                lst.append({"progress": progress, "info": info, "ts": time.time()})
                # Avoid unbounded growth
                if len(lst) > 200:
                    del lst[: len(lst) - 200]
        except Exception as e:
            logger.warning(f"set_transient_update error for {request_id}: {e}")

    async def mark_final(self, request_id: str) -> None:
        """Mark a request as finalized to stop transient heartbeat for it."""
        try:
            async with self._lock:
                self._finalized[request_id] = True
                # Optionally clear cached transient
                if request_id in self._transient_latest:
                    del self._transient_latest[request_id]
        except Exception as e:
            logger.warning(f"mark_final error for {request_id}: {e}")

    async def _heartbeat_loop(self):
        """Background loop that emits latest transient updates every interval."""
        try:
            while True:
                try:
                    # Snapshot under lock
                    async with self._lock:
                        items = [
                            (rid, payload)
                            for rid, payload in self._transient_latest.items()
                            if not self._finalized.get(rid)
                        ]
                    if items:
                        for rid, payload in items:
                            try:
                                message_data = {
                                    "requestId": rid,
                                    "progress": float(payload.get("progress", 0.0)),
                                    "info": str(payload.get("info", ""))
                                }
                                self.publish_request_progress(message_data)
                            except Exception as pub_err:
                                logger.debug(f"Heartbeat publish error for {rid}: {pub_err}")
                except Exception as loop_err:
                    logger.debug(f"Heartbeat loop iteration error: {loop_err}")
                await asyncio.sleep(self._interval_seconds)
        except asyncio.CancelledError:
            logger.info("Redis progress heartbeat task cancelled")
        except Exception as e:
            logger.warning(f"Heartbeat loop terminated unexpectedly: {e}")
    
    def store_final_result(self, request_id: str, result_data: Dict[str, Any], expiry_seconds: int = 3600) -> bool:
        """Store final result in Redis key for retrieval"""
        if connect_redis():
            try:
                # Store in multiple keys for compatibility
                keys_to_store = [
                    f"result:{request_id}",
                    f"final:{request_id}",
                    f"progress:{request_id}"  # Also store in progress key for consistency
                ]
                
                message = json.dumps(result_data)
                
                for key in keys_to_store:
                    redis_client.set(key, message, ex=expiry_seconds)
                
                logger.info(f"Stored final result for request {request_id} in {len(keys_to_store)} Redis keys")
                return True
                
            except Exception as e:
                logger.error(f"Error storing final result: {e}")
                return False
        else:
            logger.debug(f"Redis not connected, skipping final result storage for request {request_id}")
            return False
    
    async def close(self):
        """Close Redis connection gracefully"""
        global redis_client
        # Stop heartbeat
        if self._heartbeat_task is not None:
            try:
                self._heartbeat_task.cancel()
                try:
                    await self._heartbeat_task
                except asyncio.CancelledError:
                    pass
            except Exception as e:
                logger.debug(f"Error cancelling heartbeat task: {e}")
            finally:
                self._heartbeat_task = None
        if redis_client:
            try:
                # Don't actually close the connection in non-continuous mode
                # Just mark it as disconnected so it can be recreated if needed
                logger.info("Redis connection marked for cleanup")
                # Only close if we're in continuous mode or shutting down completely
                # redis_client.close()  # Comment out to prevent premature closure
                # redis_client = None
            except Exception as e:
                logger.warning(f"Error during Redis connection cleanup: {e}")
        self.connected = False

# Global instance
_redis_publisher: Optional[RedisPublisher] = None

async def get_redis_publisher() -> RedisPublisher:
    """Get or create Redis publisher instance"""
    global _redis_publisher
    if _redis_publisher is None:
        _redis_publisher = RedisPublisher()
        await _redis_publisher.connect()
    else:
        # Ensure connectivity and heartbeat are active for new tasks
        try:
            if (not getattr(_redis_publisher, 'connected', False)) or getattr(_redis_publisher, '_heartbeat_task', None) is None:
                await _redis_publisher.connect()
        except Exception:
            # Best-effort reconnect
            await _redis_publisher.connect()
    return _redis_publisher 