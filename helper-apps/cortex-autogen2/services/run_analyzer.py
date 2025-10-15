import re
import os
import json
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from autogen_core.models import UserMessage


MASK = "***"
DEFAULT_KEY_PHRASE = "Validate environment and paths early"


def _truncate(text: Optional[str], limit: int = 2000) -> str:
    if not text:
        return ""
    t = str(text)
    if len(t) <= limit:
        return t
    return t[:limit] + "\n... [truncated]"


def redact(text: Optional[str]) -> str:
    """
    Redact tokens, SAS query params, and bearer headers from the given text.
    Keeps general readability while removing secrets.
    """
    if not text:
        return ""
    s = str(text)
    # Mask Authorization Bearer tokens
    s = re.sub(r"(?i)(authorization\s*:\s*bearer\s+)([^\s]+)", rf"\1{MASK}", s)
    # Mask common SAS params 'sig' and 'se'
    s = re.sub(r"(?i)([?&]sig=)([^&\s]+)", rf"\1{MASK}", s)
    s = re.sub(r"(?i)([?&]se=)([^&\s]+)", rf"\1{MASK}", s)
    # Collapse long base64-like runs
    s = re.sub(r"([A-Za-z0-9+/]{64,}={0,2})", MASK, s)
    return s


def collect_run_metrics(messages: List[Any]) -> Dict[str, Any]:
    turns = len(messages or [])
    tool_calls = 0
    error_mentions = 0
    schema_err_mentions = 0

    for idx, m in enumerate(messages or []):
        try:
            mtype = getattr(m, "type", None)
            content = getattr(m, "content", None)
            text = str(content) if content is not None else ""
            if mtype == "ToolCallExecutionEvent":
                tool_calls += 1
            low = text.lower()
            if any(x in low for x in ("error", "exception", "traceback", "task not completed")):
                error_mentions += 1
            if ("tool_calls" in text) and ("MultiMessage" in text):
                schema_err_mentions += 1
        except Exception:
            continue

    return {
        "turnCount": turns,
        "toolCallCount": tool_calls,
        "errorMentions": error_mentions,
        "schemaErrorMentions": schema_err_mentions,
    }


def extract_errors(messages: List[Any]) -> List[Dict[str, Any]]:
    """
    Extract concrete error signals from the stream with strict filtering to avoid advice-like lines.
    Includes:
    - Tool execution errors (ToolCallExecutionEvent items flagged is_error)
    - Python/stack traces and typical 'Error:'/'Exception:' lines
    - Explicit 'TASK NOT COMPLETED:' markers
    Excludes:
    - Advice like 'include error handling', 'no errors', etc.
    """
    def classify_error_line(line: str) -> Optional[str]:
        s = (line or "").strip()
        if not s:
            return None
        low = s.lower()
        # Exclusions: advisory phrases
        if any(p in low for p in ["error handling", "handle errors", "no errors", "without errors", "few errors", "low error"]):
            return None
        # Strong markers
        if "task not completed" in low:
            return "termination"
        if "traceback (most recent call last)" in low:
            return "traceback"
        # Common error prefixes or exception class names
        if re.search(r"^(\s*(error|exception)\b|[A-Za-z]+Error:|[A-Za-z]+Exception:)", s, re.IGNORECASE):
            return "runtime"
        # Generic lines that merely include the word 'error' are ignored
        return None

    results: List[Dict[str, Any]] = []
    seen: set = set()

    for idx, m in enumerate(messages or []):
        try:
            src = getattr(m, "source", None)
            created_at = getattr(m, "created_at", None)

            # 1) Tool execution errors with is_error flag
            mtype = getattr(m, "type", None)
            if mtype == "ToolCallExecutionEvent" and hasattr(m, "content") and isinstance(getattr(m, "content"), list):
                try:
                    for res in getattr(m, "content"):
                        try:
                            if hasattr(res, "is_error") and getattr(res, "is_error"):
                                msg = _truncate(redact(str(getattr(res, "content", "") or "")), 512)
                                low = msg.lower()
                                key = (low[:120], src)
                                if key in seen:
                                    continue
                                seen.add(key)
                                results.append({
                                    "type": "tool_error",
                                    "message": msg,
                                    "source": src or "unknown",
                                    "firstSeenIndex": idx,
                                    "createdAt": str(created_at) if created_at else None,
                                })
                        except Exception:
                            continue
                except Exception:
                    pass

            # 2) Parse textual lines for strong error markers
            content = getattr(m, "content", None)
            text = str(content) if content is not None else ""
            for line in (text.splitlines() if text else []):
                kind = classify_error_line(line)
                if not kind:
                    continue
                msg = _truncate(redact(line.strip()), 512)
                low = msg.lower()
                key = (low[:120], src)
                if key in seen:
                    continue
                seen.add(key)
                # Capture specific dependency/image/source hints for reuse
                entry = {
                    "type": kind,
                    "message": msg,
                    "source": src or "unknown",
                    "firstSeenIndex": idx,
                    "createdAt": str(created_at) if created_at else None,
                }
                # Categories intentionally not assigned; rely on LLM to infer lessons
                results.append(entry)
        except Exception:
            continue

    return results


