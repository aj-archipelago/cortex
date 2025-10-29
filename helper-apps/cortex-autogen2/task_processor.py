import asyncio
import json
import base64
import logging
import os
from typing import Optional, Dict, Any, List, Tuple, Union
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import ModelInfo, UserMessage, AssistantMessage, SystemMessage
from autogen_agentchat.teams import SelectorGroupChat
from autogen_core.models import UserMessage
from autogen_agentchat.conditions import TextMentionTermination, HandoffTermination
from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
from services.azure_ai_search import search_similar_rest, upsert_run_rest
from services.run_analyzer import (
    collect_run_metrics,
    extract_errors,
    redact,
    summarize_learnings,
    build_run_document,
    summarize_prior_learnings,
)
from agents import get_agents
from tools.azure_blob_tools import upload_file_to_azure_blob

logger = logging.getLogger(__name__)


def _message_to_dict(msg: Any) -> Optional[Dict[str, Any]]:
    """Best-effort conversion of chat message objects to a plain dict."""
    if isinstance(msg, dict):
        return dict(msg)

    for attr in ("model_dump", "dict", "to_dict", "as_dict"):
        if hasattr(msg, attr):
            try:
                candidate = getattr(msg, attr)()
                if isinstance(candidate, dict):
                    return dict(candidate)
            except TypeError:
                try:
                    candidate = getattr(msg, attr)(exclude_none=False)
                    if isinstance(candidate, dict):
                        return dict(candidate)
                except Exception:
                    continue
            except Exception:
                continue

    if hasattr(msg, "__dict__"):
        try:
            return {k: v for k, v in vars(msg).items() if not k.startswith("__")}
        except Exception:
            return None

    return None


class RoleFixingModelClientWrapper:
    """Wraps an OpenAI model client to fix agent message roles before API calls."""
    
    def __init__(self, wrapped_client: OpenAIChatCompletionClient):
        self.wrapped_client = wrapped_client
    
    async def create(self, messages=None, **kwargs):
        """Intercept create calls to fix message roles before sending to API."""
        if messages:
            normalized_messages: List[Dict[str, Any]] = []
            first_user_seen = False
            for raw_msg in messages:
                normalized, first_user_seen = _normalize_single_message(raw_msg, first_user_seen)
                normalized_messages.append(normalized)
            messages = normalized_messages
        return await self.wrapped_client.create(messages=messages, **kwargs)
    
    def __getattr__(self, name):
        """Delegate all other attributes/methods to wrapped client."""
        return getattr(self.wrapped_client, name)


def _stringify_content(content: Any) -> str:
    import json

    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            elif isinstance(item, dict):
                try:
                    parts.append(json.dumps(item, ensure_ascii=False))
                except Exception:
                    parts.append(str(item))
            else:
                parts.append(str(item))
        return "\n".join(parts)

    if isinstance(content, dict):
        try:
            return json.dumps(content, ensure_ascii=False)
        except Exception:
            return str(content)

    return str(content)


def _wrap_json_if_needed(text: str) -> str:
    import json

    if not isinstance(text, str):
        text = str(text)

    stripped = text.strip()
    if stripped.startswith("```"):
        return text

    looks_like_json = False
    if (stripped.startswith("{") and stripped.endswith("}")) or (
        stripped.startswith("[") and stripped.endswith("]")
    ):
        try:
            json.loads(stripped)
            looks_like_json = True
        except Exception:
            looks_like_json = False

    if looks_like_json:
        return f"```json\n{stripped}\n```"

    return text


def _normalize_single_message(raw_message: Any, first_user_seen: bool) -> Tuple[Dict[str, Any], bool]:
    import json

    msg = _message_to_dict(raw_message) or {}

    # Determine role
    if msg.get("name"):
        msg["role"] = "assistant"
    elif not msg.get("role"):
        if not first_user_seen:
            msg["role"] = "user"
            first_user_seen = True
        else:
            msg["role"] = "assistant"
    elif msg.get("role") == "user" and first_user_seen:
        msg["role"] = "assistant"
    elif msg.get("role") == "user" and not first_user_seen:
        first_user_seen = True
    elif msg.get("role") not in {"assistant", "system"}:
        msg["role"] = "assistant"

    role = msg.get("role", "assistant")
    name = msg.get("name") or msg.get("source") or ("user" if role == "user" else "assistant")

    base_content = _stringify_content(msg.get("content"))

    tool_calls = msg.get("tool_calls") if isinstance(msg.get("tool_calls"), list) else None
    if tool_calls:
        role = "assistant"
        try:
            tool_json = json.dumps(tool_calls, ensure_ascii=False)
        except Exception:
            tool_json = str(tool_calls)
        tool_text = _wrap_json_if_needed(tool_json)
        if base_content:
            base_content = f"{base_content}\n\nTool calls:\n{tool_text}"
        else:
            base_content = f"Tool calls:\n{tool_text}"

    content_text = _wrap_json_if_needed(base_content) if role != "system" else base_content

    if role == "system":
        message_obj = SystemMessage(content=content_text)
    elif role == "user":
        message_obj = UserMessage(content=content_text, source=str(name))
    else:
        message_obj = AssistantMessage(content=content_text, source=str(name))

    return message_obj, first_user_seen


