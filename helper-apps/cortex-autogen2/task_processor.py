import asyncio
import json
import base64
import logging
import os
from typing import Optional, Dict, Any, List
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import ModelInfo # Import ModelInfo
from autogen_agentchat.teams import SelectorGroupChat
from autogen_core.models import UserMessage
from autogen_agentchat.conditions import TextMentionTermination, HandoffTermination
from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
from agents import get_agents
from tools.azure_blob_tools import upload_file_to_azure_blob

logger = logging.getLogger(__name__)


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
        o3_model_info = ModelInfo(model="o3", name="Cortex o3", max_tokens=8192, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) # Placeholder cost
        o4_mini_model_info = ModelInfo(model="o4-mini", name="Cortex o4-mini", max_tokens=128000, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) # Placeholder cost
        gpt41_model_info = ModelInfo(model="gpt-4.1", name="Cortex gpt-4.1", max_tokens=8192, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) # Placeholder cost

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
            
            prompt = f"""Write a single fun-professional, engaging progress update (7–14 words) that clearly says what’s happening now. Start with a role-appropriate emoji.

Context: This is for a user-facing progress indicator in a React app.

Current Activity: {cleaned_content}
Agent Source: {source if source else "Unknown"}

Sample Emojis (use first that fits): 🧭, 🗺️, 📝, 💻, 🛠️, 🧪, 🔎, 🌐, 🧠, 📚,🗃️, 📊, 🎨, 📣, 🖼️, 🏁

Style Requirements:
- Positive, succinct, and user-benefit oriented; no jargon.
- Use a strong verb + concrete noun (e.g., “Analyzing sales trends”, “Uploading charts”).
- Focus strictly on the current action (no next-step hints).
- Vary phrasing naturally (avoid repeating the same template).
- One line only. No quotes. No code/tool names.

Good examples:
- "🔎 Researching sources for your brief"
- "📊 Analyzing time-series data"
- "🎨 Crafting visuals for your report"
- "☁️ Uploading deliverables"
- "💻 Refining code for accuracy"

Bad examples (avoid):
- Task terminated
- Processing internal data
- Executing tool calls
- TERMINATE

Return only the update line, nothing else:"""
            
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
            "presenter_agent", "file_cloud_uploader_agent", "aj_sql_agent",
            "aj_article_writer_agent", "cognitive_search_agent", "web_search_agent"
        }
        # If the entire content is just a role name, treat as internal
        if text in role_names:
            return True
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

            # Send initial progress update (transient only)
            await self.progress_tracker.set_transient_update(task_id, 0.05, "🚀 Starting your task...")

            termination = HandoffTermination(target="user") | TextMentionTermination("TERMINATE")

            agents, presenter_agent, terminator_agent = await get_agents(
                self.gpt41_model_client,
                self.o3_model_client,
                self.gpt41_model_client
            )

            team = SelectorGroupChat(
                participants=agents,
                model_client=self.gpt41_model_client,
                termination_condition=termination,
                max_turns=200
            )

            messages = []
            uploaded_file_urls = {}
            external_media_urls: List[str] = []
            final_result_content = []

            detailed_task = f"""
            Accomplish and present your task to the user in a great way, Markdown, it ll be shown in a React app that supports markdown.
            Task: 
            {task}
            """

            stream = team.run_stream(task=task)
            async for message in stream:
                messages.append(message)
                source = message.source if hasattr(message, 'source') else None
                content = message.content if hasattr(message, 'content') else None 
                created_at = message.created_at if hasattr(message, 'created_at') else None
                logger.info(f"\n\n#SOURCE: {source}\n#CONTENT: {content}\n#CREATED_AT: {created_at}\n")
                
                task_completed_percentage += 0.01
                if task_completed_percentage >= 1.0:
                    task_completed_percentage = 0.99
                    
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
                                if "download_url" in json_content and "blob_name" in json_content:
                                    uploaded_file_urls[json_content["blob_name"]] = json_content["download_url"]
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

            # Targeted auto-upload: if no URLs yet, opportunistically upload recent deliverables created in this run.
            # Fast, non-recursive, and limited to known dirs and extensions.
            try:
                if not uploaded_file_urls:
                    import time
                    now = time.time()
                    max_age_seconds = 15 * 60  # last 15 minutes
                    deliverable_exts = {".pptx", ".ppt", ".csv", ".png", ".jpg", ".jpeg", ".pdf", ".zip"}
                    candidate_dirs: List[str] = []
                    try:
                        wd = os.getenv("CORTEX_WORK_DIR", "/tmp/coding")
                        # In Azure Functions, prefer /tmp for write access
                        if os.getenv("WEBSITE_INSTANCE_ID") and wd.startswith("/app/"):
                            wd = "/tmp/coding"
                        candidate_dirs.append(wd)
                    except Exception:
                        pass
                    candidate_dirs.append("/tmp/coding")

                    recent_files: List[str] = []
                    for d in candidate_dirs:
                        if not d:
                            continue
                        # Ensure directory exists if possible
                        try:
                            os.makedirs(d, exist_ok=True)
                        except Exception:
                            pass
                        if not os.path.isdir(d):
                            continue
                        try:
                            for name in os.listdir(d):
                                fp = os.path.join(d, name)
                                if not os.path.isfile(fp):
                                    continue
                                _, ext = os.path.splitext(name)
                                if ext.lower() not in deliverable_exts:
                                    continue
                                try:
                                    mtime = os.path.getmtime(fp)
                                    if now - mtime <= max_age_seconds:
                                        recent_files.append(fp)
                                except Exception:
                                    continue
                        except Exception:
                            continue

                    # Sort newest first and cap to a few uploads to keep fast
                    recent_files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
                    recent_files = recent_files[:5]

                    for fp in recent_files:
                        try:
                            up_json = upload_file_to_azure_blob(fp, blob_name=None)
                            up = json.loads(up_json)
                            if "download_url" in up and "blob_name" in up:
                                uploaded_file_urls[up["blob_name"]] = up["download_url"]
                        except Exception:
                            continue
            except Exception:
                pass

            # Deduplicate uploaded_file_urls by base filename (keep latest by timestamp) and by URL to avoid duplicates
            try:
                import re
                # First pass: group by base name without the autogenerated __TIMESTAMP_HASH suffix
                groups = {}
                pattern = re.compile(r"^(?P<base>.+?)__(?P<ts>\d{8}T\d{6}Z)_(?P<hash>[0-9a-f]{8})(?P<ext>\.[A-Za-z0-9]+)?$")
                for blob, url in uploaded_file_urls.items():
                    m = pattern.match(blob)
                    if m:
                        base_key = (m.group('base') + (m.group('ext') or '')).lower()
                        ts = m.group('ts')
                    else:
                        base_key = blob.lower()
                        ts = ""
                    keep = groups.get(base_key)
                    if not keep:
                        groups[base_key] = {"blob": blob, "url": url, "ts": ts}
                    else:
                        # Prefer newer timestamp if available; else prefer the latter entry
                        if ts and keep.get("ts") and ts > keep.get("ts"):
                            groups[base_key] = {"blob": blob, "url": url, "ts": ts}
                        elif ts and not keep.get("ts"):
                            groups[base_key] = {"blob": blob, "url": url, "ts": ts}
                        else:
                            # keep existing
                            pass
                # Second pass: remove duplicates by identical URL
                seen_urls = set()
                dedup_map = {}
                for entry in groups.values():
                    blob = entry["blob"]
                    url = entry["url"]
                    if url in seen_urls:
                        continue
                    dedup_map[blob] = url
                    seen_urls.add(url)
                uploaded_file_urls = dedup_map
            except Exception:
                pass

            # Deduplicate and cap external media to a reasonable number
            try:
                dedup_media = []
                seen = set()
                for u in external_media_urls:
                    if u in seen:
                        continue
                    seen.add(u)
                    dedup_media.append(u)
                external_media_urls = dedup_media[:24]
            except Exception:
                pass

            result_limited_to_fit = "\n".join(final_result_content)

            presenter_task = f"""
            Present the task result in a clean, professional Markdown/HTML that contains ONLY what the task requested. This will be shown in a React app.
            Use only the information provided.

            TASK:
            {task}

            RAW_AGENT_COMMUNICATIONS:
            {result_limited_to_fit}

            UPLOADED_FILES_SAS_URLS:
            {json.dumps(uploaded_file_urls, indent=2)}

            EXTERNAL_MEDIA_URLS:
            {json.dumps(external_media_urls, indent=2)}

            STRICT OUTPUT RULES:
            - If a file was created, list only the real download URL(s) from UPLOADED_FILES_SAS_URLS.
            - You MAY include images and videos from EXTERNAL_MEDIA_URLS. Place them thoughtfully with captions.
            - SINGLE media: wrap in <figure style=\"margin: 12px 0;\"> with <img style=\"display:block;width:100%;max-width:960px;height:auto;margin:0 auto;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.12)\"> and a <figcaption style=\"margin-top:8px;font-size:0.92em;color:inherit;opacity:0.8;text-align:center;\">.
            - MULTIPLE media: use <div style=\"display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:stretch;justify-items:stretch;\"> and child <figure style=\"margin:0;width:100%;\"> with <img style=\"display:block;width:100%;max-width:100%;height:auto;object-fit:contain;border-radius:8px;\">.
            - Avoid framework classes in HTML; rely on inline styles only. Do NOT include any class attributes. Use color: inherit for captions to respect dark/light mode.
            - Never fabricate URLs, images, or content; use only links from UPLOADED_FILES_SAS_URLS or EXTERNAL_MEDIA_URLS.
            - Present each uploaded file ONCE only (no duplicate links), using its filename as the link text.
            - For links, prefer HTML anchor tags: <a href=\"URL\" target=\"_blank\" rel=\"noopener noreferrer\">FILENAME</a>. For common file types (pdf, pptx, csv, png, jpg, jpeg), include the download attribute: <a href=\"URL\" target=\"_blank\" rel=\"noopener noreferrer\" download>FILENAME</a>.
            - Do NOT include code, tool usage, or internal logs.
            - Be detailed and user-facing. Include Overview, Visuals, Key Takeaways, and Downloads sections when applicable.
            """
            
            presenter_stream = presenter_agent.run_stream(task=presenter_task)
            presenter_messages = []
            async for message in presenter_stream:
                logger.info(f"#PRESENTER MESSAGE: {message.content if hasattr(message, 'content') else ''}")
                presenter_messages.append(message)

            task_result = presenter_messages[-1]
            last_message = task_result.messages[-1]
            text_result = last_message.content if hasattr(last_message, 'content') else None

            # Safety checks: allow only links in UPLOADED_FILES_SAS_URLS or EXTERNAL_MEDIA_URLS
            try:
                import re
                if isinstance(text_result, str):
                    # Normalize presenter HTML to ensure images/galleries fill available width and no classes leak in
                    try:
                        from bs4 import BeautifulSoup  # available in requirements
                        def _normalize_presenter_html(html: str) -> str:
                            soup = BeautifulSoup(html, 'html.parser')
                            # Drop all class attributes to avoid external CSS interference
                            for el in soup.find_all(True):
                                if 'class' in el.attrs:
                                    del el.attrs['class']
                            # Normalize gallery containers
                            for div in soup.find_all('div'):
                                style = div.get('style', '')
                                if 'display:grid' in style or 'grid-template-columns' in style:
                                    # enforce our gallery grid styles
                                    div['style'] = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:stretch;justify-items:stretch;'
                            # Normalize figures
                            for fig in soup.find_all('figure'):
                                base = 'margin:0;width:100%;'
                                style = fig.get('style', '')
                                fig['style'] = base if not style else base
                            # Normalize captions
                            for cap in soup.find_all('figcaption'):
                                cap['style'] = 'margin-top:8px;font-size:0.92em;color:inherit;opacity:0.8;text-align:center;'
                            # Normalize images
                            for img in soup.find_all('img'):
                                img['style'] = 'display:block;width:100%;max-width:100%;height:auto;object-fit:contain;background:transparent;border:none;outline:none;border-radius:8px;'
                                # Remove width/height attributes that can force tiny images
                                if 'width' in img.attrs:
                                    del img.attrs['width']
                                if 'height' in img.attrs:
                                    del img.attrs['height']
                            return str(soup)
                        text_result = _normalize_presenter_html(text_result)
                    except Exception:
                        # Fallback: regex-based minimal normalization
                        text_result = re.sub(r'\sclass=\"[^\"]*\"', '', text_result)
                        # Force img to full width
                        def _img_style_repl(m):
                            before, attrs = m.group(1), m.group(2) or ''
                            # drop width/height attrs
                            attrs = re.sub(r'\s(width|height)=\"[^\"]*\"', '', attrs)
                            # replace/append style
                            if 'style=' in attrs:
                                attrs = re.sub(r'style=\"[^\"]*\"', 'style="display:block;width:100%;max-width:100%;height:auto;object-fit:contain;border-radius:8px;"', attrs)
                            else:
                                attrs += ' style="display:block;width:100%;max-width:100%;height:auto;object-fit:contain;border-radius:8px;"'
                            return f"<img{attrs}>"
                        text_result = re.sub(r'<img(\s[^>]*)?>', _img_style_repl, text_result)
                    allowed_urls = set(uploaded_file_urls.values()) | set(external_media_urls)
                    def repl(m):
                        url = m.group(1)
                        return f"({url})" if url in allowed_urls else "(Download not available)"
                    text_result = re.sub(r"\((https?://[^)]+)\)", repl, text_result)
            except Exception:
                pass

            logger.info(f"🔍 TASK RESULT:\n{text_result}")

            # Run terminator agent once presenter has produced final text
            try:
                term_messages = []
                term_task = f"""
                Check if the task is completed and output TERMINATE if and only if done.
                Latest presenter output:
                {text_result}

                Uploaded files (SAS URLs):
                {json.dumps(uploaded_file_urls, indent=2)}

                TASK:
                {task}

                Reminder:
                - If the TASK explicitly requires downloadable files, ensure at least one clickable download URL is present.
                - If the TASK does not require files (e.g., simple answer, calculation, summary, troubleshooting), terminate when the presenter has clearly delivered the requested content. Do not require downloads in that case.
                """
                term_stream = terminator_agent.run_stream(task=term_task)
                async for message in term_stream:
                    term_messages.append(message)
                if term_messages:
                    t_last = term_messages[-1].messages[-1]
                    t_text = t_last.content if hasattr(t_last, 'content') else ''
                    logger.info(f"🛑 TERMINATOR: {t_text}")
                    # If it didn't say TERMINATE but we already have presenter output, proceed anyway
            except Exception as e:
                logger.warning(f"⚠️ Terminator agent failed or unavailable: {e}")
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
            logger.warning(f"⚠️ Failed to decode as base64, trying as raw JSON: {e}")
            try:
                task_data = json.loads(raw_content)
                logger.debug(f"🔍 DEBUG: process_queue_message - Successfully JSON parsed raw content. Keys: {list(task_data.keys())}")
            except json.JSONDecodeError as e2:
                logger.error(f"❌ Failed to parse message content as JSON after both attempts for message ID {task_id}: {e2}", exc_info=True)
                await processor.publish_final(task_id or "", "❌ Invalid task format received. Processing has ended.")
                return None

        task_content = task_data.get("message") or task_data.get("content")
        if not task_content:
            logger.error(f"❌ No valid task content (key 'message' or 'content') found in parsed data for message ID {task_id}: {task_data}")
            await processor.publish_final(task_id or "", "⚠️ No actionable task content found. Processing has ended.")
            return None

        logger.debug(f"🔍 DEBUG: process_queue_message - Extracted task_content (first 100 chars): {task_content[:100]}...")
        logger.info(f"📩 Processing task: {task_content[:100]}...")
        
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