async def summarize_learnings(messages_text: str, errors_text: str, model_client) -> Tuple[str, str]:
    """
    Return (best_practices_text, antipatterns_text) using the LLM; avoid static heuristics.
    """
    try:
        prompt = f"""
You are a senior reliability engineer extracting high-value, reusable lessons from an agent transcript.

Task: Produce two sections with concise bullets (≤18 words each):
1) BEST PRACTICES (5–10 bullets): concrete, repeatable actions that prevent failures and speed future runs
2) ANTIPATTERNS (5 bullets): mistakes to avoid

Rules:
- No secrets or environment-specific values
- Prefer actionable checks (dependency preflight, schema validation), robust fallbacks, and proven fast paths
- Reflect image acquisition pitfalls (network blocks, non-image payloads, licensing) if present

TRANSCRIPT (redacted):
{_truncate(messages_text, 6000)}

ERROR EXCERPTS:
{_truncate(errors_text, 2000)}

Output format exactly:
BEST PRACTICES:
- ...
- ...
ANTIPATTERNS:
- ...
- ...
"""
        msgs = [UserMessage(content=prompt, source="run_analyzer_summarize")]
        resp = await model_client.create(messages=msgs)
        text = (resp.content or "").strip()
        best = []
        anti = []
        section = None
        for line in text.splitlines():
            t = line.strip()
            if not t:
                continue
            u = t.upper()
            if u.startswith("BEST PRACTICES"):
                section = "best"
                continue
            if u.startswith("ANTIPATTERNS"):
                section = "anti"
                continue
            if t.startswith("-"):
                if section == "best":
                    best.append(t)
                elif section == "anti":
                    anti.append(t)
        return ("\n".join(best[:10]), "\n".join(anti[:10]))
    except Exception:
        return ("", "")


