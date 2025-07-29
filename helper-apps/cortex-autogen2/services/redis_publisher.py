import redis
import json
import logging
from typing import Dict, Any, Optional

import os  # Added for environment variables

logger = logging.getLogger(__name__)

# Global Redis client - persistent connection like the working version
redis_client = None

def connect_redis() -> bool:
    """Check and ensure Redis connection is active - matches working version pattern"""
    global redis_client
    
    # Initialize client if not exists
    if redis_client is None:
        try:
            redis_client = redis.from_url(os.getenv("REDIS_CONNECTION_STRING"))
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
            redis_client = redis.from_url(os.getenv("REDIS_CONNECTION_STRING"))
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
                redis_client = redis.from_url(os.getenv("REDIS_CONNECTION_STRING"))
                redis_client.ping()
                return True
            except Exception as reconnect_error:
                logger.error(f"Error creating new Redis connection: {reconnect_error}")
                return False
        return False

def publish_request_progress(data: Dict[str, Any]) -> bool:
    """Publish progress data to Redis channel - matches working version pattern"""
    if connect_redis():
        try:
            message = json.dumps(data)
            result = redis_client.publish(os.getenv("REDIS_CHANNEL"), message)
            logger.info(f"Published progress update for request {data.get('requestId')}: progress={data.get('progress')}, subscribers={result}")
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
        
    async def connect(self):
        """Initialize Redis connection"""
        self.connected = connect_redis()
        if self.connected:
            logger.info("Connected to Redis successfully")
        else:
            logger.warning("Failed to connect to Redis")
            logger.warning("Redis progress publishing will be disabled")
    
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
    return _redis_publisher 