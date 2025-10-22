"""
Web search tools (keyless).

Implements Google CSE-based search for web and image results:
- web_search: web results via Google CSE
- image_search: image results via Google CSE
- combined_search: combined web + image results
"""

import logging
import os
import requests
import json
from typing import Dict, Any, List, Optional
import hashlib
from PIL import Image
import asyncio # Import asyncio
import matplotlib.pyplot as plt
import pandas as pd
import re
import urllib.parse
import html as html_lib
from .google_cse import google_cse_search
from urllib.parse import urljoin, urlparse

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
        # For Wikimedia thumbnail URLs, add an "original_url" when derivable
        original_url = None
        try:
            if isinstance(url, str) and "upload.wikimedia.org" in url and "/thumb/" in url:
                parts = url.split("/thumb/")
                if len(parts) == 2:
                    tail = parts[1]
                    segs = tail.split("/")
                    if len(segs) >= 3:
                        original_url = parts[0] + "/" + segs[0] + "/" + segs[1] + "/" + segs[2]
        except Exception:
            original_url = None
        normalized.append({
            "type": "image",
            "title": item.get("title"),
            "url": url,
            "original_url": original_url,
            "thumbnail_url": item.get("thumbnail"),
            "width": item.get("width"),
            "height": item.get("height"),
            "host_page_url": item.get("source") or item.get("page") or item.get("referrer"),
        })
    return normalized
def _normalize_cse_web_results(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Normalize Google CSE (web) response to our common web result shape.
    """
    items = (payload or {}).get("items") or []
    normalized: List[Dict[str, Any]] = []
    for it in items:
        title = it.get("title")
        url = it.get("link")
        snippet = it.get("snippet") or (it.get("htmlSnippet") and re.sub('<[^<]+?>', '', it.get("htmlSnippet")))
        if url and title:
            normalized.append({
                "type": "webpage",
                "title": title,
                "url": url,
                "snippet": snippet,
            })
    return normalized


def _normalize_cse_image_results(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Normalize Google CSE (image) response to our common image result shape.
    Handles both standard items array and pagemap-based image results.
    """
    normalized: List[Dict[str, Any]] = []
    
    # Method 1: Standard items array (searchType=image)
    items = (payload or {}).get("items") or []
    for it in items:
        link = it.get("link")  # direct image URL
        image_obj = it.get("image") or {}
        pagemap = it.get("pagemap") or {}
        cse_image = (pagemap.get("cse_image") or [{}])[0] if "cse_image" in pagemap else {}
        
        # Prefer direct link, fallback to pagemap images
        img_url = link or image_obj.get("thumbnailLink") or cse_image.get("src")
        if not img_url:
            continue
            
        normalized.append({
            "type": "image",
            "title": it.get("title") or cse_image.get("alt"),
            "url": img_url,
            "original_url": link or img_url,
            "thumbnail_url": image_obj.get("thumbnailLink") or img_url,
            "width": image_obj.get("width") or cse_image.get("width"),
            "height": image_obj.get("height") or cse_image.get("height"),
            "host_page_url": image_obj.get("contextLink") or it.get("link"),
        })
    
    # Method 2: Extract from pagemap in web results (fallback)
    if not normalized:
        for it in items:
            pagemap = it.get("pagemap") or {}
            cse_images = pagemap.get("cse_image") or []
            for img in cse_images:
                img_url = img.get("src")
                if img_url:
                    normalized.append({
                        "type": "image",
                        "title": it.get("title"),
                        "url": img_url,
                        "original_url": img_url,
                        "thumbnail_url": img_url,
                        "width": img.get("width"),
                        "height": img.get("height"),
                        "host_page_url": it.get("link"),
                    })
    
    logging.info(f"[_normalize_cse_image_results] Extracted {len(normalized)} images from CSE payload")
    return normalized


def _has_google_cse_env() -> bool:
    return bool(os.getenv("GOOGLE_CSE_KEY") and os.getenv("GOOGLE_CSE_CX"))



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



async def web_search(query: str, count: int = 25, enrich: bool = True) -> str:
    try:
        results: List[Dict[str, Any]] = []
        used_google = False
        # Prefer Google CSE when configured
        if _has_google_cse_env():
            try:
                raw = await google_cse_search(text=query, parameters={"num": max(1, min(count, 10))})
                data = json.loads(raw) if raw else {}
                results = _normalize_cse_web_results(data)
                used_google = True
            except Exception:
                used_google = False
                results = []


        if enrich and results:
            # Enrich only for web-page items
            results = _enrich_web_results_with_meta(results)

        if not results:
            return json.dumps({"status": "No relevant results found."})

        return json.dumps(results, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Web search failed: {str(exc)}"})


def _make_image_session():
    try:
        s = requests.Session()
        s.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
        })
        return s
    except Exception:
        return None