async def generate_improvement_playbook(
    messages_text: str,
    errors: List[Dict[str, Any]],
    metrics: Dict[str, Any],
    external_sources: Optional[List[str]],
    model_client,
) -> Dict[str, Any]:
    """
    Ask the LLM to produce a compact, high-signal "Improvements Playbook" for future runs.
    Returns dict: { text: str, actionables: int, improvement_score: int, has_failures: bool }
    """
    try:
        if not model_client:
            return {
                "text": (
                    "IMPROVEMENTS PLAYBOOK\n\n"
                    "Key Failures & Fixes:\n- None observed.\n\n"
                    "Proven Source Patterns:\n- Prefer authoritative sites; record source URLs explicitly.\n\n"
                    "Effective Patterns:\n- Validate required data structures before main logic.\n- Use absolute paths; print/log key steps.\n\n"
                    "Reliability:\n- Retry downloads 3x with backoff; cache downloaded assets.\n\n"
                    "Guardrails:\n- Terminate gracefully on missing dependencies and report clear remediation.\n\n"
                    "Next-Time Plan Outline:\n1) Verify dependencies\n2) Validate inputs\n3) Fetch assets with retries\n4) Assemble\n5) Upload & present\n"
                ),
                "actionables": 6,
                "improvement_score": 60,
                "has_failures": bool(errors),
            }

        err_lines = []
        for e in (errors or [])[:30]:
            try:
                err_lines.append(f"- [{e.get('source','?')}] {e.get('message','')}")
            except Exception:
                continue
        err_block = "\n".join(err_lines)
        src_block = "\n".join([s for s in (external_sources or []) if isinstance(s, str)])
        prompt = f"""
You are optimizing a multi-agent system. Create a compact, high-signal Improvements Playbook strictly for future runs.

GOAL: Document only reusable improvements and concrete fixes that will materially improve similar tasks next time. Avoid generic advice.

INPUT METRICS (json):
{json.dumps(metrics, indent=2)}

CONCRETE FAILURES:
{_truncate(err_block, 1800)}

KNOWN EXTERNAL SOURCES (non-blob):
{_truncate(src_block, 1200)}

CONVERSATION EXCERPTS (redacted):
{_truncate(messages_text, 6000)}

OUTPUT FORMAT (exact headings, concise bullets ≤18 words each):
IMPROVEMENTS PLAYBOOK

Key Failures & Fixes:
- ...

Proven Source Patterns:
- ...

Effective Tool/Code Patterns:
- ...

Reliability (retries, rate-limit, caching):
- ...

Guardrails & Preconditions:
- ...

Next-Time Plan Outline:
1) ...
2) ...
3) ...

Image Acquisition Failure Taxonomy (when URLs valid but not usable):
- Network/HTTP: 403/404/429, timeouts, SSL/captcha blocks
- Format/Integrity: Content-Type mismatch, non-image payload, Pillow .verify() fails
- License/Robots: disallowed scraping or reuse; fallback and record reason
- Mitigations: HEAD check; user-agent; backoff; alternate domain; sprite/fallback pack; manifest notes

IMPROVEMENT SCORE: <0-100>
ACTIONABLES: <integer count of distinct concrete actions>
"""
        msgs = [UserMessage(content=prompt, source="run_analyzer_improvements")]
        resp = await model_client.create(messages=msgs)
        text = (resp.content or "").strip()

        # Parse score and actionables
        score = 0
        actionables = 0
        try:
            m = re.search(r"IMPROVEMENT\s*SCORE\s*:\s*(\d{1,3})", text, re.IGNORECASE)
            if m:
                score = max(0, min(100, int(m.group(1))))
        except Exception:
            pass
        try:
            m2 = re.search(r"ACTIONABLES\s*:\s*(\d+)", text, re.IGNORECASE)
            if m2:
                actionables = max(0, int(m2.group(1)))
        except Exception:
            # Fallback: count bullets
            actionables = _count_bullets(text)

        # Build structured quick-reference hints for planner reuse next time
        hints: List[str] = []
        tlow = text.lower()
        if any(k in tlow for k in ["no module named", "importerror", "cannot import"]):
            hints.append("Preflight: import python-pptx, Pillow; pip install if import fails")
        if any(k in tlow for k in ["categorychartdata", "radarchart", "bar chart data"]):
            hints.append("Use python-pptx CategoryChartData; avoid RadarChartData (unsupported)")
        if any(k in tlow for k in ["antialias", "resampling.lanczos"]):
            hints.append("Pillow: use Image.Resampling.LANCZOS instead of ANTIALIAS")
        if any(k in tlow for k in ["cannot identify image file", "head request", "license"]):
            hints.append("Validate image URLs via HEAD; Pillow .verify(); ensure license before embed")

        return {
            "text": text,
            "actionables": actionables if actionables > 0 else _count_bullets(text),
            "improvement_score": score,
            "has_failures": bool(errors),
            "hints": hints,
        }
    except Exception:
        return {
            "text": "IMPROVEMENTS PLAYBOOK\n\nKey Failures & Fixes:\n- None parsed due to summarizer error.",
            "actionables": 0,
            "improvement_score": 0,
            "has_failures": bool(errors),
        }


