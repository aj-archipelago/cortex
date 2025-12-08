"""
Generic Playwright helper tool for navigating, rendering, and exporting interactive pages.
This tool is intentionally generic and accepts a list of "actions" to execute.
It attempts to use Playwright and falls back to a simple requests-based fetch when Playwright isn't available.
"""
import os
import json
import logging
from typing import Dict, Any, List, Optional

from autogen_core.tools import FunctionTool


logger = logging.getLogger(__name__)


def _safe_filename_from_url(url: str) -> str:
    """Create a safe filename from url (mirror similar helper elsewhere)."""
    import re
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = parsed.netloc.replace(':', '_') if parsed.netloc else 'site'
    path = parsed.path.strip('/') or 'index'
    safe_path = re.sub(r'[^A-Za-z0-9_\-\.]', '_', path)
    filename = f"{host}_{safe_path}.html"
    return filename


def _save_html_to_workdir(work_dir: str, url: str, html: str) -> str:
    os.makedirs(work_dir, exist_ok=True)
    filename = _safe_filename_from_url(url)
    path = os.path.join(work_dir, filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    return path


async def _navigate_with_playwright(url: str, actions: Optional[List[Dict[str, Any]]], work_dir: str, timeout_s: int = 60):
    """Internal helper using Playwright to render and optionally click and download.
    Returns a dict with keys: saved_html (path), downloaded_files (list), messages, status.
    """
    from playwright.async_api import async_playwright

    messages = []
    downloaded_files = []
    saved_html = None
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            page = await context.new_page()
            logger.info(f"Playwright launched browser for URL {url}")
            try:
                from dynamic_agent_loader import helpers
                append_accomplishment_to_file = helpers.append_accomplishment_to_file
                append_accomplishment_to_file(work_dir, f"WEB_SEARCH_AGENT: Attempting Playwright render: {url}")
            except Exception:
                pass
            # Set a generic UA for compatibility
            await page.set_extra_http_headers({"User-Agent": os.environ.get('USER_AGENT', 'Mozilla/5.0')})
            # Navigate
            await page.goto(url, wait_until='domcontentloaded', timeout=timeout_s * 1000)
            # Allow some time to render
            await page.wait_for_timeout(800)
            if actions:
                for a in actions:
                    try:
                        action = a.get('action') if isinstance(a, dict) else None
                        logger.info(f"Playwright performing action: {action} -> {a}")
                        if action == 'click':
                            selector = a.get('selector')
                            expect_download = a.get('expect_download', False)
                            if expect_download:
                                async with page.expect_download() as dl:
                                    await page.click(selector, timeout=(a.get('timeout') or 30000))
                                download = await dl.value
                                fname = download.suggested_filename
                                download_path = os.path.join(work_dir, fname)
                                await download.save_as(download_path)
                                downloaded_files.append(download_path)
                                messages.append(f"Downloaded: {download_path}")
                                logger.info(f"Playwright action downloaded file: {download_path}")
                                try:
                                    from dynamic_agent_loader import helpers
                                    append_accomplishment_to_file = helpers.append_accomplishment_to_file
                                    append_accomplishment_to_file(work_dir, f"WEB_SEARCH_AGENT: 📁 Ready for upload: {download_path}")
                                except Exception:
                                    pass
                            else:
                                await page.click(selector, timeout=(a.get('timeout') or 30000))
                                messages.append(f"Clicked selector {selector}")
                        elif action == 'fill':
                            selector = a.get('selector')
                            value = a.get('value', '')
                            await page.fill(selector, value)
                            messages.append(f"Filled {selector}")
                        elif action == 'wait_for_selector':
                            selector = a.get('selector')
                            await page.wait_for_selector(selector, timeout=(a.get('timeout') or 30000))
                            messages.append(f"Waited for {selector}")
                        elif action == 'evaluate':
                            script = a.get('script')
                            val = await page.evaluate(script)
                            messages.append(f"Evaluate returned: {val}")
                        else:
                            # Unsupported/unknown action - skip with a message
                            messages.append(f"Skipped unknown action: {a}")
                            logger.info(f"Skipped unknown Playwright action: {a}")
                    except Exception as exc:
                        messages.append(f"Action failure: {a} => {str(exc)}")

            # Save HTML
            html = await page.content()
            saved_html = _save_html_to_workdir(work_dir, url, html)
            try:
                from dynamic_agent_loader import helpers
                append_accomplishment_to_file = helpers.append_accomplishment_to_file
                append_accomplishment_to_file(work_dir, f"WEB_SEARCH_AGENT: 📁 Saved webpage HTML: {saved_html}")
            except Exception:
                pass
            logger.info(f"Playwright saved HTML snapshot at {saved_html}")
            await browser.close()
            return {
                "status": "success",
                "saved_html": saved_html,
                "downloaded_files": downloaded_files,
                "messages": messages,
            }
    except Exception as exc:
        return {
            "status": "error",
            "error": str(exc),
            "saved_html": saved_html,
            "downloaded_files": downloaded_files,
            "messages": messages,
        }


async def _fetch_via_requests(url: str, work_dir: str, timeout_s: int = 60):
    import requests
    try:
        headers = {"User-Agent": os.environ.get('USER_AGENT', 'Mozilla/5.0')}
        resp = requests.get(url, headers=headers, timeout=timeout_s)
        resp.raise_for_status()
        html = resp.text
        saved_html = _save_html_to_workdir(work_dir, url, html)
        try:
            from agents.util.helpers import append_accomplishment_to_file
            append_accomplishment_to_file(work_dir, f"WEB_SEARCH_AGENT: 📁 Saved webpage HTML: {saved_html}")
        except Exception:
            pass
        return {
            "status": "fallback",
            "saved_html": saved_html,
            "downloaded_files": [],
            "messages": ["Used requests fallback; Playwright not available or failed"],
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc), "messages": []}


def get_playwright_tool(work_dir: str):
    """Return a bound FunctionTool for Playwright interactions.
    Tool signature: (url: str, actions: Optional[list of dict], timeout_s:int=60) -> JSON string
    Where actions are e.g. [{'action':'click', 'selector':'#export', 'expect_download': True}]
    """
    async def _playwright_bound(url: str, actions: Optional[List[Dict[str, Any]]] = None, timeout_s: int = 60) -> str:
        # Try to use Playwright to render and optionally download
        try:
            res = await _navigate_with_playwright(url, actions, work_dir, timeout_s=timeout_s)
            if res.get('status') == 'success':
                return json.dumps(res)
            # If Playwright succeeded with errors but returned saved_html, return that
            if res.get('saved_html'):
                return json.dumps(res)
        except Exception:
            pass
        # Fallback to simple fetch
        res2 = await _fetch_via_requests(url, work_dir, timeout_s=timeout_s)
        return json.dumps(res2)

    return FunctionTool(_playwright_bound, description="Render/automate interactive page with Playwright and export downloads; falls back to a simple fetch if Playwright isn't available.")