def _is_downloadable_image(url: str, session=None, timeout: int = 15) -> bool:
    if not url:
        return False
    try:
        s = session or _make_image_session()
    except Exception:
        s = None
    try:
        if not s:
            s = requests
        r = s.get(url, stream=True, timeout=timeout, allow_redirects=True)
        ct = (r.headers.get("content-type") or "").lower()
        if r.status_code != 200:
            return False
        if ct.startswith("image/"):
            return True
        # Peek first bytes for magic
        try:
            first_chunk = next(r.iter_content(2048), b"")
        except Exception:
            first_chunk = b""
        if first_chunk:
            sigs = [b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"RIFF"]
            return any(first_chunk.startswith(sig) for sig in sigs)
        return False
    except Exception:
        return False


async def image_search(query: str, count: int = 25, verify_download: bool = True, required_terms: Optional[List[str]] = None, allowed_domains: Optional[List[str]] = None, strict_entity: bool = False) -> str:
    try:
        # Simple query variants - avoid over-expanding which dilutes results
        def generate_query_variants(q: str) -> List[str]:
            base = q.strip()
            # Only add ONE quality variant to keep results focused
            variants = [
                base,  # Primary: exact query
                f"{base} hd",  # Secondary: just add quality term
            ]
            return variants

        results: List[Dict[str, Any]] = []
        # Prefer Google CSE when configured; try multiple high-quality variants in parallel
        if _has_google_cse_env():
            try:
                logging.info(f"[image_search] Using Google CSE for query: {query}")
                variants = generate_query_variants(query)[:2]  # cap to 2 calls to stay focused
                params_base = {
                    "num": max(1, min(count, 10)),
                    "searchType": "image",
                    # No strict size/type constraints; let ranking + verification decide
                    "safe": "active",
                }
                tasks = [
                    google_cse_search(text=v, parameters=dict(params_base))
                    for v in variants
                ]
                raws = await asyncio.gather(*tasks)
                merged: List[Dict[str, Any]] = []
                for raw in raws:
                    try:
                        data = json.loads(raw) if raw else {}
                        merged.extend(_normalize_cse_image_results(data))
                    except Exception:
                        continue
                results = merged
                logging.info(f"[image_search] Google CSE returned {len(results)} raw results")
            except Exception as e:
                logging.warning(f"[image_search] Google CSE failed: {e}")
                results = []



        # Post-filtering and ranking for relevance and quality
        def score(item: Dict[str, Any]) -> int:
            s = 0
            title = (item.get("title") or "").lower()
            url = (item.get("url") or "").lower()
            host = (item.get("host_page_url") or "").lower()
            
            # CRITICAL: Strong relevance check - ensure query terms are present
            q_terms = set(re.findall(r"\w+", query.lower()))
            t_terms = set(re.findall(r"\w+", title))
            u_terms = set(re.findall(r"\w+", url))
            
            # Primary relevance: query terms in title (highest weight)
            title_overlap = len(q_terms & t_terms)
            s += 10 * title_overlap  # Increased from 3 to 10
            
            # Secondary relevance: query terms in URL
            url_overlap = len(q_terms & u_terms)
            s += 5 * url_overlap
            
            # CRITICAL: If NO query terms match title or URL, heavily penalize
            if title_overlap == 0 and url_overlap == 0:
                s -= 100  # This image is likely completely unrelated
            
            # Quality signals
            for ext, ext_score in ((".png", 2), (".jpg", 2), (".jpeg", 2), (".webp", 2), (".svg", 0), (".gif", 0)):
                if url.endswith(ext) or (item.get("original_url") or "").lower().endswith(ext):
                    s += ext_score
                    break
            
            # Penalize low-quality/irrelevant assets (stronger penalties)
            negative_tokens = ["sprite", "icon", "thumbnail", "thumb", "small", "mini", "logo", "watermark", "stock", "avatar", "emoji"]
            s -= 3 * sum(1 for tok in negative_tokens if tok in url)  # Increased penalty
            
            # Reward quality descriptors
            positive_tokens = ["official", "press", "hd", "4k", "wallpaper", "hero", "high-res", "highres"]
            s += 2 * sum(1 for tok in positive_tokens if tok in title or tok in url)
            
            # Reward larger dimensions
            try:
                w = int(item.get("width") or 0)
                h = int(item.get("height") or 0)
                area = w * h
                if area >= 1920 * 1080:     # Full HD or larger
                    s += 8
                elif area >= 1280 * 720:    # HD
                    s += 5
                elif area >= 800 * 600:     # Decent size
                    s += 2
                elif area > 0 and area < 400 * 400:  # Too small
                    s -= 5
            except Exception:
                pass
            
            # Penalize thumbnails
            if ("thumb" in url or "thumbnail" in url) and not item.get("original_url"):
                s -= 5
            
            return s

        # Optional entity/term/domain constraints
        def hostname(url: Optional[str]) -> Optional[str]:
            try:
                from urllib.parse import urlparse
                return urlparse(url).hostname if url else None
            except Exception:
                return None

        q_terms = set(re.findall(r"\w+", query.lower()))
        req_terms = set((required_terms or []))

        filtered1: List[Dict[str, Any]] = []
        for it in results:
            try:
                ttl = (it.get("title") or "")
                tset = set(re.findall(r"\w+", ttl.lower()))
                host = hostname(it.get("host_page_url") or it.get("url")) or ""
                if allowed_domains and not any(d.lower() in host.lower() for d in allowed_domains):
                    continue
                if req_terms and not req_terms.issubset(tset):
                    # If strict mode, skip; otherwise allow but lower score later
                    if strict_entity:
                        continue
                    it = dict(it)
                    it["_missing_required_terms"] = True
                # CRITICAL: Always require at least one query term in title OR URL (even without strict mode)
                url_terms = set(re.findall(r"\w+", (it.get("url") or "").lower()))
                has_match = bool(q_terms & tset) or bool(q_terms & url_terms)
                
                if strict_entity and not has_match:
                    continue
                elif not strict_entity and not has_match:
                    # Even in non-strict mode, skip images with ZERO query term matches
                    # This prevents completely unrelated images
                    continue
                    
                filtered1.append(it)
            except Exception:
                continue

        # De-duplicate by original_url or url
        seen = set()
        deduped: List[Dict[str, Any]] = []
        for it in filtered1:
            key = it.get("original_url") or it.get("url")
            if not key or key in seen:
                continue
            seen.add(key)
            deduped.append(it)

        # Penalize items missing required terms if not strict
        def score_with_penalty(it: Dict[str, Any]) -> int:
            base = score(it)
            if it.get("_missing_required_terms"):
                base -= 5
            return base

        deduped.sort(key=score_with_penalty, reverse=True)
        
        # Filter out images with low scores (unrelated or poor quality)
        # Minimum score threshold: at least some query term overlap is required
        MIN_RELEVANCE_SCORE = 5  # Ensures at least one query term match + some quality
        deduped = [it for it in deduped if score_with_penalty(it) >= MIN_RELEVANCE_SCORE]

        # Optionally verify downloadability and pick top working images
        if verify_download:
            session = _make_image_session()
            accepted: List[Dict[str, Any]] = []
            for it in deduped:
                if len(accepted) >= count:
                    break
                test_url = it.get("original_url") or it.get("url")
                if _is_downloadable_image(test_url, session=session):
                    accepted.append(it)
            deduped = accepted

        deduped = deduped[:count]

        if not deduped:
            return json.dumps({"status": "No relevant results found."})
        return json.dumps(deduped, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Image search failed: {str(exc)}"})


async def combined_search(query: str, count: int = 25, enrich: bool = True) -> str:
    try:
        combined: List[Dict[str, Any]] = []
        # Prefer Google for both, with fallback to DDG
        web_results: List[Dict[str, Any]] = []
        img_results: List[Dict[str, Any]] = []

        if _has_google_cse_env():
            try:
                raw_web = await google_cse_search(text=query, parameters={"num": max(1, min(count, 10))})
                data_web = json.loads(raw_web) if raw_web else {}
                web_results = _normalize_cse_web_results(data_web)
            except Exception:
                web_results = []
            try:
                raw_img = await google_cse_search(text=query, parameters={"num": max(1, min(count, 10)), "searchType": "image"})
                data_img = json.loads(raw_img) if raw_img else {}
                img_results = _normalize_cse_image_results(data_img)
            except Exception:
                img_results = []

            if enrich and web_results:
                web_results = _enrich_web_results_with_meta(web_results)
        combined.extend(web_results)
        combined.extend(img_results)
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
    required_terms: Optional[List[str]] = None,
    strict_entity: bool = False,
    min_width: int = 0,
    min_height: int = 0,
    dedup_content: bool = True,
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
        # Step 1: search many to have selection headroom; disable double verification here
        raw_json = await image_search(query, count=max(count * 3, count), verify_download=False, required_terms=required_terms, allowed_domains=allowed_domains, strict_entity=strict_entity)
        parsed = json.loads(raw_json) if raw_json else []
        # Normalize parsed results to a list of dicts; handle dict status payloads gracefully
        if isinstance(parsed, dict):
            # No results or error payload
            results: List[Dict[str, Any]] = []
        elif isinstance(parsed, list):
            results = parsed
        else:
            results = []

        # Allow default domains from env if not provided
        if not allowed_domains:
            try:
                env_domains = os.getenv("IMAGE_ALLOWED_DOMAINS")
                if env_domains:
                    allowed_domains = [d.strip() for d in env_domains.split(",") if d.strip()]
            except Exception:
                allowed_domains = None

        logging.info(f"[collect_task_images] Found {len(results)} raw results before filtering. allowed_domains={allowed_domains}, required_terms={required_terms}, strict_entity={strict_entity}")

        # Step 2: relevance filter by domain and title match
        def hostname(url: Optional[str]) -> Optional[str]:
            try:
                from urllib.parse import urlparse
                return urlparse(url).hostname if url else None
            except Exception:
                return None

        query_terms = set(re.findall(r"\w+", query.lower()))
        req_terms_lower = set(t.lower() for t in (required_terms or []))
        filtered: List[Dict[str, Any]] = []
        for it in results:
            if not isinstance(it, dict):
                continue
            host = hostname(it.get("host_page_url") or it.get("url")) or ""
            # Domain filter (if specified)
            if allowed_domains:
                if not any(d.lower() in (host or "").lower() for d in allowed_domains):
                    logging.debug(f"[collect_task_images] Skipped (domain mismatch): host={host}, allowed={allowed_domains}")
                    continue
            title = (it.get("title") or "").lower()
            url = (it.get("url") or "").lower()
            title_terms = set(re.findall(r"\w+", title))
            url_terms = set(re.findall(r"\w+", url))
            # Enforce strict entity/required terms if requested (check both title AND url)
            if strict_entity and req_terms_lower:
                combined_terms = title_terms | url_terms
                if not req_terms_lower.issubset(combined_terms):
                    logging.debug(f"[collect_task_images] Skipped (strict_entity): required={req_terms_lower}, found={combined_terms}")
                    continue
            overlap = len(query_terms & title_terms)
            it_copy = dict(it)
            it_copy["_rank"] = overlap
            it_copy["_host"] = host
            filtered.append(it_copy)

        logging.info(f"[collect_task_images] {len(filtered)} results after domain/entity filtering")

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
        seen_hashes: set = set()
        for it in filtered:
            if used >= count:
                break
            # Prefer original_url if available
            img_url = it.get("original_url") or it.get("url")
            if not img_url:
                skipped.append({"reason": "missing_url", "item": it})
                continue
            if not is_image_ok(img_url):
                skipped.append({"reason": "verify_failed", "url": img_url})
                continue

            # Determine extension; if SVG, download as .svg then convert to PNG
            base = re.sub(r"[^a-zA-Z0-9_-]+", "_", (it.get("title") or "image").strip())[:80] or "image"
            url_lower = (img_url or "").lower()
            is_svg = url_lower.endswith(".svg") or ".svg" in url_lower
            filename = f"{base}_{used+1}.svg" if is_svg else f"{base}_{used+1}.jpg"
            dl_json = await download_image(img_url, filename, work_dir)
            dl = json.loads(dl_json)
            if dl.get("status") != "success":
                skipped.append({"reason": "download_error", "url": img_url, "detail": dl})
                continue

            file_path = dl.get("file_path")
            # If SVG, convert to PNG for PIL compatibility
            if is_svg and file_path and os.path.exists(file_path):
                try:
                    import cairosvg  # type: ignore
                    png_path = os.path.splitext(file_path)[0] + ".png"
                    cairosvg.svg2png(url=file_path, write_to=png_path)
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass
                    file_path = png_path
                except Exception as e:
                    skipped.append({"reason": "svg_convert_failed", "url": img_url, "error": str(e)})
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass
                    continue
            # Optional dimension filter
            try:
                if (min_width or min_height) and file_path and os.path.exists(file_path):
                    with Image.open(file_path) as im:
                        w, h = im.size
                        if (min_width and w < min_width) or (min_height and h < min_height):
                            skipped.append({"reason": "too_small", "url": img_url, "width": w, "height": h})
                            try:
                                os.remove(file_path)
                            except Exception:
                                pass
                            continue
            except Exception:
                pass

            # Optional content deduplication by hash
            try:
                if dedup_content and file_path and os.path.exists(file_path):
                    hasher = hashlib.sha256()
                    with open(file_path, "rb") as fh:
                        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                            hasher.update(chunk)
                    digest = hasher.hexdigest()
                    if digest in seen_hashes:
                        skipped.append({"reason": "content_duplicate", "url": img_url})
                        try:
                            os.remove(file_path)
                        except Exception:
                            pass
                        continue
                    seen_hashes.add(digest)
            except Exception:
                pass
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


async def collect_images_by_pattern(
    base_url: str,
    filename_pattern: str,
    start: int,
    end: int,
    zpad: int = 0,
    ext: str = "png",
    work_dir: Optional[str] = None,
) -> str:
    """
    Enumerate image URLs from a predictable pattern and download them.

    Example: base_url="https://example.com/images/", filename_pattern="{name}_{i}", start=1, end=10
    Constructed URL: base_url + filename_pattern.format(i=idx) + "." + ext

    Returns JSON with downloaded local file paths and any errors.
    """
    try:
        if not work_dir:
            work_dir = os.getcwd()
        os.makedirs(work_dir, exist_ok=True)

        from .file_tools import download_image

        downloaded: List[Dict[str, Any]] = []
        errors: List[Dict[str, Any]] = []

        for i in range(start, end + 1):
            try:
                idx = str(i).zfill(zpad) if zpad > 0 else str(i)
                name = filename_pattern.format(i=idx)
                url = urljoin(base_url, f"{name}.{ext.lstrip('.')}")
                safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "_", name) + f".{ext.lstrip('.')}"
                dl_json = await download_image(url, safe_name, work_dir)
                dl = json.loads(dl_json)
                if dl.get("status") == "success":
                    downloaded.append({"url": url, "file_path": dl.get("file_path")})
                else:
                    errors.append({"url": url, "error": dl})
            except Exception as e:
                errors.append({"i": i, "error": str(e)})

        return json.dumps({
            "base_url": base_url,
            "pattern": filename_pattern,
            "range": [start, end],
            "ext": ext,
            "downloaded": downloaded,
            "errors": errors,
        }, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"collect_images_by_pattern failed: {str(exc)}"})