def build_run_document(
    task_id: str,
    task_text: str,
    owner: Optional[str],
    models: Optional[Dict[str, Any]],
    assets: Optional[Dict[str, Any]],
    metrics: Dict[str, Any],
    errors: List[Dict[str, Any]],
    improvement_text: str,
    final_snippet: str,
) -> Dict[str, Any]:
    now_iso = datetime.utcnow().isoformat() + "Z"

    # Build sectioned content text (single string field for index)
    parts: List[str] = []
    parts.append("Metrics:\n" + _truncate(json.dumps(metrics, indent=2), 1200))
    if errors:
        err_lines = []
        for e in errors[:20]:
            try:
                err_lines.append(f"- [{e.get('source','?')}] {e.get('message','')}")
            except Exception:
                continue
        parts.append("Errors:\n" + "\n".join(err_lines))
    if improvement_text:
        parts.append("Improvements Playbook:\n" + improvement_text)
        # Extract high-signal tags for future retrieval and reuse
        try:
            tags: List[str] = []
            tlow = improvement_text.lower()
            if any(k in tlow for k in ["no module named", "importerror", "cannot import"]):
                tags.append("dependency")
            if any(k in tlow for k in ["image", "png", "jpg", "jpeg", "webp", "cannot identify image file", "head request", "license"]):
                tags.append("image")
            if any(k in tlow for k in ["pptx", "categorychartdata", "radarchart", "antialias", "resampling.lanczos"]):
                tags.append("pptx_api")
            if tags:
                parts.append("Tags:\n" + ", ".join(sorted(set(tags))))
        except Exception:
            pass
    if final_snippet:
        parts.append("Final Output Snippet:\n" + _truncate(redact(final_snippet), 2000))
    # Include external source URLs (not SAS) for provenance; exclude Azure blob SAS links
    try:
        if assets and isinstance(assets, dict):
            raw_sources = []
            try:
                raw_sources.extend(list(assets.get("external_media_urls") or []))
            except Exception:
                pass
            def _is_azure_blob(url: str) -> bool:
                try:
                    return "blob.core.windows.net" in (url or "").lower()
                except Exception:
                    return False
            srcs = []
            seen = set()
            for u in raw_sources:
                if not isinstance(u, str):
                    continue
                if _is_azure_blob(u):
                    continue
                if u in seen:
                    continue
                seen.add(u)
                srcs.append(u)
            if srcs:
                parts.append("Sources:\n" + _truncate("\n".join(srcs[:24]), 2000))
    except Exception:
        pass

    content_blob = "\n\n".join(parts)

    doc = {
        "id": task_id,
        "date": now_iso,
        "task": _truncate(redact(task_text), 4000),
        "content": content_blob,
        "requestId": task_id,
    }
    # Include owner only if provided
    if owner:
        doc["owner"] = owner
    return doc


