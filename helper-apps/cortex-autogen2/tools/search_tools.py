"""
Web search tools (keyless).

Implements DuckDuckGo-based search without API keys:
- web_search: web results via HTML endpoint
- image_search: image results via i.js JSON (requires vqd token)
- combined_search: combined web + image results
"""

import logging
import os
import requests
import json
from typing import Dict, Any, List, Optional
import asyncio # Import asyncio
import matplotlib.pyplot as plt
import pandas as pd
import re
import urllib.parse
import html as html_lib

# try:
# except ImportError:
#     logging.warning("matplotlib.pyplot not found. Plotting functionality will be disabled.")
#     plt = None

# try:
# except ImportError:
#     logging.warning("pandas not found. CSV/DataFrame functionality may be limited.")
#     pd = None

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


def _normalize_web_results(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for item in items:
        title = item.get("title")
        url = item.get("url") or item.get("href")
        snippet = item.get("snippet")
        if url and title:
            normalized.append({
                "type": "webpage",
                "title": title,
                "url": url,
                "snippet": snippet,
            })
    return normalized


def _normalize_image_results(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for item in items:
        url = item.get("image") or item.get("url") or item.get("thumbnail")
        if not url:
            continue
        normalized.append({
            "type": "image",
            "title": item.get("title"),
            "url": url,
            "thumbnail_url": item.get("thumbnail"),
            "width": item.get("width"),
            "height": item.get("height"),
            "host_page_url": item.get("source") or item.get("page") or item.get("referrer"),
        })
    return normalized


def _extract_snippet_near(html: str, start_pos: int) -> Optional[str]:
    window = html[start_pos:start_pos + 1500]
    m = re.search(
        r'<(?:div|span|a)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</(?:div|span|a)>',
        window,
        flags=re.I,
    )
    if not m:
        return None
    raw = m.group(1)
    text = re.sub('<[^<]+?>', '', raw)
    text = html_lib.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text or None


def _ddg_web(query: str, count: int = 25) -> List[Dict[str, Any]]:
    url = f"https://duckduckgo.com/html/?q={urllib.parse.quote_plus(query)}"
    headers = {"User-Agent": USER_AGENT}
    resp = requests.get(url, headers=headers, timeout=20)
    resp.raise_for_status()
    html = resp.text

    # Capture results: <a class="result__a" href="...">Title</a>
    links_iter = re.finditer(r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, flags=re.I | re.S)
    results: List[Dict[str, Any]] = []
    for match in links_iter:
        href = match.group(1)
        title_html = match.group(2)
        title_text = html_lib.unescape(re.sub('<[^<]+?>', '', title_html)).strip()
        if not title_text or not href:
            continue
        # Resolve DDG redirect links and protocol-relative URLs
        url_val = href
        if url_val.startswith("//"):
            url_val = "https:" + url_val
        try:
            parsed = urllib.parse.urlparse(url_val)
            if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
                qs = urllib.parse.parse_qs(parsed.query)
                uddg = qs.get("uddg", [None])[0]
                if uddg:
                    url_val = urllib.parse.unquote(uddg)
        except Exception:
            pass
        snippet = _extract_snippet_near(html, match.end())
        results.append({
            "title": title_text,
            "url": url_val,
            "snippet": snippet,
        })
        if len(results) >= max(1, count):
            break
    return _normalize_web_results(results)


def _enrich_web_results_with_meta(results: List[Dict[str, Any]], max_fetch: int = 3, timeout_s: int = 8) -> List[Dict[str, Any]]:
    if not results:
        return results
    headers = {"User-Agent": USER_AGENT}
    enriched: List[Dict[str, Any]] = []
    for idx, item in enumerate(results):
        if idx < max_fetch and (not item.get("snippet") or len(item.get("snippet") or "") < 40):
            url = item.get("url")
            try:
                resp = requests.get(url, headers=headers, timeout=timeout_s)
                resp.raise_for_status()
                html = resp.text
                # meta description
                md = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
                if not md:
                    md = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']description["\']', html, flags=re.I)
                if not md:
                    md = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
                snippet = html_lib.unescape(md.group(1)).strip() if md else None
                if not snippet:
                    # fallback: plain text excerpt from body
                    body = re.search(r'<body[^>]*>([\s\S]*?)</body>', html, flags=re.I)
                    if body:
                        text_only = re.sub('<script[\s\S]*?</script>', ' ', body.group(1), flags=re.I)
                        text_only = re.sub('<style[\s\S]*?</style>', ' ', text_only, flags=re.I)
                        text_only = re.sub('<[^<]+?>', ' ', text_only)
                        text_only = re.sub(r'\s+', ' ', text_only).strip()
                        snippet = text_only[:300] if text_only else None
                if snippet:
                    item = dict(item)
                    item["snippet"] = snippet
            except Exception:
                pass
        enriched.append(item)
    return enriched


def _html_to_text(html: str, max_chars: int = 200000) -> str:
    # Normalize line breaks for block elements before stripping
    block_tags = [
        'p','div','br','hr','section','article','header','footer','li','ul','ol','table','tr','td','th','h1','h2','h3','h4','h5','h6'
    ]
    for tag in block_tags:
        html = re.sub(fr'<\s*{tag}[^>]*>', '\n', html, flags=re.I)
        if tag not in ('br','hr'):
            html = re.sub(fr'</\s*{tag}\s*>', '\n', html, flags=re.I)

    # Remove script/style/noscript
    html = re.sub(r'<script[\s\S]*?</script>', ' ', html, flags=re.I)
    html = re.sub(r'<style[\s\S]*?</style>', ' ', html, flags=re.I)
    html = re.sub(r'<noscript[\s\S]*?</noscript>', ' ', html, flags=re.I)
    # Remove comments
    html = re.sub(r'<!--([\s\S]*?)-->', ' ', html)
    # Strip remaining tags
    text = re.sub(r'<[^>]+>', ' ', html)
    # Decode entities and collapse whitespace
    text = html_lib.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) > max_chars:
        text = text[:max_chars]
    return text


