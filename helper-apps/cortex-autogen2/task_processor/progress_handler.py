"""
Progress handling and summarization for task processing.
"""
import asyncio
import time
import logging
from typing import Dict, List, Optional, Any
from services.azure_ai_search import search_similar_rest, upsert_run_rest
from services.run_analyzer import (
    collect_run_metrics,
    extract_errors,
    redact,
    summarize_learnings,
    build_run_document,
)

logger = logging.getLogger(__name__)



class ProgressHandler:

    def __init__(self, redis_publisher, model_client):
        self.redis_publisher = redis_publisher
        self.model_client = model_client
        self._progress_queue: Optional[asyncio.Queue] = None
        self._progress_worker_task: Optional[asyncio.Task] = None
        self._progress_lock = asyncio.Lock()
        self._max_progress_by_request: Dict[str, float] = {}
        self._last_summary_by_request: Dict[str, str] = {}
        self._last_progress_time_by_request: Dict[str, float] = {}
        self._heartbeat_tasks: Dict[str, asyncio.Task] = {}
        self._heartbeat_lock = asyncio.Lock()
        self._message_count_by_request: Dict[str, int] = {}  # Track message count for auto-increment
        self._last_sent_by_request: Dict[str, str] = {}  # Track last sent content per request
        self._last_sent_time_by_request: Dict[str, float] = {}  # Track last sent time per request
        self._last_message_content: Dict[str, str] = {}  # Track last message content per request
        self._last_message_percentage: Dict[str, float] = {}  # Track last message percentage per request

        # Heartbeat state management - tracks last message and percentage for auto-repeat
        self._heartbeat_state: Dict[str, Dict[str, Any]] = {}
        # {task_id: {
        #    'last_message': str,
        #    'last_percentage': float,
        #    'last_update_time': float,
        #    'heartbeat_task': asyncio.Task,
        #    'llm_counter': int  # Counts up to for LLM updates
        # }}

        # LLM call throttling (5+ second intervals to reduce costs)
        self._last_llm_call_time_by_request: Dict[str, float] = {}
        self._cached_llm_message_by_request: Dict[str, str] = {}
        self._has_cached_message_by_request: Dict[str, bool] = {}  # Track if we've cached a message for this request

        # Emoji tracking
        self.used_emojis = set()
        self.used_emojis_by_request = {}
        
        # Track published messages to prevent published duplicates
        self._last_published_messages = set()

    def log_internal_progress(self, task_id: str, message: str, source: str = None):
        """Log detailed internal progress for debugging/audit."""
        logger.info(f"🔍 INTERNAL PROGRESS [{task_id}] ({source}): {message}")

    async def report_user_progress(self, task_id: str, message: str, percentage: float = None, source: str = None):
        """Report clean, user-facing progress update."""
        # Use existing logic to summarize/sanitize
        user_msg = await self.summarize_progress(message, source=source, task_id=task_id)
        if user_msg:
            # percentage=0.0 triggers auto-increment logic in handle_progress_update
            return await self.handle_progress_update(task_id, percentage if percentage is not None else 0.0, user_msg)
        return 0.0

    async def _ensure_progress_worker(self) -> None:
        """Progress worker disabled - using direct publishing instead."""
        # Cancel any existing background worker since we now publish directly
        if self._progress_worker_task and not self._progress_worker_task.done():
            self._progress_worker_task.cancel()
            try:
                await self._progress_worker_task
            except asyncio.CancelledError:
                pass
            logger.info("✅ Cancelled old progress worker")
        # Background worker disabled since we now publish directly
        pass

    async def _progress_worker_loop(self) -> None:
        """Continuously consume progress events, summarize, and publish updates."""
        try:
            while True:
                try:
                    # Get next progress event
                    event = await self._progress_queue.get()
                    req_id = event.get("task_id")
                    pct = event.get("percentage", 0.0)
                    content = event.get("content", "")
                    msg_type = event.get("message_type")
                    source = event.get("source")
                    data = event.get("data")

                    # Summarize and publish (with rate limiting)
                    logger.info(f"⚙️ Worker processing event: pct={pct}, content='{content}', source={source}")
                    summary = await self.summarize_progress(content, msg_type, source, None, task_id=req_id)
                    logger.info(f"⚙️ Worker summary result: '{summary}'")
                    if summary:
                        import time
                        current_time = time.time()
                        last_time = self._last_progress_time_by_request.get(req_id, 0)
                        last_summary = self._last_summary_by_request.get(req_id)

                        # Rate limit: same message max once per second
                        if last_summary != summary or current_time - last_time > 1.0:
                            self._last_summary_by_request[req_id] = summary
                            self._last_progress_time_by_request[req_id] = current_time
                            # Publish progress update to Redis
                            await self.redis_publisher.set_transient_update(req_id, pct, summary, data)
                            logger.info(f"📡 Published progress update: {pct:.0%} - {summary}")
                    self._progress_queue.task_done()
                except Exception as loop_err:
                    logger.debug(f"Progress worker loop error: {loop_err}")
        except asyncio.CancelledError:
            logger.info("Progress worker task cancelled")
        except Exception as e:
            logger.warning(f"Progress worker terminated unexpectedly: {e}")

    async def summarize_progress(self, content: str, message_type: str = None, source: str = None, model_client=None, task_id: str = None) -> str:
        """Summarize progress content for display with intelligent filtering."""
        # Normalize content to string if it's a list
        if isinstance(content, list):
            content = str(content[0]) if content else ""
        
        if not content:
            return ""

        # Skip internal messages
        if self._should_skip_progress_update(content, message_type, source):
            return ""

        # Clean content for summarization
        cleaned = self._clean_content_for_progress(content, message_type, source)

        # Use LLM to generate dynamic progress message
        return await self._get_dynamic_progress_message(source or "", cleaned, request_id=task_id)

    def _should_skip_progress_update(self, content: str, message_type: str = None, source: str = None) -> bool:
        """Determine if a progress update should be skipped (minimal filtering)."""
        # Normalize content to string if it's a list
        if isinstance(content, list):
            content = str(content[0]) if content else ""
        
        if not content:
            return True

        # Only skip very short messages or internal system sources
        if len(content.strip()) < 3:
            return True

        if source in ["system", "internal"]:
            return True

        return False

    def _clean_content_for_progress(self, content: str, message_type: str = None, source: str = None) -> str:
        """Clean and prepare content for progress summarization."""
        # Normalize content to string if it's a list
        if isinstance(content, list):
            content = str(content[0]) if content else ""
        
        if not content:
            return ""

        # Remove common prefixes/suffixes
        content = content.strip()
        content = content.replace("📊", "").replace("💻", "").replace("🚀", "").strip()

        # Limit length
        if len(content) > 200:
            content = content[:200] + "..."

        return content

    async def _get_dynamic_progress_message(self, source: str, content: str, task_context: str = "", request_id: str = None) -> str:
        """Use LLM to generate dynamic, contextual progress messages."""
        if not content or not content.strip():
            return content

        # LLM call throttling: reuse cached message if called recently (< X seconds ago)
        import time
        current_time = time.time()
        last_llm_time = self._last_llm_call_time_by_request.get(request_id, 0)

        if current_time - last_llm_time < 10.0:
            # Return cached message if available and recent
            cached_msg = self._cached_llm_message_by_request.get(request_id)
            if cached_msg:
                logger.debug(f"🤖 Using cached LLM message (throttled): '{cached_msg[:50]}...'")
                return cached_msg

        # Build list of recently used emojis to avoid - last 3 emojis per request
        avoid_emojis = ""
        if request_id:
            request_emojis = self.used_emojis_by_request.get(request_id, [])
            if request_emojis:
                recent_emojis = request_emojis[-3:]  # Last 3 used emojis for this request
                avoid_emojis = f"\n\nFORBIDDEN EMOJIS (do NOT use these recently used ones for this task): {', '.join(recent_emojis)}"
        elif self.used_emojis:
            recent_emojis = list(self.used_emojis)[-10:]  # Fallback to global tracking
            avoid_emojis = f"\n\nFORBIDDEN EMOJIS (do NOT use these recently used ones): {', '.join(recent_emojis)}"

        prompt = f"""Transform this raw system message into a high-impact, engaging, and slightly witty progress update.

RAW MESSAGE: "{content}"
SOURCE AGENT: {source}
TASK CONTEXT: {task_context}{avoid_emojis}

CRITICAL RULES:
1. **TONE**: Professional but cool. Think "Mission Impossible" meets "Data Scientist". High-tech, active, and confident.
2. **FILTER ERRORS**: If the message implies failure or error, spin it as "Optimizing" or "Refining". NEVER show errors.
3. **FILTER JARGON**: No internal paths, no code blocks, NO AGENT NAMES (aj_sql_agent, coder_agent, etc.). Translate "SQL query" to "Mining data vaults".
4. **BE CONCISE**: Exactly 5-7 words.
5. **START WITH EMOJI**: Use ONE unique, POSITIVE emoji. FORBIDDEN EMOJIS: 🚨, ⚠️, ❌, ⛔, 🛑, 🚀 (reserved for start).
6. **FORBIDDEN PHRASES**: NEVER say "Still processing", "Working on it", or "Please wait". NEVER mention internal agent names.
7. **ENGAGEMENT**: Use powerful verbs: Orchestrating, Synthesizing, Crunching, Deploying, Mining.
8. **NO USER VALUE**: If the message is purely technical/internal with no value to the user (e.g., "file created", "tool call", "ready for upload"), return exactly: SKIP

EXAMPLES:
- Raw: "Select * from ucms_aje" -> "🕵️‍♂️ Mining the data archives"
- Raw: "Generating chart.png" -> "🎨 Visualizing your data story"
- Raw: "Active: Processing..." -> "🔄 Orchestrating complex workflows"
- Raw: "Error in connection, retrying" -> "🛠️ Tuning system performance"
- Raw: "Deploying aj_sql_agent" -> "🚀 Deploying intelligent data systems"
- Raw: "File created: report.csv" -> "SKIP"
- Raw: "Tool call completed" -> "SKIP"

Return ONLY the progress message (5-7 words) OR the word SKIP:"""

        try:
            logger.info(f"🤖 Generating dynamic progress for: '{content}'")
            response = await self._call_llm(prompt)
            dynamic_message = response.strip()
            
            # Handle potential list response
            if isinstance(dynamic_message, list):
                dynamic_message = str(dynamic_message[0]) if dynamic_message else ""
            
            # Check if LLM says to skip
            if dynamic_message.strip().upper() == "SKIP":
                logger.info(f"🤖 LLM decided to SKIP: '{content}'")
                return ""
            
            logger.info(f"🤖 LLM response: '{dynamic_message}'")

            word_count = len(dynamic_message.split())

            # Validate the response
            if self._is_valid_progress_message(dynamic_message, word_count):
                # Track used emoji for variety
                emoji = dynamic_message[0] if dynamic_message else ""

                # Track globally
                self.used_emojis.add(emoji)
                if len(self.used_emojis) > 15:  # Reset after 15 different emojis to keep memory fresh
                    last_three = list(self.used_emojis)[-3:]
                    self.used_emojis.clear()
                    self.used_emojis.update(last_three)

                # Track per request (keep last 3 used emojis)
                if request_id:
                    if request_id not in self.used_emojis_by_request:
                        self.used_emojis_by_request[request_id] = []
                    self.used_emojis_by_request[request_id].append(emoji)
                    if len(self.used_emojis_by_request[request_id]) > 3:
                        self.used_emojis_by_request[request_id] = self.used_emojis_by_request[request_id][-3:]

                # Cache the successful LLM response for throttling
                if request_id:
                    # Don't cache the first message for each request (static starting message)
                    if not self._has_cached_message_by_request.get(request_id, False):
                        self._has_cached_message_by_request[request_id] = True
                        logger.debug(f"🤖 Skipped caching first message for request {request_id}")
                    else:
                        self._last_llm_call_time_by_request[request_id] = current_time
                        self._cached_llm_message_by_request[request_id] = dynamic_message

                logger.info(f"🤖 Dynamic progress SUCCESS: '{content[:50]}...' -> '{dynamic_message}'")
                return dynamic_message
            else:
                # Fallback
                logger.warning(f"🤖 Dynamic progress FAILED validation: '{dynamic_message}'")
                return "⚡ Processing your request..."
        except Exception as e:
            logger.error(f"🤖 Failed to generate dynamic progress message: {e}")
            return "⚡ Processing your request..."

    def _is_valid_progress_message(self, message: str, word_count: int) -> bool:
        """Validate that the progress message meets requirements."""
        if not message or word_count < 3 or word_count > 10:
            return False

        # Check if it starts with an emoji
        import unicodedata
        if not message:
            return False

        first_char = message[0]
        if unicodedata.category(first_char) in ['So', 'Sk']:
            if message.startswith("⚡") and "Processing" in message:
                return True
            return True
        return False

    async def _call_llm(self, prompt: str) -> str:
        """Call the Cortex LLM API for progress message generation."""
        try:
            from autogen_core.models import UserMessage

            messages = [UserMessage(content=prompt, source="progress_handler")]
            response = await self.model_client.create(messages=messages)

            if response and hasattr(response, 'content'):
                return response.content
            elif response and isinstance(response, list) and len(response) > 0:
                return response[0].content if hasattr(response[0], 'content') else str(response[0])
            else:
                logger.debug("LLM call returned unexpected response format")
                return ""
        except Exception as e:
            logger.debug(f"LLM call failed: {e}")
            return ""

    async def _clamp_progress(self, task_id: str, percentage: float) -> float:
        """Ensure progress only increases monotonically."""
        async with self._progress_lock:
            max_pct_so_far = self._max_progress_by_request.get(task_id, 0.0)

            if percentage >= max_pct_so_far:
                # Allow any forward progress
                clamped = percentage
                self._max_progress_by_request[task_id] = percentage
            else:
                # Don't allow backward progress
                clamped = max_pct_so_far

            return clamped

    async def handle_progress_update(self, task_id: str, percentage: float, content: str, message_type: str = None, source: str = None, data: str = None, is_heartbeat: bool = False) -> float:
        """Handle progress updates - auto-increment progress for dynamic messages.
        
        Returns:
            The actual percentage sent to Redis after clamping and auto-increment.
        """
        try:
            # Auto-increment progress for dynamic messages (use 0.0 to trigger auto-increment)
            final_percentages = [0.05, 0.94, 0.95, 1.0]  # Static percentages
            if percentage == 0.0 and not is_heartbeat:  # 0.0 triggers auto-increment
                # Simple check: if same content as last message, reuse its percentage
                last_content = self._last_message_content.get(task_id)
                if last_content == content:
                    # Same message - reuse percentage
                    percentage = self._last_message_percentage.get(task_id, 0.06)
                    logger.debug(f"Reusing percentage {percentage:.0%} for same content")
                else:
                    # New message - increment
                    current_max = self._max_progress_by_request.get(task_id, 0.05)
                    if current_max < 0.06:
                        auto_percentage = 0.06
                    else:
                        auto_percentage = min(current_max + 0.01, 0.93)
                    percentage = auto_percentage
                    logger.debug(f"New content - incrementing to {percentage:.0%}")

            clamped_pct = await self._clamp_progress(task_id, percentage)
            logger.debug(f"Progress update: input={percentage}, clamped={clamped_pct}, max_so_far={self._max_progress_by_request.get(task_id, 0)}")

            # Update heartbeat message when new progress arrives (not for heartbeat repeats)
            if not is_heartbeat:
                await self.update_heartbeat_message(task_id, clamped_pct, content)

            # SAFETY: Stop heartbeat for any message >= 95% (handles edge cases)
            # This ensures heartbeat stops even if we never reach exactly 100% due to clamping
            if clamped_pct >= 0.95:
                await self.stop_heartbeat(task_id)
                logger.debug(f"💓 Stopped heartbeat at {clamped_pct:.0%} (>= 95%)")

            # For final updates with data, send immediately and mark as finalized
            if clamped_pct >= 1.0 and data is not None:
                await self.redis_publisher.set_transient_update(task_id, clamped_pct, content, data)
                await self.redis_publisher.mark_final(task_id)
                logger.info(f"🏁  PUBLISHING FINAL MESSAGE: requestId={task_id}, progress={clamped_pct}, data_length={len(data) if data else 0}")
                return clamped_pct

            # For heartbeat updates, use shorter rate limiting (0.5 seconds)
            if is_heartbeat:
                await self._send_heartbeat_update(task_id, clamped_pct, content)
                return clamped_pct
            else:
                # For regular updates, publish directly (no background queue needed)
                # Prevent duplicate messages - don't send if identical to last published for this request
                current_key = f"{clamped_pct:.2f}_{content}"
                last_sent_key = self._last_sent_by_request.get(task_id)

                if current_key != last_sent_key:
                    await self.redis_publisher.set_transient_update(task_id, clamped_pct, content)
                    self._last_sent_by_request[task_id] = current_key
                    
                    # Update simple tracking
                    self._last_message_content[task_id] = content
                    self._last_message_percentage[task_id] = clamped_pct

                    # Keep only last 100 published messages to prevent memory growth
                    if len(self._last_published_messages) > 100:
                        # Remove oldest entries (this is a simple approach)
                        self._last_published_messages = set(list(self._last_published_messages)[-50:])
                
                return clamped_pct

        except Exception as e:
            logger.debug(f"Failed to handle progress update: {e}")
            return 0.0  # Return 0 on error

    async def _send_heartbeat_update(self, task_id: str, percentage: float, content: str):
        """Send heartbeat updates with more frequent rate limiting."""
        try:
            import time
            current_time = time.time()
            last_time = self._last_progress_time_by_request.get(task_id, 0)
            last_progress = self._max_progress_by_request.get(task_id, 0)

            # Only send heartbeat if enough time has passed AND progress hasn't changed
            # This prevents duplicate messages at the same progress level
            if (current_time - last_time > 1.0 and
                abs(percentage - last_progress) < 0.001):  # Same progress level
                self._last_progress_time_by_request[task_id] = current_time
                await self.redis_publisher.set_transient_update(task_id, percentage, content)
                logger.debug(f"💓 Heartbeat update sent: {percentage:.0%} - {content}")
        except Exception as e:
            logger.debug(f"Failed to send heartbeat update: {e}")

    def _is_internal_selector_message(self, content: str) -> bool:
        """Check if content is an internal selector message that shouldn't be shown to users."""
        if not content:
            return True

        content_lower = content.lower()

        # Internal routing messages
        internal_patterns = [
            "routing to",
            "🎯 selector:",
            "delegating to",
            "switching to",
            "selecting agent",
            "agent selection",
            "execution complete",
            "task completed",
            "ready for upload",
            "files uploaded",
            "finalizing results"
        ]

        return any(pattern in content_lower for pattern in internal_patterns)


    # ========================================================================
    # NEW HEARTBEAT API - Consolidates all heartbeat logic
    # ========================================================================
    
    async def start_heartbeat(self, task_id: str, initial_message: str = "🚀 Starting your task..."):
        """
        Start heartbeat for a task - sends instant 5% message and begins background loop.
        
        This is the main entry point for starting progress updates:
        - Sends immediate 5% progress message 
        - Starts background heartbeat loop (1s repeats + Xs LLM updates)
        """
        # Send instant 5% message
        await self.redis_publisher.set_transient_update(task_id, 0.05, initial_message)
        self._max_progress_by_request[task_id] = 0.05
        self._last_summary_by_request[task_id] = initial_message
        logger.info(f"📝 Sent instant 5% message: {initial_message}")
        
        # Initialize heartbeat state
        self._heartbeat_state[task_id] = {
            'last_message': initial_message,
            'last_percentage': 0.05,
            'last_update_time': time.time(),
            'heartbeat_task': None,
            'llm_counter': 0
        }
        
        # Start heartbeat loop
        task = asyncio.create_task(self._heartbeat_loop(task_id))
        self._heartbeat_state[task_id]['heartbeat_task'] = task
        logger.info(f"💓 Started heartbeat loop for task {task_id}")
    
    async def update_heartbeat_message(self, task_id: str, percentage: float, message: str):
        """
        Update the message that the heartbeat will repeat.
        
        Called by agents when they send progress updates. This becomes the new
        message that gets repeated every second.
        """
        if task_id in self._heartbeat_state:
            self._heartbeat_state[task_id]['last_message'] = message
            self._heartbeat_state[task_id]['last_percentage'] = percentage
            self._heartbeat_state[task_id]['last_update_time'] = time.time()
            self._heartbeat_state[task_id]['llm_counter'] = 0  # Reset LLM counter on new message
            logger.debug(f"� Updated heartbeat message for {task_id}: {percentage:.0%} - {message[:50]}...")
    
    async def stop_heartbeat(self, task_id: str):
        """Stop the heartbeat for a task (called when task reaches 100%)."""
        if task_id in self._heartbeat_state:
            task = self._heartbeat_state[task_id].get('heartbeat_task')
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            del self._heartbeat_state[task_id]
            logger.info(f"💓 Stopped heartbeat for task {task_id}")
    
    async def _heartbeat_loop(self, task_id: str):
        """
        Main heartbeat loop - runs in background for each task.
        
        Mechanism:
        - Every 1 second: Repeat last message (simple repeat, no LLM)
        - Every X seconds: Generate new LLM-powered message from agent activity
        - Stops when task reaches 100%
        """
        try:
            while True:
                await asyncio.sleep(1)  # 1-second heartbeat
                
                if task_id not in self._heartbeat_state:
                    break
                
                state = self._heartbeat_state[task_id]
                
                # Check if task is complete
                if state['last_percentage'] >= 1.0:
                    await self.stop_heartbeat(task_id)
                    break
                
                # Increment LLM counter
                state['llm_counter'] += 1
                
                if state['llm_counter'] >= 10:
                    # Every 10 seconds: Generate LLM-powered message
                    try:
                        # Get current agent activity/context
                        # For now, we'll use a simple status message
                        # In future, we can check agent activity logs
                        new_message = await self._get_dynamic_progress_message(
                            source="heartbeat",
                            content="Processing...",
                            task_context="",
                            request_id=task_id
                        )
                        
                        if new_message and new_message != state['last_message']:
                            # Update message but keep same percentage (heartbeat never increments)
                            current_pct = state['last_percentage']
                            
                            # Send new LLM message with same percentage (no increment)
                            await self.redis_publisher.set_transient_update(
                                task_id, 
                                current_pct, 
                                new_message
                            )
                            state['last_message'] = new_message
                            # Keep same percentage - heartbeat never increments
                            logger.debug(f"💡 LLM heartbeat update: {current_pct:.0%} - {new_message[:50]}...")
                        else:
                            # Fallback to repeat if LLM fails or returns same message
                            await self.redis_publisher.set_transient_update(
                                task_id,
                                state['last_percentage'],
                                state['last_message']
                            )
                    except Exception as e:
                        logger.debug(f"LLM heartbeat generation failed, using repeat: {e}")
                        # Fallback to simple repeat
                        await self.redis_publisher.set_transient_update(
                            task_id,
                            state['last_percentage'],
                            state['last_message']
                        )
                    
                    state['llm_counter'] = 0  # Reset counter
                else:
                    # Every 1 second: Simple repeat of last message
                    await self.redis_publisher.set_transient_update(
                        task_id,
                        state['last_percentage'],
                        state['last_message']
                    )
                    logger.debug(f"💓 Heartbeat repeat: {state['last_percentage']:.0%} - {state['last_message'][:30]}...")
        
        except asyncio.CancelledError:
            logger.debug(f"Heartbeat loop cancelled for task {task_id}")
        except Exception as e:
            logger.error(f"Heartbeat loop failed for task {task_id}: {e}")


    # ========================================================================
    # DEPRECATED HEARTBEAT METHODS - Keeping for backwards compatibility
    # ========================================================================

    async def _ensure_continuous_heartbeat(self, task_id: str, percentage: float, content: str):
        """DEPRECATED: Use start_heartbeat() instead."""
        # No-op - new heartbeat is started via start_heartbeat()
        pass

    async def _stop_continuous_heartbeat(self, task_id: str):
        """DEPRECATED: Use stop_heartbeat() instead."""
        await self.stop_heartbeat(task_id)

    async def _run_continuous_heartbeat(self, task_id: str, percentage: float, content: str):
        """DEPRECATED: Use _heartbeat_loop() instead."""
        # No-op - should not be called in new architecture
        pass
