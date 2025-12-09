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
from typing import Dict, Any, List, Optional, Iterable
import hashlib
from PIL import Image
import asyncio  # Import asyncio
import aiohttp  # Add async HTTP client
import matplotlib.pyplot as plt
import pandas as pd
import re
import urllib.parse
import html as html_lib
from .google_cse import google_cse_search
from urllib.parse import urljoin, urlparse

logger = logging.getLogger(__name__)

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
        
        # Parse width/height - handle both int and string types
        def parse_dimension(val):
            if val is None:
                return None
            try:
                return int(val) if isinstance(val, (int, str)) else None
            except (ValueError, TypeError):
                return None
        
        width = parse_dimension(image_obj.get("width") or cse_image.get("width"))
        height = parse_dimension(image_obj.get("height") or cse_image.get("height"))
            
        normalized.append({
            "type": "image",
            "title": it.get("title") or cse_image.get("alt") or "",
            "url": img_url,
            "original_url": link or img_url,
            "thumbnail_url": image_obj.get("thumbnailLink") or img_url,
            "width": width,
            "height": height,
            "host_page_url": image_obj.get("contextLink") or it.get("link") or "",
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


async def _aggregate_cse_pages(base_query: str, search_type: str = "web", max_results: int = 30) -> List[Dict[str, Any]]:
    """
    Fetch multiple CSE pages (num=10, start stepping) and aggregate normalized results.
    """
    aggregated: List[Dict[str, Any]] = []
    page_size = 10
    # Google CSE supports num up to 10 per request; we paginate via start
    for start in range(1, max_results + 1, page_size):
        try:
            params = {
                "num": page_size,
                "start": start,
            }
            if search_type == "image":
                params["searchType"] = "image"
            payload_str = await google_cse_search(text=base_query, parameters=params)
            payload = json.loads(payload_str)
        except Exception as exc:
            logging.warning(f"[CSE paginate] error fetching page start={start} q={base_query}: {exc}")
            continue
        if not payload or "items" not in payload:
            # Stop if no items
            break
        if search_type == "image":
            aggregated.extend(_normalize_cse_image_results(payload))
        else:
            aggregated.extend(_normalize_cse_web_results(payload))
        # If fewer than page_size items returned, likely no more pages
        if len(payload.get("items", [])) < page_size:
            break
    return aggregated


def _variant_queries(q: str) -> List[str]:
    """
    Build query variants to broaden coverage when CSE is sparse.
    NOTE: Do NOT use operators like filetype:, site:, inurl: - they don't work with Google CSE.
    """
    variants = [q]
    # Add data format context as regular words (NOT as operators)
    variants.append(f"{q} CSV download")
    variants.append(f"{q} data")
    # Add source context as regular words
    if "FRED" not in q.upper():
        variants.append(f"{q} FRED")
    # Try simplifying by removing all-caps codes (likely API identifiers)
    simplified = re.sub(r'\b[A-Z]{5,}\b', '', q).strip()
    if simplified and simplified != q:
        variants.append(simplified)
    # Dedup while preserving order
    seen = set()
    uniq = []
    for v in variants:
        v = v.strip()
        if v and v not in seen:
            uniq.append(v)
            seen.add(v)
    return uniq
def _has_google_cse_env() -> bool:
    """Check if Google CSE is properly configured."""
    key = os.getenv("GOOGLE_CSE_KEY")
    cx = os.getenv("GOOGLE_CSE_CX")

    if not key or not cx:
        logging.debug("[google_cse] Missing GOOGLE_CSE_KEY or GOOGLE_CSE_CX environment variables")
        return False

    # Additional validation - check if they look like real credentials
    if key.startswith("your_") or cx.startswith("your_"):
        logging.debug("[google_cse] Using placeholder credentials - CSE disabled")
        return False

    return True



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


def _safe_filename_from_url(url: str) -> str:
    """Generate a safe filename from URL."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = parsed.netloc.replace('www.', '').replace('.', '_')
    safe_path = parsed.path.strip('/').replace('/', '_') or 'index'
    # Remove unsafe characters
    safe_path = re.sub(r'[^\w\-_]', '_', safe_path)
    if len(safe_path) > 100:
        safe_path = safe_path[:100]
    filename = f"{host}_{safe_path}.html"
    return filename


def _save_html_to_workdir(work_dir: str, url: str, html: str) -> str:
    """Save full HTML content to work directory."""
    os.makedirs(work_dir, exist_ok=True)
    filename = _safe_filename_from_url(url)
    path = os.path.join(work_dir, filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    return path


async def fetch_webpage(url: str, render: bool = False, timeout_s: int = 20, max_chars: int = 200000, work_dir: Optional[str] = None) -> str:
    """
    Fetch a full webpage and return structured JSON with title, html, and extracted text.
    - render=False: simple HTTP fetch (no JS)
    - render=True: try Playwright to render JS (falls back to simple fetch if unavailable)
    - work_dir: If provided, automatically saves FULL HTML to a file (not truncated)
    """
    try:
        # Normalize URL
        if not re.match(r'^https?://', url):
            url = 'https://' + url

        headers = {"User-Agent": USER_AGENT}
        saved_html_path = None

        # Helper: requests-based fetch
        def fetch_via_requests(target_url: str) -> Dict[str, Any]:
            r = requests.get(target_url, headers=headers, timeout=timeout_s)
            r.raise_for_status()
            html = r.text
            
            # Save FULL HTML to file if work_dir provided
            saved_html_path = None
            if work_dir:
                try:
                    saved_html_path = _save_html_to_workdir(work_dir, target_url, html)
                except Exception as e:
                    logger.warning(f"Failed to save HTML to work_dir: {e}")
            
            # Title
            mt = re.search(r'<title[^>]*>([\s\S]*?)</title>', html, flags=re.I)
            title = html_lib.unescape(mt.group(1)).strip() if mt else None
            # Meta description
            md = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
            if not md:
                md = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
            meta_desc = html_lib.unescape(md.group(1)).strip() if md else None
            text = _html_to_text(html, max_chars=max_chars)
            
            # When work_dir is provided, return minimal JSON (no huge HTML) - guide LLM to use saved file
            if saved_html_path:
                result = {
                    "url": str(r.url or target_url),
                    "title": title,
                    "meta_description": meta_desc,
                    "text": text[:500],  # Very small text preview (<1KB) since we have file path
                    "saved_html": saved_html_path,
                    "note": "Full HTML saved to file. Use saved_html path for pandas.read_html() or file operations."
                }
            else:
                # No work_dir: return HTML in response (backward compatibility)
                result = {
                    "url": str(r.url or target_url),
                    "title": title,
                    "meta_description": meta_desc,
                    "html": html if len(html) <= max_chars else html[:max_chars],  # Truncated for JSON response
                    "text": text,
                }
            return result

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
            saved_html_path = None
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

                # Save FULL HTML to file if work_dir provided
                if work_dir:
                    try:
                        saved_html_path = _save_html_to_workdir(work_dir, final_url, html)
                    except Exception as e:
                        logger.warning(f"Failed to save HTML to work_dir: {e}")

                text = _html_to_text(html, max_chars=max_chars)
                # Meta description from rendered HTML
                md = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
                if not md:
                    md = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, flags=re.I)
                meta_desc = html_lib.unescape(md.group(1)).strip() if md else None

                # When work_dir is provided, return minimal JSON (no huge HTML) - guide LLM to use saved file
                if saved_html_path:
                    data = {
                        "url": final_url,
                        "title": title or None,
                        "meta_description": meta_desc,
                        "text": text[:500],  # Very small text preview (<1KB) since we have file path
                        "saved_html": saved_html_path,
                        "note": "Full HTML saved to file. Use saved_html path for pandas.read_html() or file operations."
                    }
                else:
                    # No work_dir: return HTML in response (backward compatibility)
                    data = {
                        "url": final_url,
                        "title": title or None,
                        "meta_description": meta_desc,
                        "html": html if len(html) <= max_chars else html[:max_chars],  # Truncated for JSON response
                        "text": text,
                    }
                return json.dumps(data, indent=2)
        except Exception:
            # Fallback to non-rendered fetch on any Playwright runtime error
            data = fetch_via_requests(url)
            return json.dumps(data, indent=2)
    except Exception as exc:
        return json.dumps({"error": f"Fetch failed: {str(exc)}"})



async def web_search(query: str, count: int = 25) -> str:
    """
    Search the web using Google Custom Search. Returns JSON array of results with title, url, and snippet.
    
    CRITICAL USAGE GUIDELINES:
    - Use NATURAL LANGUAGE queries - write queries the way a human would ask Google
    - Do NOT use search operators (site:, filetype:, inurl:, quoted strings) - they return ZERO results
    - Do NOT use API codes or database identifiers - describe concepts in plain English instead
    - Use FULL NAMES instead of abbreviations or ISO codes
    - If a query returns no results, simplify by removing technical terms
    
    Args:
        query: Natural language search query describing what data you're looking for
        count: Maximum number of results to return (default 25, max 100)
    
    Returns:
        JSON string with array of results or {"status": "No relevant results found."}
    """
    try:
        results: List[Dict[str, Any]] = []
        if _has_google_cse_env():
            # Expand variants and paginate to aggregate richer results
            variants = _variant_queries(query)
            # Default page size 10; honor requested count up to 100
            target = max(10, min(count, 100))
            for v in variants:
                results.extend(await _aggregate_cse_pages(v, search_type="web", max_results=target))
                if len(results) >= target:
                    break

        if not results:
            return json.dumps({"status": "No relevant results found."})

        # Trim to requested count (no dedupe to preserve all variants)
        return json.dumps(results[:count], indent=2)
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
            # Fallback: use requests with headers
            headers = {"User-Agent": USER_AGENT}
            r = requests.get(url, headers=headers, stream=True, timeout=timeout, allow_redirects=True)
        else:
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
    """
    Search for images using Google Custom Search. Returns JSON array of image results with URLs.
    
    USAGE GUIDELINES:
    - Use NATURAL LANGUAGE queries describing what image you want
    - Do NOT use search operators (site:, filetype:, inurl:) - they may return no results
    - Use descriptive terms that would appear on image hosting sites
    
    Args:
        query: Natural language description of the image you're looking for
        count: Maximum number of images to return (default 25)
        verify_download: Whether to verify images are downloadable (default True)
        required_terms: Optional list of terms that must appear in image title/URL
        allowed_domains: Optional list of allowed domain names
        strict_entity: If True, require entity name in image metadata
    
    Returns:
        JSON string with array of image results or error status
    """
    try:
        # Enhanced query variants - prioritize high-quality results with diverse strategies
        def generate_query_variants(q: str) -> List[str]:
            base = q.strip()
            base_lower = base.lower()
            
            # Smart variant generation: Don't add quality terms if they're already present
            has_quality_term = any(term in base_lower for term in ["high resolution", "hd", "4k", "professional", "official", "quality"])
            has_art_term = any(term in base_lower for term in ["artwork", "art", "illustration", "photo", "image", "picture"])
            
            variants = []
            
            # Primary: Add quality term if not present
            if not has_quality_term:
                variants.append(f"{base} high resolution")
                variants.append(f"{base} official")
            else:
                variants.append(base)  # Use base if quality term already present
            
            # Secondary: Add art/photo context if not present (helps find actual images vs icons)
            if not has_art_term:
                variants.append(f"{base} artwork")
                variants.append(f"{base} photo")
            else:
                variants.append(base)
            
            # Tertiary: Professional/HD variants
            variants.append(f"{base} professional")
            variants.append(f"{base} hd")
            
            # Fallback: exact query
            if base not in variants:
                variants.append(base)
            
            # Remove duplicates while preserving order
            seen = set()
            unique_variants = []
            for v in variants:
                if v not in seen:
                    seen.add(v)
                    unique_variants.append(v)
            
            return unique_variants[:6]  # Limit to 6 variants

        results: List[Dict[str, Any]] = []
        # Prefer Google CSE when configured; try multiple high-quality variants with size filters
        if _has_google_cse_env():
            try:
                logging.info(f"[image_search] Using Google CSE for query: {query}")
                variants = generate_query_variants(query)[:3]  # Use top 3 variants for better coverage
                
                # Create multiple search strategies with different size filters
                search_strategies = [
                    # Strategy 1: Large images (best quality)
                    {
                        "num": max(1, min(count * 2, 10)),  # Fetch more to have selection headroom
                        "searchType": "image",
                        "imgSize": "large",  # Filter for large images
                        "safe": "active",
                    },
                    # Strategy 2: Medium+ images (good quality, more results)
                    {
                        "num": max(1, min(count * 2, 10)),
                        "searchType": "image",
                        "imgSize": "medium",  # Medium images
                        "safe": "active",
                    },
                    # Strategy 3: No size filter (fallback for rare queries)
                    {
                        "num": max(1, min(count, 10)),
                        "searchType": "image",
                        "safe": "active",
                    },
                ]
                
                # Combine variants with strategies - use ALL variants and strategies for maximum coverage
                tasks = []
                for variant in variants:  # Use all variants for better coverage
                    for strategy in search_strategies:  # Use all strategies
                        params = dict(strategy)
                        tasks.append(google_cse_search(text=variant, parameters=params))
                
                raws = await asyncio.gather(*tasks, return_exceptions=True)
                merged: List[Dict[str, Any]] = []
                for raw in raws:
                    if isinstance(raw, Exception):
                        logging.warning(f"[image_search] Google CSE task raised exception: {raw}")
                        continue
                    try:
                        data = json.loads(raw) if raw else {}
                        # Check for error in response
                        if isinstance(data, dict) and "error" in data:
                            error_msg = data.get("error", "Unknown error")
                            logging.error(f"[image_search] Google CSE API error: {error_msg}")
                            # If it's a credential/config error, log it clearly
                            if "400" in str(error_msg) or "401" in str(error_msg) or "403" in str(error_msg):
                                logging.error(f"[image_search] CRITICAL: Google CSE credentials may be invalid or API quota exceeded. Check GOOGLE_CSE_KEY and GOOGLE_CSE_CX environment variables.")
                            continue
                        # Only normalize if we have items
                        if isinstance(data, dict) and "items" in data:
                            merged.extend(_normalize_cse_image_results(data))
                        else:
                            logging.debug(f"[image_search] Google CSE response has no 'items' key: {list(data.keys()) if isinstance(data, dict) else 'not a dict'}")
                    except Exception as e:
                        logging.warning(f"[image_search] Failed to process Google CSE response: {e}")
                        continue
                results = merged
                logging.info(f"[image_search] Google CSE returned {len(results)} raw results")
            except Exception as e:
                logging.warning(f"[image_search] Google CSE failed: {e}")
                results = []



        # NO FALLBACK: Only use real Google CSE results - no mock/fallback images
        if not results:
            # Check if Google CSE is configured but returned errors
            if _has_google_cse_env():
                logging.error(f"[image_search] Google CSE is configured but returned no results for query: {query}. This may indicate invalid credentials, API quota exceeded, or no matching images found.")
                return json.dumps({
                    "status": "No images found",
                    "error": "Google CSE returned no results. Please verify GOOGLE_CSE_KEY and GOOGLE_CSE_CX are valid and API quota is available.",
                    "query": query
                })
            else:
                logging.warning(f"[image_search] Google CSE not configured. Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX environment variables.")
                return json.dumps({
                    "status": "No images found",
                    "error": "Google CSE is not configured. Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX environment variables to enable image search.",
                    "query": query
                })

        # Enhanced post-filtering and ranking for relevance and quality
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
            s += 15 * title_overlap  # Increased from 10 to 15 for stronger relevance
            
            # Secondary relevance: query terms in URL
            url_overlap = len(q_terms & u_terms)
            s += 8 * url_overlap  # Increased from 5 to 8
            
            # CRITICAL: If NO query terms match title or URL, heavily penalize
            if title_overlap == 0 and url_overlap == 0:
                s -= 150  # Increased penalty from -100 to -150
            
            # Reward trusted/quality domains (prioritize official artwork sources)
            trusted_domains = ["wikipedia.org", "wikimedia.org", "commons.wikimedia.org", "flickr.com", 
                              "unsplash.com", "pexels.com", "pixabay.com", "gettyimages.com", "shutterstock.com",
                              "deviantart.com", "artstation.com", "pinterest.com", "official", "press", "news", "media"]
            for domain in trusted_domains:
                if domain in host:
                    s += 12  # Increased boost for trusted sources
                    break
            
            # Lightly penalize low-quality commercial sources (but don't exclude completely)
            low_quality_sources = ["ebay.com", "etsy.com", "amazon.com", "alibaba.com", "aliexpress.com"]
            if any(source in host for source in low_quality_sources):
                s -= 3  # Light penalty, but still allow these sources
            
            # Quality signals - prefer PNG/JPG over SVG/GIF
            for ext, ext_score in ((".png", 3), (".jpg", 3), (".jpeg", 3), (".webp", 1), (".svg", -2), (".gif", -1)):
                if url.endswith(ext) or (item.get("original_url") or "").lower().endswith(ext):
                    s += ext_score
                    break
            
            # STRONGER penalties for low-quality/irrelevant assets
            negative_tokens = ["sprite", "icon", "thumbnail", "thumb", "small", "mini", "logo", "watermark", 
                             "stock", "avatar", "emoji", "low-res", "lowres", "blurry", "pixelated",
                             "boxshot", "box-shot", "cover-art", "game-cover", "screenshot", "screen-shot",
                             "clip-art", "clipart", "sticker"]
            s -= 10 * sum(1 for tok in negative_tokens if tok in url or tok in title)  # Increased from 8 to 10
            
            # Lightly prefer artwork over game screenshots/box art (but don't exclude completely)
            if any(term in query.lower() for term in ["artwork", "art", "illustration", "character"]):
                if any(tok in url.lower() or tok in title.lower() for tok in ["boxshot", "box-shot", "cover-art", "game-cover", "screenshot"]):
                    s -= 5  # Light penalty, but still allow these images
            
            # STRONGER rewards for quality descriptors
            positive_tokens = ["official", "press", "hd", "4k", "wallpaper", "hero", "high-res", "highres", 
                             "high resolution", "professional", "quality", "sharp", "clear", "photography",
                             "photo", "image", "picture", "artwork", "illustration", "portrait"]
            s += 6 * sum(1 for tok in positive_tokens if tok in title or tok in url)  # Increased from 4 to 6
            
            # Reward larger dimensions (more aggressive scoring)
            try:
                w = int(item.get("width") or 0)
                h = int(item.get("height") or 0)
                area = w * h
                min_dimension = min(w, h) if w > 0 and h > 0 else 0
                
                # Penalize very small images but don't completely filter them out
                if min_dimension > 0 and min_dimension < 300:
                    s -= 15  # Penalty for very small images (< 300px)
                elif min_dimension > 0 and min_dimension < 400:
                    s -= 5  # Light penalty for small images (300-400px)
                
                # Size scoring based on area
                if area >= 3840 * 2160:     # 4K or larger
                    s += 20  # Increased from 15
                elif area >= 1920 * 1080:   # Full HD or larger
                    s += 15  # Increased from 12
                elif area >= 1280 * 720:    # HD
                    s += 10  # Increased from 8
                elif area >= 800 * 600:     # Decent size
                    s += 5  # Increased from 3
                elif area > 0 and area < 500 * 500:  # Too small (increased threshold)
                    s -= 15  # Increased penalty from -10
            except Exception:
                pass
            
            # STRONGER penalty for thumbnails
            if ("thumb" in url or "thumbnail" in url) and not item.get("original_url"):
                s -= 15  # Increased from -5
            
            # Penalize very long URLs (often CDN/redirect chains)
            if len(url) > 200:
                s -= 3
            
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
        # Lower threshold to allow more variety - only filter out truly irrelevant images
        MIN_RELEVANCE_SCORE = 5  # Lower threshold to allow more images through
        deduped = [it for it in deduped if score_with_penalty(it) >= MIN_RELEVANCE_SCORE]
        
        # Additional quality filter: Remove images with strongly negative scores (heavily penalized)
        deduped = [it for it in deduped if score_with_penalty(it) > -50]  # Only filter out heavily penalized images
        
        # Don't filter by size - let scoring handle it (small images will be ranked lower but still available)

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


def _deduplicate_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove duplicate results based on URL."""
    seen_urls = set()
    unique_results = []
    for result in results:
        url = result.get("url") or result.get("link")
        if url and url not in seen_urls:
            seen_urls.add(url)
            unique_results.append(result)
    return unique_results


async def combined_search(query: str, count: int = 25) -> str:
    """
    Combined parallel search - runs all search functions in parallel.
    Returns merged, deduplicated results from web_search, image_search, google_cse_search, and collect_images.
    """
    try:
        # Run all 5 search functions in parallel
        tasks = [
            web_search(query, count),
            image_search(query, count),
            google_cse_search(text=query, parameters={"num": max(1, min(count, 10))}),
            google_cse_search(text=query, parameters={"num": max(1, min(count, 10)), "searchType": "image"}),
            collect_images(query, count),
        ]
        
        search_results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Parse and extract results from each
        all_results: List[Dict[str, Any]] = []
        
        # 1. web_search - returns list of web results
        if not isinstance(search_results[0], Exception):
            try:
                web_data = json.loads(search_results[0]) if isinstance(search_results[0], str) else search_results[0]
                if isinstance(web_data, list):
                    all_results.extend(web_data)
                elif isinstance(web_data, dict) and "error" not in web_data and "status" not in web_data:
                    # Handle dict response
                    if "results" in web_data:
                        all_results.extend(web_data["results"])
            except Exception as e:
                logger.warning(f"[combined_search] Failed to parse web_search results: {e}")
        
        # 2. image_search - returns list of image results
        if not isinstance(search_results[1], Exception):
            try:
                img_data = json.loads(search_results[1]) if isinstance(search_results[1], str) else search_results[1]
                if isinstance(img_data, list):
                    all_results.extend(img_data)
                elif isinstance(img_data, dict) and "error" not in img_data and "status" not in img_data:
                    if "results" in img_data:
                        all_results.extend(img_data["results"])
            except Exception as e:
                logger.warning(f"[combined_search] Failed to parse image_search results: {e}")
        
        # 3. google_cse_search (web) - raw CSE, need to normalize
        if not isinstance(search_results[2], Exception):
            try:
                raw_web = json.loads(search_results[2]) if isinstance(search_results[2], str) else search_results[2]
                if isinstance(raw_web, dict) and "error" not in raw_web:
                    cse_web_results = _normalize_cse_web_results(raw_web)
                    all_results.extend(cse_web_results)
            except Exception as e:
                logger.warning(f"[combined_search] Failed to parse google_cse_search (web) results: {e}")
        
        # 4. google_cse_search (image) - raw CSE, need to normalize
        if not isinstance(search_results[3], Exception):
            try:
                raw_img = json.loads(search_results[3]) if isinstance(search_results[3], str) else search_results[3]
                if isinstance(raw_img, dict) and "error" not in raw_img:
                    cse_img_results = _normalize_cse_image_results(raw_img)
                    all_results.extend(cse_img_results)
            except Exception as e:
                logger.warning(f"[combined_search] Failed to parse google_cse_search (image) results: {e}")
        
        # 5. collect_images - returns {"images": [...]}
        if not isinstance(search_results[4], Exception):
            try:
                collect_data = json.loads(search_results[4]) if isinstance(search_results[4], str) else search_results[4]
                if isinstance(collect_data, dict):
                    if "images" in collect_data:
                        all_results.extend(collect_data["images"])
                    elif "error" not in collect_data and "status" not in collect_data:
                        # Might return list directly
                        if isinstance(collect_data.get("results"), list):
                            all_results.extend(collect_data["results"])
            except Exception as e:
                logger.warning(f"[combined_search] Failed to parse collect_images results: {e}")
        
        # Deduplicate by URL
        unique_results = _deduplicate_results(all_results)
        
        if not unique_results:
            return json.dumps({"status": "No relevant results found."})
        
        return json.dumps(unique_results, indent=2)
    except Exception as exc:
        logger.error(f"[combined_search] Unexpected error: {exc}")
        return json.dumps({"error": f"Combined search failed: {str(exc)}"})


async def collect_images(query: str, count: int = 10, work_dir: Optional[str] = None) -> str:
    """
    Collect and download images using Google CSE web search.

    Args:
        query: Search terms for images
        count: Number of images to collect (max 10)
        work_dir: Working directory for downloads - if provided, images are downloaded to local files

    Returns:
        JSON string with collected images (includes local_path if work_dir provided)
    """
    import aiohttp
    import hashlib
    import os
    
    try:
        # Use Google CSE for image search
        raw_payload = await google_cse_search(text=query, parameters={"searchType": "image", "num": min(count, 10)})
        cse_payload = json.loads(raw_payload) if raw_payload else {}
        images = _normalize_cse_image_results(cse_payload)

        # Download and verify images
        verified_images = []
        for img in images[:count * 2]:  # Try more to get enough
            if len(verified_images) >= count:
                break
            try:
                url = img.get("url", "")
                if not url:
                    continue
                    
                # If work_dir provided, actually download the image
                if work_dir:
                    try:
                        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                        async with aiohttp.ClientSession() as session:
                            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                                if resp.status == 200:
                                    content_type = resp.headers.get('Content-Type', '')
                                    if 'image' in content_type.lower():
                                        data = await resp.read()
                                        if len(data) > 1000:  # Minimum size check
                                            # Generate clean filename from query
                                            safe_query = "".join(c if c.isalnum() else "_" for c in query[:30])
                                            ext = ".jpg" if "jpeg" in content_type or "jpg" in url.lower() else ".png"
                                            filename = f"{safe_query}_{len(verified_images)+1}{ext}"
                                            filepath = os.path.join(work_dir, filename)
                                            with open(filepath, 'wb') as f:
                                                f.write(data)
                                            img["local_path"] = filepath
                                            img["local_filename"] = filename
                                            verified_images.append(img)
                                            logger.info(f"Downloaded image: {filename}")
                    except Exception as e:
                        logger.warning(f"Failed to download {url}: {e}")
                        continue
                else:
                    # No work_dir - just verify URL is downloadable
                    if _is_downloadable_image(url):
                        verified_images.append(img)
            except:
                continue

        return json.dumps({"images": verified_images[:count], "downloaded": work_dir is not None})
    except Exception as e:
        return json.dumps({"error": f"collect_images failed: {str(e)}"})



# Export FunctionTool-wrapped versions
from autogen_core.tools import FunctionTool

image_search_tool = FunctionTool(
    image_search,
    description="Search for images using Google CSE. Use natural language queries describing the image you want - avoid operators like site:, filetype:. Returns normalized image results with verification."
)

collect_images_tool = FunctionTool(
    collect_images,
    description="Collect and DOWNLOAD images using Google CSE. When work_dir is provided, images are downloaded to local files and local_path is included in results. Use this when you need actual image files for presentations/documents."
)

web_search_tool = FunctionTool(
    web_search,
    description="Search for web pages using Google CSE. IMPORTANT: Use natural language queries only - do NOT use operators like site:, filetype:, or quoted strings as they return zero results. Use full names instead of codes/abbreviations. Returns normalized results with title, URL, and snippet."
)

combined_search_tool = FunctionTool(
    combined_search,
    description="Combined parallel search - runs web_search, image_search, google_cse_search (web), google_cse_search (image), and collect_images in parallel. Returns merged, deduplicated results. Use this for comprehensive search. For fetching specific URLs, use fetch_webpage or cortex_browser directly."
)

def get_fetch_webpage_tool(work_dir: Optional[str] = None):
    """
    Factory function to create fetch_webpage tool with work_dir bound.
    When work_dir is provided, fetch_webpage automatically saves FULL HTML to files.
    """
    
    async def fetch_webpage_bound(url: str, render: bool = False, timeout_s: int = 20, max_chars: int = 200000) -> str:
        """Bound version of fetch_webpage with work_dir automatically set."""
        return await fetch_webpage(url, render=render, timeout_s=timeout_s, max_chars=max_chars, work_dir=work_dir)
    
    return FunctionTool(
        fetch_webpage_bound,
        description="Fetch a specific webpage by URL (not query). Takes URL as input, not search query. Use this AFTER search results to get full HTML content. Automatically saves HTML to file when work_dir is provided."
    )


# Keep unbound version for backward compatibility
fetch_webpage_tool = FunctionTool(
    fetch_webpage,
    description="Fetch a specific webpage by URL (not query). Takes URL as input, not search query. Use this AFTER search results to get full HTML content. Automatically saves HTML to file when work_dir is provided."
)