async def summarize_prior_learnings(similar_docs: List[Dict[str, Any]], model_client) -> str:
    """
    Build <=8 fast-path directives from prior docs aimed at minimizing steps next time.
    Preference order: Improvements Playbook sections; fallback to Best Practices/Antipatterns.
    Output: short bullets (≤18 words) that can be directly embedded into planning as constraints.
    """
    # Extract bullets from prior content
    bullets: List[str] = []
    for d in similar_docs or []:
        try:
            content = str(d.get("content") or "")
            if not content:
                continue
            # Prefer fast-path sections from Improvements Playbook
            sections = [
                "Key Failures & Fixes:",
                "Effective Tool/Code Patterns:",
                "Reliability (retries, rate-limit, caching):",
                "Guardrails & Preconditions:",
                "Next-Time Plan Outline:",
            ]
            extracted = False
            for section in sections:
                idx = content.find(section)
                if idx >= 0:
                    seg = content[idx:].split("\n\n", 1)[0]
                    for line in seg.splitlines()[1:]:
                        t = line.strip()
                        if not t:
                            continue
                        if t[0].isdigit() and (t[1:2] == ")" or t[1:2] == "."):
                            t = "- " + t
                        if t.startswith("-") and len(t) > 2:
                            bullets.append(t)
                            extracted = True
            if not extracted:
                # Fallback: Best Practices / Antipatterns
                for section in ("Best Practices:", "Antipatterns:"):
                    idx = content.find(section)
                    if idx >= 0:
                        seg = content[idx:].split("\n\n", 1)[0]
                        for line in seg.splitlines()[1:]:
                            t = line.strip()
                            if t.startswith("-") and len(t) > 2:
                                bullets.append(t)
        except Exception:
            continue

    # Fallback: take first lines of content
    if not bullets:
        for d in similar_docs or []:
            try:
                for line in str(d.get("content") or "").splitlines():
                    t = line.strip()
                    if t.startswith("-") and len(t) > 2:
                        bullets.append(t)
                        if len(bullets) >= 12:
                            break
                if len(bullets) >= 12:
                    break
            except Exception:
                continue

    # Summarize into ≤8 concise, step-minimizing directives
    if model_client and bullets:
        try:
            prompt = f"""
Condense these prior lessons into 5-8 FAST-PATH DIRECTIVES (≤18 words each) to minimize steps next time.
Focus on dependency preflight, known API substitutions, asset/download validation, and deliverables verification.
Avoid secrets and environment-specific details.

LESSONS:
{chr(10).join(bullets[:40])}

Output bullets only (no headings):
- ...
- ...
"""
            msgs = [UserMessage(content=prompt, source="run_analyzer_prior")]
            resp = await model_client.create(messages=msgs)
            text = (resp.content or "").strip()
            # Keep only bullet lines
            out_lines = [ln for ln in text.splitlines() if ln.strip().startswith("-")]
            if out_lines:
                return "\n".join(out_lines[:8])
        except Exception:
            pass

    # No model or failure: return first up to 8 bullets
    uniq = []
    seen = set()
    for b in bullets:
        if b not in seen:
            uniq.append(b)
            seen.add(b)
        if len(uniq) >= 8:
            break
    if not uniq:
        uniq = [
            "- Validate environment and paths early",
            "- Log outputs and errors concisely",
            "- Use absolute paths and avoid placeholders",
            "- Avoid repeating failed steps",
            "- Upload deliverables once, then reference URLs",
        ]
    return "\n".join(uniq)


def _count_bullets(text: Optional[str]) -> int:
    try:
        return sum(1 for ln in (text or "").splitlines() if ln.strip().startswith("-"))
    except Exception:
        return 0


def should_index_run(metrics: Dict[str, Any], errors: List[Dict[str, Any]], best_practices_text: str, antipatterns_text: str, assets: Optional[Dict[str, Any]] = None) -> bool:
    """
    Decide whether to index the run based on signal heuristics:
    - Index if we observed any errors or schema issues
    - Index if tools/assets were used (useful operational trace)
    - Index if there is substantial learnings content (>=7 bullets) and conversation had enough depth
    - Otherwise skip to avoid noise
    """
    try:
        # Any explicit errors/schema problems → index
        if errors and len(errors) > 0:
            return True
        if int(metrics.get("schemaErrorMentions") or 0) > 0:
            return True

        # Tools used or assets produced are valuable to index
        if int(metrics.get("toolCallCount") or 0) > 0:
            return True
        if assets:
            try:
                up_count = len(assets.get("uploaded_file_urls") or {})
                media_count = len(assets.get("external_media_urls") or [])
                if (up_count + media_count) > 0:
                    return True
            except Exception:
                pass

        # Content-only heuristic: require many actionable bullets and sufficient turns
        total_bullets = _count_bullets(best_practices_text) + _count_bullets(antipatterns_text)
        turns = int(metrics.get("turnCount") or 0)
        if total_bullets >= 7 and turns >= 12:
            text_combined = f"{best_practices_text}\n{antipatterns_text}".lower()
            looks_generic = DEFAULT_KEY_PHRASE.lower() in text_combined
            return not looks_generic

        return False
    except Exception:
        # On analyzer failure, be conservative and skip
        return False