class TaskProcessor:
    """
    Core task processing logic that can be used by both worker and Azure Function App.
    """
    
    def __init__(self):
        self.o3_model_client = None
        self.o4_mini_model_client = None
        self.gpt41_model_client = None
        self.progress_tracker = None
        self.final_progress_sent = False
        self.current_owner: Optional[str] = None
        # Background progress worker components
        self._progress_queue: Optional[asyncio.Queue] = None
        self._progress_worker_task: Optional[asyncio.Task] = None
        self._last_summary_by_request: Dict[str, str] = {}
        
    async def initialize(self):
        """Initialize model clients and services."""
        import os
        from dotenv import load_dotenv
        load_dotenv()
        
        CORTEX_API_KEY = os.getenv("CORTEX_API_KEY")
        CORTEX_API_BASE_URL = os.getenv("CORTEX_API_BASE_URL", "http://host.docker.internal:4000/v1")

        # Define ModelInfo for custom models
        o3_model_info = ModelInfo(model="o3", name="Cortex o3", max_tokens=128000, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False)
        o4_mini_model_info = ModelInfo(model="o4-mini", name="Cortex o4-mini", max_tokens=128000, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) 
        gpt41_model_info = ModelInfo(model="gpt-4.1", name="Cortex gpt-4.1", max_tokens=8192, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) 
        gpt5_model_info = ModelInfo(model="gpt-5", name="Cortex gpt-5", max_tokens=128000, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) 
        claude_4_sonnet_model_info = ModelInfo(model="claude-4-sonnet", name="Cortex claude-4-sonnet", max_tokens=128000, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) 

        self.o3_model_client = OpenAIChatCompletionClient(
            model="o3",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=o3_model_info # Pass model_info
        )

        self.o4_mini_model_client = OpenAIChatCompletionClient(
            model="o4-mini",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=o4_mini_model_info # Pass model_info
        )

        self.gpt41_model_client = OpenAIChatCompletionClient(
            model="gpt-4.1",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=gpt41_model_info # Pass model_info
        )

        self.gpt5_model_client = OpenAIChatCompletionClient(
            model="gpt-5",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=gpt5_model_info # Pass model_info
        )

        self.claude_4_sonnet_model_client = OpenAIChatCompletionClient(
            model="claude-4-sonnet",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=claude_4_sonnet_model_info # Pass model_info
        )
        
        self.progress_tracker = await get_redis_publisher()
        # Ensure background progress worker is running
        await self._ensure_progress_worker()

    async def _ensure_progress_worker(self) -> None:
        """Start a single background worker to process progress updates asynchronously."""
        try:
            if self._progress_queue is None:
                # Bounded queue to avoid memory growth; newest updates replace when full
                self._progress_queue = asyncio.Queue(maxsize=256)
            if self._progress_worker_task is None or self._progress_worker_task.done():
                self._progress_worker_task = asyncio.create_task(self._progress_worker_loop())
        except Exception as e:
            logger.warning(f"Failed to start progress worker: {e}")

    async def _progress_worker_loop(self) -> None:
        """Continuously consume progress events, summarize, de-duplicate, and publish transient updates."""
        try:
            while True:
                try:
                    event = await self._progress_queue.get()
                    if not event:
                        self._progress_queue.task_done()
                        continue
                    req_id = event.get("task_id")
                    pct = float(event.get("percentage") or 0.0)
                    content = event.get("content")
                    msg_type = event.get("message_type")
                    source = event.get("source")
                    # Summarize in background
                    summary = await self.summarize_progress(content, msg_type, source)
                    if summary:
                        last = self._last_summary_by_request.get(req_id)
                        if last != summary:
                            self._last_summary_by_request[req_id] = summary
                            try:
                                await self.progress_tracker.set_transient_update(req_id, pct, summary)
                            except Exception as pub_err:
                                logger.debug(f"Progress transient publish error for {req_id}: {pub_err}")
                    self._progress_queue.task_done()
                except asyncio.CancelledError:
                    raise
                except Exception as loop_err:
                    logger.debug(f"Progress worker loop error: {loop_err}")
        except asyncio.CancelledError:
            logger.info("Progress worker task cancelled")
        except Exception as e:
            logger.warning(f"Progress worker terminated unexpectedly: {e}")

    async def summarize_progress(self, content: str, message_type: str = None, source: str = None) -> str:
        """Summarize progress content for display with intelligent filtering."""
        try:
            # Skip internal selector or housekeeping messages entirely
            if self._is_internal_selector_message(content):
                return None
            # Filter out technical/internal messages that shouldn't be shown to users
            if self._should_skip_progress_update(content, message_type, source):
                return None
            
            # Clean and prepare content for summarization
            cleaned_content = self._clean_content_for_progress(content, message_type, source)
            if not cleaned_content:
                return None
            
            prompt = f"""Create a professional progress update (8-12 words) showing expert work in action. User is watching a skilled professional handle their task.

Activity: {cleaned_content}
Role: {source if source else "Unknown"}

═══════════════════════════════════════════════════════════════════
🎯 CORE PRINCIPLES
═══════════════════════════════════════════════════════════════════

1. **SHOW CRAFT, NOT OUTCOME** - User watches expertise, not receives results
   ❌ "Report ready for download"
   ✅ "Compiling insights into executive summary"

2. **PRESENT CONTINUOUS** - Always -ing verbs (happening right now)
   ✅ "Analyzing... Designing... Building... Processing..."

3. **NEVER ADDRESS USER** - No "you/your", no "for you", no promises
   ❌ "Gathering images for your presentation"
   ❌ "Preparing your report"
   ❌ "Finding what you need"
   ✅ "Assembling presentation materials"

4. **PROFESSIONAL BUSINESS TONE** - Confident expert, not friendly helper
   ✅ "Processing financial data across quarterly reports"
   ❌ "Crunching numbers to find cool insights!"

5. **SPECIFIC = CREDIBLE** - What exactly is happening?
   ✅ "Structuring analysis across 6 data dimensions"
   ❌ "Processing information"

═══════════════════════════════════════════════════════════════════
📋 EMOJI + PATTERNS
═══════════════════════════════════════════════════════════════════

🧭 Planning/Strategy:
- "Architecting multi-phase analysis framework"
- "Structuring comprehensive research methodology"
- "Mapping data relationships across sources"

📊 Data/Analysis:
- "Processing statistical patterns in time-series data"
- "Analyzing trends across historical datasets"
- "Computing correlations between key metrics"

🖼️ Images/Media:
- "Sourcing high-resolution assets from verified collections"
- "Curating professional imagery meeting brand standards"
- "Selecting licensed graphics from premium libraries"

✨ Creating/Designing:
- "Designing presentation with executive-level polish"
- "Building interactive visualizations from raw data"
- "Crafting report layout with professional typography"

📝 Writing/Content:
- "Synthesizing findings into coherent narrative"
- "Structuring content with logical flow"
- "Composing analysis with supporting evidence"

🔍 Research/Search:
- "Scanning authoritative sources for verified information"
- "Cross-referencing multiple knowledge bases"
- "Extracting relevant data from extensive archives"

📦 Finalizing/Delivery:
- "Applying final quality checks to deliverables"
- "Packaging complete analysis suite"
- "Validating output against requirements"

═══════════════════════════════════════════════════════════════════
❌ FORBIDDEN PATTERNS
═══════════════════════════════════════════════════════════════════

NEVER use:
- "for you" / "your" / addressing user
- "ready" / "complete" / "done" (premature)
- "downloading" / "uploading" (technical mechanics)
- "perfect" / "awesome" / "amazing" (overhype)
- "just" / "simply" / "quickly" (undermines expertise)
- Technical terms: SQL, API, database names, code
- Vague verbs: "working on", "getting", "making"

Return ONLY: [emoji] [professional update text]"""
            
            messages = [UserMessage(content=str(prompt), source="summarize_progress_function")]
            
            response = await self.gpt41_model_client.create(messages=messages)
            return response.content.strip()
        except Exception as e:
            logging.error(f"Error in summarize_progress: {e}")
            return None

    def _should_skip_progress_update(self, content: str, message_type: str = None, source: str = None) -> bool:
        """Determine if a progress update should be skipped."""
        if not content:
            return True

        content_str = str(content).strip().upper()

        # Skip internal selector prompts or bare role names
        if self._is_internal_selector_message(content):
            return True

        # Skip HandoffMessage (agent transfers)
        if message_type == "HandoffMessage":
            return True

        # Skip messages containing agent handoff keywords (internal coordination)
        handoff_keywords = ["TRANSFERRED TO", "ADOPTING THE ROLE", "HANDOFF TO", "TRANSFER_TO_", "ASSUMING", "ROLE AND INITIATING"]
        if any(keyword in content_str for keyword in handoff_keywords):
            return True

        # Skip termination messages
        if content_str == "TERMINATE" or "TERMINATE" in content_str:
            return True

        # Skip empty or whitespace-only content
        if not content_str or content_str.isspace():
            return True

        # Skip technical tool execution messages
        if message_type == "ToolCallExecutionEvent":
            return True

        # Skip messages from terminator agent
        if source == "terminator_agent":
            return True
            
        # Skip JSON responses that are just data
        try:
            json.loads(content_str)
            # If it's valid JSON, it's probably technical data
            return True
        except:
            pass
            
        return False

    def _clean_content_for_progress(self, content: str, message_type: str = None, source: str = None) -> str:
        """Clean and prepare content for progress summarization."""
        if not content:
            return None
            
        content_str = str(content)
        
        # Remove common technical prefixes/suffixes
        technical_patterns = [
            "TERMINATE",
            "TASK NOT COMPLETED:",
            "Error:",
            "Warning:",
            "DEBUG:",
            "INFO:",
            "Tool call:",
            "Function call:",
        ]
        
        cleaned = content_str
        for pattern in technical_patterns:
            cleaned = cleaned.replace(pattern, "").strip()
            
        # If content is too short after cleaning, skip it
        if len(cleaned) < 10:
            return None
            
        return cleaned

    def _is_internal_selector_message(self, content: str) -> bool:
        """Detect AutoGen selector prompts and bare role selections to avoid surfacing them."""
        if not content:
            return False
        text = str(content).strip()
        selector_markers = [
            "You are in a role play game.",
            "select the next role",
            "Only return the role.",
        ]
        for marker in selector_markers:
            if marker.lower() in text.lower():
                return True

        role_names = {
            "planner_agent", "coder_agent", "code_executor", "terminator_agent",
            "presenter_agent", "aj_sql_agent",
            "aj_article_writer_agent", "cognitive_search_agent", "web_search_agent"
        }
        # If the entire content is just a role name, treat as internal
        if text in role_names:
            return True

        # Treat provider schema errors about tool_calls/MultiMessage as internal noise
        try:
            lowered = text.lower()
            if ("tool_calls" in lowered) and ("multimessage" in lowered) and ("field" in lowered or "variable" in lowered):
                return True
        except Exception:
            pass
        return False

    async def handle_progress_update(self, task_id: str, percentage: float, content: str, message_type: str = None, source: str = None):
        """Enqueue progress updates for the background worker to process (non-blocking)."""
        try:
            if self._progress_queue is None:
                await self._ensure_progress_worker()
            event = {
                "task_id": task_id,
                "percentage": percentage,
                "content": content,
                "message_type": message_type,
                "source": source,
            }
            # Prefer non-blocking put; if full, drop the oldest and retry once
            try:
                self._progress_queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    # Drop one item to make room
                    _ = self._progress_queue.get_nowait()
                    self._progress_queue.task_done()
                except Exception:
                    pass
                try:
                    self._progress_queue.put_nowait(event)
                except Exception:
                    pass
        except Exception as e:
            logger.debug(f"handle_progress_update enqueue error: {e}")

    async def publish_final(self, task_id: str, message: str, data: Any = None) -> None:
        """Publish a final 1.0 progress message once."""
        if self.final_progress_sent:
            return
        try:
            if self.progress_tracker:
                final_data = message if data is None else data
                await self.progress_tracker.publish_progress(task_id, 1.0, message, data=final_data)
                self.final_progress_sent = True
        except Exception as e:
            logger.error(f"❌ Failed to publish final progress for task_id={task_id}: {e}")

    async def process_task(self, task_id: str, task_content: str) -> str:
        """Process a single task and return the final result."""
        try:
            task_completed_percentage = 0.05
            task = task_content

            # Per-request working directory: isolate artifacts under /tmp/coding/<task_id>
            try:
                base_wd = os.getenv("CORTEX_WORK_DIR", "/tmp/coding")
                # In Azure Functions, force /tmp for write access
                if os.getenv("WEBSITE_INSTANCE_ID") and base_wd.startswith("/app/"):
                    base_wd = "/tmp/coding"
                import time
                req_dir_name = f"req_{task_id}" if task_id else f"req_{int(time.time())}"
                request_work_dir = os.path.join(base_wd, req_dir_name)
                os.makedirs(request_work_dir, exist_ok=True)
                os.environ["CORTEX_WORK_DIR"] = request_work_dir
                # pass to get_agents so all tools use this dir
                request_work_dir_for_agents = request_work_dir
            except Exception:
                # Fallback to base directory if per-request directory cannot be created
                try:
                    os.makedirs(os.getenv("CORTEX_WORK_DIR", "/tmp/coding"), exist_ok=True)
                except Exception:
                    pass

            # Send initial progress update (transient only)
            await self.progress_tracker.set_transient_update(task_id, 0.05, "🚀 Starting your task...")

            # Pre-run retrieval: ALWAYS gather lessons for planner (do not modify task text)
            planner_learnings = None
            try:
                similar_docs = search_similar_rest(task, top=8)
                if similar_docs:
                    planner_learnings = await summarize_prior_learnings(similar_docs, self.gpt41_model_client)
                    if planner_learnings:
                        await self.progress_tracker.set_transient_update(task_id, 0.05, "🧭 Using lessons from similar past tasks")
            except Exception as e:
                logger.debug(f"Pre-run retrieval failed: {e}")

            termination = HandoffTermination(target="user") | TextMentionTermination("TERMINATE")

            # Merge Azure AI Search lessons with structured hints for planner
            try:
                merged = []
                if 'planner_learnings' in locals() and planner_learnings:
                    merged.append(str(planner_learnings))
                if 'planner_hints' in locals() and planner_hints:
                    merged.append("\n".join([f"- {h}" for h in planner_hints][:6]))
                merged_planner_learnings = "\n".join([m for m in merged if m]) or None
            except Exception:
                merged_planner_learnings = locals().get('planner_learnings')

            # CRITICAL: Wrap model clients to fix agent message roles before API calls
            wrapped_gpt41_client = RoleFixingModelClientWrapper(self.gpt41_model_client)
            wrapped_o3_client = RoleFixingModelClientWrapper(self.o3_model_client)

            agents, presenter_agent, terminator_agent = await get_agents(
                wrapped_gpt41_client,
                wrapped_o3_client,
                wrapped_gpt41_client,
                request_work_dir=request_work_dir_for_agents if 'request_work_dir_for_agents' in locals() else None,
                planner_learnings=merged_planner_learnings,
                task_context=task if 'task' in locals() else None
            )

            team = SelectorGroupChat(
                participants=agents,
                model_client=wrapped_gpt41_client,
                termination_condition=termination,
                max_turns=500  # Increased to 500 - very complex tasks (word clouds, multi-database queries, extensive processing) need more turns
            )

            messages = []
            uploaded_file_urls = {}
            uploaded_files_list: List[Dict[str, Any]] = []
            external_media_urls: List[str] = []
            final_result_content = []

            detailed_task = f"""
            Accomplish and present your task to the user in a great way, Markdown, it ll be shown in a React app that supports markdown.
            Task: 
            {task}
            """

            stream = team.run_stream(task=task)
            # Loop guards for detecting stuck workflows
            repeated_schema_error_count = 0
            last_schema_error_seen = False
            no_files_found_count = 0
            no_code_blocks_count = 0
            task_not_completed_count = 0

            async for message in stream:
                messages.append(message)
                source = message.source if hasattr(message, 'source') else None
                content = message.content if hasattr(message, 'content') else None
                created_at = message.created_at if hasattr(message, 'created_at') else None
                logger.info(f"\n\n#SOURCE: {source}\n#CONTENT: {content}\n#CREATED_AT: {created_at}\n")

                task_completed_percentage = round(task_completed_percentage + 0.01, 2)
                if task_completed_percentage >= 1.0:
                    task_completed_percentage = 0.99

                # Circuit breaker: detect infinite loops
                try:
                    ctext = str(content) if content is not None else ""

                    # Schema error loop guard
                    is_schema_err = ("tool_calls" in ctext) and ("MultiMessage" in ctext)
                    if is_schema_err:
                        if last_schema_error_seen:
                            repeated_schema_error_count += 1
                        else:
                            repeated_schema_error_count = 1
                        last_schema_error_seen = True
                        if repeated_schema_error_count >= 3:
                            logger.warning("Breaking team.run_stream due to repeated MultiMessage/tool_calls schema errors.")
                            break
                    else:
                        last_schema_error_seen = False
                        repeated_schema_error_count = 0

                    # File uploader stuck loop guard
                    if "No files found" in ctext or "No output files" in ctext or "No files matching" in ctext:
                        no_files_found_count += 1
                        if no_files_found_count >= 5:
                            logger.warning(f"Breaking: file_uploader repeated 'No files found' {no_files_found_count} times. Likely issue with coder agent file paths.")
                            break

                    # Code executor stuck loop guard
                    if "No code blocks found" in ctext:
                        no_code_blocks_count += 1
                        if no_code_blocks_count >= 5:
                            logger.warning(f"Breaking: code_executor repeated 'No code blocks' {no_code_blocks_count} times. Coder agent not handing off properly.")
                            break

                    # Terminator stuck loop guard
                    if "TASK NOT COMPLETED" in ctext:
                        task_not_completed_count += 1
                        if task_not_completed_count >= 3:
                            logger.warning(f"Breaking: terminator said 'TASK NOT COMPLETED' {task_not_completed_count} times. Workflow stuck.")
                            break

                except Exception:
                    pass

                if content and not self._is_internal_selector_message(content):
                    processed_content_for_progress = content
                    if message.type == "ToolCallExecutionEvent" and hasattr(message, 'content') and isinstance(message.content, list):
                        error_contents = [res.content for res in message.content if hasattr(res, 'is_error') and res.is_error]
                        if error_contents:
                            processed_content_for_progress = "\n".join(error_contents)
                        else:
                            processed_content_for_progress = str(message.content)

                    if isinstance(content, str):
                        try:
                            json_content = json.loads(content)
                            if isinstance(json_content, dict):
                                # Handle upload_recent_deliverables format: {"uploads": [{blob_name, download_url}]}
                                if "uploads" in json_content and isinstance(json_content["uploads"], list):
                                    upload_count_before = len(uploaded_file_urls)
                                    for upload_item in json_content["uploads"]:
                                        if isinstance(upload_item, dict) and "download_url" in upload_item and "blob_name" in upload_item:
                                            uploaded_file_urls[upload_item["blob_name"]] = upload_item["download_url"]
                                    # Progress update when files are uploaded
                                    new_uploads = len(uploaded_file_urls) - upload_count_before
                                    if new_uploads > 0:
                                        try:
                                            asyncio.create_task(self.progress_tracker.set_transient_update(
                                                task_id,
                                                min(0.90, task_completed_percentage + 0.05),
                                                f"📤 Uploaded {new_uploads} file{'s' if new_uploads > 1 else ''} to cloud storage"
                                            ))
                                        except Exception:
                                            pass
                                # Handle direct format: {blob_name, download_url}
                                if "download_url" in json_content and "blob_name" in json_content:
                                    uploaded_file_urls[json_content["blob_name"]] = json_content["download_url"]
                                    # Progress update for single file upload
                                    try:
                                        asyncio.create_task(self.progress_tracker.set_transient_update(
                                            task_id,
                                            min(0.90, task_completed_percentage + 0.05),
                                            f"📤 Uploaded {json_content.get('blob_name', 'file')} to cloud storage"
                                        ))
                                    except Exception:
                                        pass
                                # collect external media from known keys
                                for k in ("images", "image_urls", "media", "videos", "thumbnails", "assets"):
                                    try:
                                        vals = json_content.get(k)
                                        if isinstance(vals, list):
                                            for v in vals:
                                                if isinstance(v, str) and v.startswith("http"):
                                                    external_media_urls.append(v)
                                        elif isinstance(vals, dict):
                                            for v in vals.values():
                                                if isinstance(v, str) and v.startswith("http"):
                                                    external_media_urls.append(v)
                                    except Exception:
                                        pass
                            elif isinstance(json_content, list):
                                for item in json_content:
                                    if isinstance(item, dict) and "download_url" in item and "blob_name" in item:
                                        uploaded_file_urls[item["blob_name"]] = item["download_url"]
                                    # look for url-like fields
                                    if isinstance(item, dict):
                                        for key in ("url", "image", "thumbnail", "video", "download_url"):
                                            try:
                                                val = item.get(key)
                                                if isinstance(val, str) and val.startswith("http"):
                                                    external_media_urls.append(val)
                                            except Exception:
                                                pass
                            # otherwise, ignore scalars like numbers/strings
                        except json.JSONDecodeError:
                            # best-effort regex scrape of http(s) URLs that look like media
                            try:
                                import re
                                for m in re.findall(r"https?://[^\s)\]}]+", content):
                                    if any(m.lower().endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov")):
                                        external_media_urls.append(m)
                            except Exception:
                                pass
                    
                    final_result_content.append(str(content))
                    # Enqueue progress update for background processing (non-blocking)
                    asyncio.create_task(self.handle_progress_update(task_id, task_completed_percentage, processed_content_for_progress, message.type, source))

            try:
                # Finalizing update (transient only)
                await self.progress_tracker.set_transient_update(task_id, 0.95, "✨ Finalizing your results...")
            except Exception:
                pass

            # No fallback file generation: if required assets are missing, allow termination to report inability
            except Exception:
                # Catch-all for the outer deliverables-referencing try block
                pass

            result_limited_to_fit = "\n".join(final_result_content)

            presenter_task = f"""
            Present the final task result to the user.

            TASK:
            {task}

            AGENT_WORK_COMPLETED:
            {result_limited_to_fit}

            WORK_DIRECTORY:
            {request_work_dir}

            Remember: Users cannot access local file paths. Upload any deliverable files to get SAS URLs, then present with those URLs.
            """
            
            # Add progress update for file upload/presentation phase
            try:
                await self.progress_tracker.set_transient_update(task_id, 0.92, "📤 Uploading deliverable files to cloud storage...")
            except Exception:
                pass

            # Run presenter with explicit tool call handling
            from autogen_core import CancellationToken
            from autogen_agentchat.messages import TextMessage
            from autogen_agentchat.base import Response

            text_result = None

            # Build initial messages
            conversation_messages = [TextMessage(source="user", content=presenter_task)]

            max_turns = 5
            for turn_num in range(max_turns):
                logger.info(f"🎭 PRESENTER TURN {turn_num + 1}/{max_turns}")

                # Update progress during presenter turns (file uploads happening)
                try:
                    if turn_num == 0:
                        await self.progress_tracker.set_transient_update(task_id, 0.94, "📤 Processing file uploads...")
                    elif turn_num == 1:
                        await self.progress_tracker.set_transient_update(task_id, 0.95, "🎨 Preparing final presentation...")
                except Exception:
                    pass

                try:
                    response: Response = await presenter_agent.on_messages(conversation_messages, CancellationToken())

                    if not response or not hasattr(response, 'chat_message'):
                        logger.warning(f"No response from presenter on turn {turn_num + 1}")
                        break

                    # Add the response to conversation
                    response_msg = response.chat_message
                    conversation_messages.append(response_msg)

                    # Check what type of response we got
                    has_function_calls = (hasattr(response_msg, 'content') and
                                         isinstance(response_msg.content, list) and
                                         any(hasattr(item, 'call_id') for item in response_msg.content if hasattr(item, 'call_id')))

                    # If it's a text response (not function calls)
                    if hasattr(response_msg, 'content') and isinstance(response_msg.content, str):
                        text_content = response_msg.content.strip()
                        # Make sure it's not just raw JSON from tool
                        if text_content and not text_content.startswith('```json') and not text_content.startswith('{"blob_name"'):
                            text_result = text_content
                            logger.info(f"✅ Got final presentation text ({len(text_result)} chars)")
                            break

                    # Don't manually add inner_messages - on_messages() handles tool execution internally
                    # Just continue to next turn which will process the tool results

                except Exception as e:
                    logger.error(f"Error in presenter turn {turn_num + 1}: {e}")
                    break

            if not text_result:
                logger.warning("⚠️ Presenter didn't generate final text after all turns")
                text_result = "Task completed. Please check uploaded files."

            # Auto-upload files marked as "Ready for upload" by code_executor
            uploaded_files = {}
            if presenter_agent and hasattr(presenter_agent, '_tools'):
                # Scan all conversation messages for "Ready for upload" markers
                for message in conversation_messages:
                    content = str(getattr(message, 'content', ''))
                    import re
                    upload_markers = re.findall(r'📁 Ready for upload: ([^\s]+)', content)
                    for file_path in upload_markers:
                        if file_path not in uploaded_files and os.path.exists(file_path):
                            try:
                                # Use the enhanced upload function directly
                                from tools.azure_blob_tools import upload_file_to_azure_blob
                                upload_result = upload_file_to_azure_blob(file_path)
                                parsed_result = json.loads(upload_result) if isinstance(upload_result, str) else upload_result
                                if 'sas_url' in parsed_result:
                                    uploaded_files[file_path] = parsed_result['sas_url']
                                    logger.info(f"✅ Auto-uploaded: {file_path} -> {parsed_result['sas_url']}")
                                else:
                                    logger.warning(f"❌ Upload failed for: {file_path} - {parsed_result}")
                            except Exception as e:
                                logger.error(f"❌ Upload error for {file_path}: {e}")

                if uploaded_files:
                    logger.info(f"📁 Auto-uploaded {len(uploaded_files)} files from code_executor output")

            # No post-sanitization here; enforce via presenter prompt only per user request

            logger.info(f"🔍 TASK RESULT:\n{text_result}")

            # Post-run analysis + indexing (best-effort, non-blocking on failure)
            try:
                metrics = collect_run_metrics(messages)
                errors = extract_errors(messages)
                # Build assets snapshot (redacted later in builder)
                assets = {
                    "uploaded_file_urls": dict(uploaded_file_urls) if isinstance(uploaded_file_urls, dict) else {},
                    "external_media_urls": list(external_media_urls) if isinstance(external_media_urls, list) else [],
                }
                # Summarize learnings via model
                combined_text = "\n".join([str(getattr(m, 'content', '')) for m in messages])
                err_text = "\n".join([e.get("message", "") for e in errors])
                best_text, anti_text = await summarize_learnings(redact(combined_text), err_text, self.gpt41_model_client)
                # Build external non-blob sources list for the playbook
                external_sources = []
                try:
                    for u in assets.get("external_media_urls") or []:
                        if isinstance(u, str) and "blob.core.windows.net" not in u.lower():
                            external_sources.append(u)
                except Exception:
                    pass
                # Ask LLM to produce an improvements playbook
                from services.run_analyzer import should_index_run, generate_improvement_playbook
                playbook = await generate_improvement_playbook(
                    messages_text=redact(combined_text),
                    errors=errors,
                    metrics=metrics,
                    external_sources=external_sources,
                    model_client=self.gpt41_model_client,
                )
                improvement_text = playbook.get("text") or ""
                actionables = int(playbook.get("actionables") or 0)
                improvement_score = int(playbook.get("improvement_score") or 0)
                planner_hints = playbook.get("hints") or []

                # Decide whether to index based on signal and playbook strength
                if should_index_run(metrics, errors, best_text + "\n" + anti_text, "", assets) and (improvement_score >= 50 or actionables >= 5 or metrics.get("toolCallCount", 0) or errors):
                    # Owner: prefer incoming task parameter (owner/request_owner), else omit
                    owner = getattr(self, "current_owner", None)
                    doc = build_run_document(
                        task_id=str(task_id or ""),
                        task_text=str(task_content or ""),
                        owner=owner,
                        models=None,
                        assets=assets,
                        metrics=metrics,
                        errors=errors,
                        improvement_text=improvement_text,
                        final_snippet=str(text_result or ""),
                    )
                    _ = upsert_run_rest(doc)
                else:
                    logger.info("[Search] Skipping indexing: low-signal run (no errors and generic learnings)")
            except Exception as e:
                logger.debug(f"Post-run indexing failed or skipped: {e}")

            # Publish final result
            final_data = text_result or "🎉 Your task is complete!"
            await self.progress_tracker.publish_progress(task_id, 1.0, "🎉 Your task is complete!", data=final_data)
            try:
                await self.progress_tracker.mark_final(task_id)
            except Exception:
                pass
            self.final_progress_sent = True
            return text_result
        except Exception as e:
            logger.error(f"❌ Error during process_task for {task_id}: {e}", exc_info=True)
            await self.publish_final(task_id, "❌ We hit an issue while working on your request. Processing has ended.")
            raise

    async def close(self):
        """Close all connections gracefully."""
        # Stop background progress worker first to avoid pending task destruction
        try:
            if self._progress_worker_task is not None:
                try:
                    self._progress_worker_task.cancel()
                    try:
                        await self._progress_worker_task
                    except asyncio.CancelledError:
                        pass
                finally:
                    self._progress_worker_task = None
            # Allow GC of the queue
            self._progress_queue = None
        except Exception as e:
            logger.debug(f"Error stopping progress worker: {e}")
        clients_to_close = [
            self.o3_model_client,
            self.o4_mini_model_client,
            self.gpt41_model_client
        ]

        for client in clients_to_close:
            model_name = "unknown_model"
            try:
                if hasattr(client, 'model'):
                    model_name = client.model
                elif hasattr(client, '__class__'):
                    model_name = client.__class__.__name__
            except Exception:
                pass
            
            try:
                logger.info(f"🔌 Attempting to close client session for {model_name}.")
                if client:
                    await client.close()
                logger.info(f"🔌 Successfully closed client session for {model_name}.")
            except Exception as e:
                logger.error(f"❌ Error closing client session for {model_name}: {e}")

        if self.progress_tracker:
            await self.progress_tracker.close()
            logger.info("🔌 Connections closed.")


async def process_queue_message(message_data: Dict[str, Any]) -> Optional[str]:
    """
    Process a single queue message and return the result.
    This is the main entry point for Azure Function App.
    """
    processor = TaskProcessor()
    try:
        task_id = message_data.get("id")
        await processor.initialize()
        
        raw_content = message_data.get("content") or message_data.get("message")

        if not raw_content:
            logger.error(f"❌ Message has no content: {message_data}")
            # Ensure terminal progress on empty content
            await processor.publish_final(task_id or "", "⚠️ Received an empty task. Processing has ended.")
            return None

        logger.debug(f"🔍 DEBUG: process_queue_message - Raw content received (first 100 chars): {raw_content[:100]}...")

        try:
            decoded_content = base64.b64decode(raw_content).decode('utf-8')
            task_data = json.loads(decoded_content)
            logger.debug(f"🔍 DEBUG: process_queue_message - Successfully base64 decoded and JSON parsed. Keys: {list(task_data.keys())}")
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            logger.debug(f"Base64 decode failed; falling back to raw JSON: {e}")
            try:
                task_data = json.loads(raw_content)
                logger.debug(f"🔍 DEBUG: process_queue_message - Successfully JSON parsed raw content. Keys: {list(task_data.keys())}")
            except json.JSONDecodeError as e2:
                logger.error(f"❌ Failed to parse message content as JSON after both attempts for message ID {task_id}: {e2}", exc_info=True)
                await processor.publish_final(task_id or "", "❌ Invalid task format received. Processing has ended.")
                return None

        # capture optional owner from message payload
        try:
            possible_owner = task_data.get("owner") or task_data.get("request_owner") or task_data.get("user")
        except Exception:
            possible_owner = None
        if possible_owner:
            processor.current_owner = str(possible_owner)

        task_content = task_data.get("message") or task_data.get("content")
        if not task_content:
            logger.error(f"❌ No valid task content (key 'message' or 'content') found in parsed data for message ID {task_id}: {task_data}")
            await processor.publish_final(task_id or "", "⚠️ No actionable task content found. Processing has ended.")
            return None

        logger.debug(f"🔍 DEBUG: process_queue_message - Extracted task_content: {task_content}...")
        logger.info(f"📩 Processing task: {task_content}...")
        
        result = await processor.process_task(task_id, task_content)
        return result
        
    except Exception as e:
        logger.error(f"❌ Error processing task: {e}", exc_info=True)
        # Try to ensure a final progress is published even if initialization or processing failed
        try:
            if processor.progress_tracker is None:
                processor.progress_tracker = await get_redis_publisher()
            await processor.publish_final(message_data.get("id") or "", "❌ Task ended due to an unexpected error.")
        except Exception as publish_error:
            logger.error(f"❌ Failed to publish final error progress in exception handler: {publish_error}")
        raise
    finally:
        await processor.close() 