async def scrape_image_gallery(
    page_url: str,
    css_selector: Optional[str] = None,
    attribute: str = "src",
    max_images: int = 100,
    work_dir: Optional[str] = None,
) -> str:
    """
    Scrape a gallery page to collect image URLs (from <img> or link tags) and download them.
    - css_selector: optional CSS selector for images/links; defaults to <img> and <a> with image-like href.
    - attribute: which attribute to read (src or href).
    Returns JSON with downloaded file paths and skipped entries.
    """
    try:
        headers = {"User-Agent": USER_AGENT}
        r = requests.get(page_url, headers=headers, timeout=20)
        r.raise_for_status()
        html = r.text
        base = str(r.url or page_url)

        urls: List[str] = []
        if css_selector:
            try:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(html, "html.parser")
                for el in soup.select(css_selector):
                    u = el.get(attribute)
                    if isinstance(u, str):
                        urls.append(urljoin(base, u))
            except Exception:
                pass
        if not urls:
            # Fallback: parse common <img> and <a href> patterns
            for m in re.finditer(r'<img[^>]+src="([^"]+)"', html, flags=re.I):
                urls.append(urljoin(base, html_lib.unescape(m.group(1))))
            for m in re.finditer(r'<a[^>]+href="([^"]+)"', html, flags=re.I):
                href = html_lib.unescape(m.group(1))
                if re.search(r'\.(?:png|jpg|jpeg|webp|gif)(?:\?|$)', href, flags=re.I):
                    urls.append(urljoin(base, href))

        # Deduplicate while preserving order
        seen = set()
        clean_urls = []
        for u in urls:
            if u not in seen:
                seen.add(u)
                clean_urls.append(u)
        clean_urls = clean_urls[:max_images]

        if not work_dir:
            work_dir = os.getcwd()
        os.makedirs(work_dir, exist_ok=True)

        from .file_tools import download_image
        downloaded: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []
        for idx, u in enumerate(clean_urls, 1):
            try:
                ext_match = re.search(r'\.([a-zA-Z0-9]{3,4})(?:\?|$)', u)
                ext = ext_match.group(1) if ext_match else "jpg"
                fname = f"gallery_{idx}.{ext}"
                dl_json = await download_image(u, fname, work_dir)
                dl = json.loads(dl_json)
                if dl.get("status") == "success":
                    downloaded.append({"url": u, "file_path": dl.get("file_path")})
                else:
                    skipped.append({"url": u, "error": dl})
            except Exception as e:
                skipped.append({"url": u, "error": str(e)})

        return json.dumps({
            "page_url": page_url,
            "collected": len(downloaded),
            "downloaded": downloaded,
            "skipped": skipped,
        }, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"scrape_image_gallery failed: {str(exc)}"})


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