async def fetch_webpage(url: str, render: bool = False, timeout_s: int = 20, max_chars: int = 200000) -> str:
    """
    Fetch a full webpage and return structured JSON with title, html, and extracted text.
    - render=False: simple HTTP fetch (no JS)
    - render=True: try Playwright to render JS (falls back to simple fetch if unavailable)
    """
    try:
        # Normalize URL
        if not re.match(r'^https?://', url):
            url = 'https://' + url

        headers = {"User-Agent": USER_AGENT}

        # Helper: requests-based fetch
        def fetch_via_requests(target_url: str) -> Dict[str, Any]:
            r = requests.get(target_url, headers=headers, timeout=timeout_s)
            r.raise_for_status()
            html = r.text
            # Title
            mt = re.search(r'<title[^>]*>([\s\S]*?)</title>', html, flags=re.I)
            title = html_lib.unescape(mt.group(1)).strip() if mt else None
            # Meta description
            md = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
            if not md:
                md = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
            meta_desc = html_lib.unescape(md.group(1)).strip() if md else None
            text = _html_to_text(html, max_chars=max_chars)
            return {
                "url": str(r.url or target_url),
                "title": title,
                "meta_description": meta_desc,
                "html": html if len(html) <= max_chars else html[:max_chars],
                "text": text,
            }

        if not render:
            data = fetch_via_requests(url)
            return json.dumps(data, indent=2)

        # Try Playwright render
        try:
            from playwright.async_api import async_playwright
        except Exception:
            data = fetch_via_requests(url)
            return json.dumps(data, indent=2)

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context()
                page = await context.new_page()
                await page.set_extra_http_headers({"User-Agent": USER_AGENT})
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
                # Give some time for client-side render
                await page.wait_for_timeout(800)
                final_url = page.url
                title = await page.title()
                html = await page.content()
                await browser.close()

                text = _html_to_text(html, max_chars=max_chars)
                # Meta description from rendered HTML
                md = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
                if not md:
                    md = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
                meta_desc = html_lib.unescape(md.group(1)).strip() if md else None

                data = {
                    "url": final_url,
                    "title": title or None,
                    "meta_description": meta_desc,
                    "html": html if len(html) <= max_chars else html[:max_chars],
                    "text": text,
                }
                return json.dumps(data, indent=2)
        except Exception:
            # Fallback to non-rendered fetch on any Playwright runtime error
            data = fetch_via_requests(url)
            return json.dumps(data, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Fetch failed: {str(exc)}"})


def _ddg_get_vqd(query: str) -> Optional[str]:
    headers = {"User-Agent": USER_AGENT, "Referer": "https://duckduckgo.com/"}
    url = f"https://duckduckgo.com/?q={urllib.parse.quote_plus(query)}&iax=images&ia=images"
    resp = requests.get(url, headers=headers, timeout=20)
    resp.raise_for_status()
    text = resp.text
    # Common patterns seen in the page scripts
    # Try multiple patterns; DDG frequently changes this
    m = re.search(r"vqd='([\w-]+)'", text)
    if not m:
        m = re.search(r'vqd="([\w-]+)"', text)
    if not m:
        m = re.search(r'vqd=([\w-]+)&', text)
    return m.group(1) if m else None


def _ddg_images_html(query: str, count: int = 25) -> List[Dict[str, Any]]:
    headers = {"User-Agent": USER_AGENT, "Referer": "https://duckduckgo.com/"}
    url = f"https://duckduckgo.com/?q={urllib.parse.quote_plus(query)}&ia=images&iar=images"
    resp = requests.get(url, headers=headers, timeout=20)
    resp.raise_for_status()
    html = resp.text
    items: List[Dict[str, Any]] = []
    # Look for external-content proxied URLs; extract original via 'u' param
    for m in re.finditer(r'(?:src|data-src)="(https://external-content\.duckduckgo\.com/iu/\?u=[^"]+)"', html):
        proxy = html_lib.unescape(m.group(1))
        try:
            parsed = urllib.parse.urlparse(proxy)
            qs = urllib.parse.parse_qs(parsed.query)
            orig = qs.get('u', [None])[0]
            if not orig:
                continue
            orig = urllib.parse.unquote(orig)
            items.append({
                "title": None,
                "image": orig,
                "thumbnail": proxy,
                "width": None,
                "height": None,
                "source": None,
            })
            if len(items) >= count:
                break
        except Exception:
            continue
    return _normalize_image_results(items)


def _ddg_images(query: str, count: int = 25) -> List[Dict[str, Any]]:
    vqd = _ddg_get_vqd(query)
    if not vqd:
        # Fallback to simple HTML scraping if token not found
        return _ddg_images_html(query, count)
    headers = {"User-Agent": USER_AGENT, "Referer": "https://duckduckgo.com/"}
    params = {
        "l": "us-en",
        "o": "json",
        "q": query,
        "vqd": vqd,
        "f": ",",
        "p": "1",
        "s": "0",
    }
    # Fetch multiple pages to maximize results in a single logical call
    raw_results: List[Dict[str, Any]] = []
    next_url = "https://duckduckgo.com/i.js"
    while len(raw_results) < count and next_url:
        resp = requests.get(next_url, headers=headers, params=params, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        raw_results.extend(data.get("results") or [])
        next_url = data.get("next")
        params = None  # subsequent calls use absolute next URL
        if not next_url:
            break
    items: List[Dict[str, Any]] = []
    for it in raw_results[: max(1, min(count, 200))]:
        items.append({
            "title": it.get("title"),
            "image": it.get("image"),
            "thumbnail": it.get("thumbnail"),
            "width": it.get("width"),
            "height": it.get("height"),
            "source": it.get("url"),
        })
    normalized = _normalize_image_results(items)
    if not normalized:
        # Extra fallback to HTML scrape if i.js yields nothing
        return _ddg_images_html(query, count)
    return normalized


async def web_search(query: str, count: int = 25, enrich: bool = True) -> str:
    try:
        results = _ddg_web(query, count)
        if enrich:
            results = _enrich_web_results_with_meta(results)
        if not results:
            return json.dumps({"status": "No relevant results found."})
        return json.dumps(results, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Web search failed: {str(exc)}"})


async def image_search(query: str, count: int = 25) -> str:
    try:
        results = _ddg_images(query, count)
        if not results:
            return json.dumps({"status": "No relevant results found."})
        return json.dumps(results, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Image search failed: {str(exc)}"})


async def combined_search(query: str, count: int = 25, enrich: bool = True) -> str:
    try:
        web_task = _ddg_web(query, count)
        if enrich:
            web_task = _enrich_web_results_with_meta(web_task)
        img_task = _ddg_images(query, count)
        combined: List[Dict[str, Any]] = []
        combined.extend(web_task)
        combined.extend(img_task)
        if not combined:
            return json.dumps({"status": "No relevant results found."})
        return json.dumps(combined, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Combined search failed: {str(exc)}"})


async def collect_task_images(
    query: str,
    count: int = 10,
    allowed_domains: Optional[List[str]] = None,
    verify_download: bool = True,
    work_dir: Optional[str] = None,
) -> str:
    """
    Search for task-relevant images, optionally filter by allowed domains, download locally,
    and upload to Azure Blob Storage when configured. Returns JSON with uploaded URLs and details.

    Params:
      - query: task/topic to ensure relevance
      - count: desired number of images to return (downloads/uploads up to this many)
      - allowed_domains: restrict results to these host domains if set
      - verify_download: if True, ensures HTTP 200 and image/* content-type before accepting
      - work_dir: directory to save files; defaults to current working directory
    """
    try:
        # Step 1: search many to have selection headroom
        raw_json = await image_search(query, count=max(count * 3, count))
        parsed = json.loads(raw_json) if raw_json else []
        # Normalize parsed results to a list of dicts; handle dict status payloads gracefully
        if isinstance(parsed, dict):
            # No results or error payload
            results: List[Dict[str, Any]] = []
        elif isinstance(parsed, list):
            results = parsed
        else:
            results = []

        # Step 2: relevance filter by domain and title match
        def hostname(url: Optional[str]) -> Optional[str]:
            try:
                from urllib.parse import urlparse
                return urlparse(url).hostname if url else None
            except Exception:
                return None

        query_terms = set(re.findall(r"\w+", query.lower()))
        filtered: List[Dict[str, Any]] = []
        for it in results:
            if not isinstance(it, dict):
                continue
            host = hostname(it.get("host_page_url") or it.get("url")) or ""
            if allowed_domains:
                if not any(d.lower() in (host or "").lower() for d in allowed_domains):
                    continue
            title = (it.get("title") or "").lower()
            title_terms = set(re.findall(r"\w+", title))
            overlap = len(query_terms & title_terms)
            it_copy = dict(it)
            it_copy["_rank"] = overlap
            it_copy["_host"] = host
            filtered.append(it_copy)

        # Rank by overlap desc, then presence of host_page_url
        filtered.sort(key=lambda x: (x.get("_rank", 0), bool(x.get("host_page_url"))), reverse=True)

        # Step 3: download and optionally verify
        if not work_dir:
            work_dir = os.getcwd()
        os.makedirs(work_dir, exist_ok=True)

        from .file_tools import download_image  # local tool
        from .azure_blob_tools import upload_file_to_azure_blob  # uploader

        accepted: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []

        session = None
        if verify_download:
            try:
                import requests
                session = requests.Session()
                session.headers.update({"User-Agent": USER_AGENT})
            except Exception:
                session = None

        def is_image_ok(url: str) -> bool:
            if not verify_download or not session:
                return True
            try:
                r = session.get(url, stream=True, timeout=15, allow_redirects=True)
                ct = (r.headers.get("content-type") or "").lower()
                if r.status_code == 200 and (ct.startswith("image/") or next(r.iter_content(1024), b"")):
                    return True
            except Exception:
                return False
            return False

        used = 0
        for it in filtered:
            if used >= count:
                break
            img_url = it.get("url")
            if not img_url:
                skipped.append({"reason": "missing_url", "item": it})
                continue
            if not is_image_ok(img_url):
                skipped.append({"reason": "verify_failed", "url": img_url})
                continue

            # safe filename
            base = re.sub(r"[^a-zA-Z0-9_-]+", "_", (it.get("title") or "image").strip())[:80] or "image"
            filename = f"{base}_{used+1}.jpg"
            dl_json = await download_image(img_url, filename, work_dir)
            dl = json.loads(dl_json)
            if dl.get("status") != "success":
                skipped.append({"reason": "download_error", "url": img_url, "detail": dl})
                continue

            file_path = dl.get("file_path")
            # Upload if configured, else mark as local only
            azure_conn = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
            if azure_conn:
                up_json = upload_file_to_azure_blob(file_path)
                up = json.loads(up_json)
                if "download_url" in up:
                    accepted.append({
                        "title": it.get("title"),
                        "source_page": it.get("host_page_url"),
                        "uploaded_url": up["download_url"],
                        "local_path": file_path,
                        "width": it.get("width"),
                        "height": it.get("height"),
                        "source_host": it.get("_host"),
                    })
                    used += 1
                    continue
                else:
                    skipped.append({"reason": "upload_error", "file_path": file_path, "detail": up})
                    continue
            else:
                accepted.append({
                    "title": it.get("title"),
                    "source_page": it.get("host_page_url"),
                    "uploaded_url": None,
                    "local_path": file_path,
                    "width": it.get("width"),
                    "height": it.get("height"),
                    "source_host": it.get("_host"),
                    "note": "AZURE_STORAGE_CONNECTION_STRING not set; upload skipped"
                })
                used += 1

        # No synthesis: if no accepted items, return zero results as-is

        return json.dumps({
            "query": query,
            "requested": count,
            "returned": len(accepted),
            "accepted": accepted,
            "skipped": skipped,
        }, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"collect_task_images failed: {str(exc)}"})


async def _perform_single_cognitive_search(
    query: str = "*",
    index_name: str = "indexwires",
    date_filter: Optional[str] = None,
    top: int = 50,
    select: Optional[str] = None,
    facets: Optional[List[str]] = None,
    orderby: Optional[str] = None, # Added orderby parameter
    requires_bi: bool = False,
    context_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Performs a single search query on Azure Cognitive Search. Internal helper.
    """
    API_URL = os.environ.get('AZURE_COGNITIVE_API_URL')
    API_KEY = os.environ.get('AZURE_COGNITIVE_API_KEY')

    if not API_URL or not API_KEY:
        return {"error": "AZURE_COGNITIVE_API_URL or AZURE_COGNITIVE_API_KEY environment variables not set"}

    headers = {
        'Content-Type': 'application/json',
        'api-key': API_KEY
    }

    search_url = f"{API_URL}indexes/{index_name}/docs/search?api-version=2024-07-01" # Updated API version

    payload = {
        'search': query,
        'orderby': 'date desc', # Changed to date for consistency with previous working examples
        'top': min(top, 100),
    }

    if select:
        payload['select'] = select
    if date_filter:
        # Removed explicit stripping of timezone as the agent is responsible for correct ISO 8601 Z format
        payload['filter'] = date_filter
    if facets:
        payload['facets'] = facets
    
    # Apply contextId filter for indexcortex
    if index_name == "indexcortex" and context_id:
        if 'filter' in payload:
            payload['filter'] += f" and owner eq '{context_id}'"
        else:
            payload['filter'] = f"owner eq '{context_id}'"

    print(f"DEBUG: Search URL: {search_url}") # Added debug print
    print(f"DEBUG: Payload: {json.dumps(payload, indent=2)}") # Added debug print

    try:
        response = requests.post(search_url, headers=headers, json=payload)
        response.raise_for_status() # Raise an exception for HTTP errors
        return {"index_name": index_name, "results": response.json()}
    except requests.exceptions.RequestException as e:
        return {"index_name": index_name, "error": f"Error performing Cognitive Search: {str(e)}"}
    except Exception as e:
        return {"index_name": index_name, "error": f"Unexpected error in Cognitive Search: {str(e)}"}


async def azure_cognitive_search(
    queries: List[Dict[str, Any]]
) -> str:
    """
    Perform one or more searches on Azure Cognitive Search indexes in parallel.

    Args:
        queries: A list of dictionaries, where each dictionary represents a single search query
                 with the following potential keys: `query` (str), `index_name` (str),
                 `date_filter` (str, optional), `top` (int, optional), `select` (str, optional),
                 `facets` (List[str], optional), `requires_bi` (bool, optional),
                 `context_id` (str, optional).

    Returns:
        JSON string with a list of results, each corresponding to an input query.
    """
    tasks = []
    for q_params in queries:
        tasks.append(_perform_single_cognitive_search(**q_params))
    
    results = await asyncio.gather(*tasks)
    return json.dumps(results, indent=2) 