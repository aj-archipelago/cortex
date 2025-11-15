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
    """Handles progress updates, summarization, and background processing."""

    def __init__(self, redis_publisher, model_client):
        self.redis_publisher = redis_publisher
        self.model_client = model_client
        self._progress_queue: Optional[asyncio.Queue] = None
        self._progress_worker_task: Optional[asyncio.Task] = None
        self._progress_lock = asyncio.Lock()
        self._max_progress_by_request: Dict[str, float] = {}
        self._last_summary_by_request: Dict[str, str] = {}
        self._last_progress_time_by_request: Dict[str, float] = {}

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
                    summary = await self.summarize_progress(content, msg_type, source, None)
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

    async def summarize_progress(self, content: str, message_type: str = None, source: str = None, model_client=None) -> str:
        """Summarize progress content for display with intelligent filtering."""
        if not content:
            return ""

        # Skip internal messages
        if self._should_skip_progress_update(content, message_type, source):
            return ""

        # Clean content for summarization
        cleaned = self._clean_content_for_progress(content, message_type, source)

        # Use LLM to generate dynamic progress message
        return await self._get_dynamic_progress_message(source or "", cleaned)

    def _should_skip_progress_update(self, content: str, message_type: str = None, source: str = None) -> bool:
        """Determine if a progress update should be skipped."""
        if not content:
            return True

        content_lower = content.lower()

        # Skip very short messages
        if len(content.strip()) < 3:
            return True

        # Skip internal/technical messages
        skip_patterns = [
            "ready for upload",
            "file created",
            "columns:",
            "rows:",
            "preview:",
            "http request",
            "api call",
            "tool call",
            "function call",
            "execution complete",
            "task completed",
            "processing...",
            "working...",
        ]

        if any(pattern in content_lower for pattern in skip_patterns):
            return True

        # Skip if from certain sources
        if source in ["system", "internal"]:
            return True

        return False

    def _clean_content_for_progress(self, content: str, message_type: str = None, source: str = None) -> str:
        """Clean and prepare content for progress summarization."""
        if not content:
            return ""

        # Remove common prefixes/suffixes
        content = content.strip()
        content = content.replace("📊", "").replace("💻", "").replace("🚀", "").strip()

        # Limit length
        if len(content) > 200:
            content = content[:200] + "..."

        return content

    async def _get_dynamic_progress_message(self, source: str, content: str, task_context: str = "") -> str:
        """Use LLM to generate dynamic, contextual progress messages instead of static mappings."""
        if not content or not content.strip():
            return content

        # Skip if message is already a well-formed, dynamic progress message (not generic static ones)
        # Only skip messages that are clearly LLM-generated (varied language, specific actions)
        generic_messages = [
            "🧭 planning your task...",
            "🚀 creating your perfect result",
            "⚡ running code execution...",
            "📤 uploading files...",
            "🎨 creating final presentation..."
        ]
        if content.lower().strip() in [msg.lower() for msg in generic_messages]:
            # Force LLM processing for these generic messages
            pass  # Continue to LLM processing
        elif (content.startswith(("🚀", "🧭", "🔍", "📊", "💻", "⚡", "🎨", "📤", "✨")) and
              len(content) < 60 and
              len(content.split()) >= 4 and  # Must have multiple words
              any(word in content.lower() for word in ["building", "analyzing", "crafting", "designing", "generating", "processing", "optimizing"])):
            return content

        # Use LLM to generate dynamic progress message
        prompt = f"""Convert this technical agent message into a concise, engaging progress update for the user.

TECHNICAL MESSAGE: "{content}"
SOURCE AGENT: {source}

BAD EXAMPLES TO AVOID:
- "Double checking implementation details"
- "Verifying code structure"
- "Validating parameters"
- Repetitive messages like "Processing... Processing..."
- Technical jargon like "optimizing algorithms", "parsing data structures"

GOOD EXAMPLES:
- "🚀 Building your custom solution"
- "📊 Analyzing patterns in your data"
- "💻 Crafting intelligent automation"
- "🎨 Creating beautiful visualizations"
- "⚡ Executing your plan perfectly"

REQUIREMENTS:
- Start with exactly one emoji (🚀🧭🔍📊💻⚡🎨📤✨)
- Keep under 60 characters
- Be engaging and positive
- Focus on user benefits, not technical details
- Use active, dynamic language
- Never repeat the same message pattern

Return ONLY the progress message, no explanation:"""

        try:
            logger.info(f"🤖 Generating dynamic progress for: '{content}'")
            response = await self._call_llm(prompt)
            dynamic_message = response.strip()
            logger.info(f"🤖 LLM response: '{dynamic_message}'")

            # Validate the response
            if (len(dynamic_message) > 10 and len(dynamic_message) < 80 and
                any(emoji in dynamic_message for emoji in ["🚀", "🧭", "🔍", "📊", "💻", "⚡", "🎨", "📤", "✨"])):
                logger.info(f"🤖 Dynamic progress SUCCESS: '{content}' -> '{dynamic_message}'")
                return dynamic_message
            else:
                # Fallback to a generic message if LLM response is invalid
                logger.warning(f"🤖 Dynamic progress FAILED validation: '{dynamic_message}' (len={len(dynamic_message)})")
                return "🚀 Creating your perfect result"
        except Exception as e:
            logger.error(f"🤖 Failed to generate dynamic progress message: {e}")
            # Fallback to simple filtering
            return self._simple_progress_filter(content)

    def _simple_progress_filter(self, content: str) -> str:
        """Simple fallback filtering for when LLM is unavailable."""
        if not content:
            return content

        content_lower = content.lower()

        # Simple keyword-based filtering
        if "analyzing" in content_lower or "data" in content_lower:
            return "📊 Analyzing and discovering insights"
        elif "code" in content_lower or "building" in content_lower:
            return "💻 Building intelligent solutions"
        elif "uploading" in content_lower or "files" in content_lower:
            return "📤 Preparing your deliverables"
        else:
            return "🚀 Creating your perfect result"

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

    async def handle_progress_update(self, task_id: str, percentage: float, content: str, message_type: str = None, source: str = None, data: str = None, is_heartbeat: bool = False):
        """Handle progress updates - process synchronously since messages are already dynamic."""
        try:
            clamped_pct = await self._clamp_progress(task_id, percentage)

            # For final updates with data, send immediately and mark as finalized
            if clamped_pct >= 1.0 and data is not None:
                await self.redis_publisher.set_transient_update(task_id, clamped_pct, content, data)
                await self.redis_publisher.mark_final(task_id)
                logger.info(f"🏁  PUBLISHING FINAL MESSAGE: requestId={task_id}, progress={clamped_pct}, data_length={len(data) if data else 0}")
                return

            # For heartbeat updates, use shorter rate limiting (0.5 seconds)
            if is_heartbeat:
                await self._send_heartbeat_update(task_id, clamped_pct, content)
            else:
                # For regular updates, publish directly (no background queue needed)
                await self.redis_publisher.set_transient_update(task_id, clamped_pct, content)

        except Exception as e:
            logger.debug(f"Failed to handle progress update: {e}")

    async def _send_heartbeat_update(self, task_id: str, percentage: float, content: str):
        """Send heartbeat updates with more frequent rate limiting."""
        try:
            import time
            current_time = time.time()
            last_time = self._last_progress_time_by_request.get(task_id, 0)
            last_progress = self._transient_latest.get(task_id, {}).get("progress", 0)

            # Only send heartbeat if enough time has passed AND progress hasn't changed
            # This prevents duplicate messages at the same progress level
            if (current_time - last_time > 5.0 and
                abs(percentage - last_progress) < 0.001):  # Same progress level
                self._last_progress_time_by_request[task_id] = current_time
                await self.redis_publisher.set_transient_update(task_id, percentage, f"⏳ {content}")
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
