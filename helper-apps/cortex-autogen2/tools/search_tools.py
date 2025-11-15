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
import aiohttp  # Add async HTTP client
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
        # CRITICAL: work_dir MUST be provided - no fallback allowed for parallel request isolation
        if not work_dir:
            raise ValueError(f"work_dir is REQUIRED for request isolation. Cannot use fallback - parallel requests must not interfere with each other.")
        os.makedirs(work_dir, exist_ok=True)

        from .file_tools import download_image  # local tool
        from .azure_blob_tools import upload_file_to_azure_blob  # uploader

        accepted: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []

        # Async verification using aiohttp for parallel checks
        async def is_image_ok_async(url: str, session: aiohttp.ClientSession) -> bool:
            """Async version of image verification for parallel execution."""
            if not verify_download:
                return True
            try:
                # Increased timeout from 5s to 15s - many image CDNs are slow (Reddit, eBay, etc.)
                async with session.head(url, timeout=aiohttp.ClientTimeout(total=15), allow_redirects=True) as response:
                    if response.status != 200:
                        return False
                    ct = (response.headers.get("content-type") or "").lower()
                    if ct.startswith("image/"):
                        return True
                    # If HEAD doesn't give content-type, try GET with small range
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=15), allow_redirects=True) as get_resp:
                        if get_resp.status == 200:
                            first_chunk = await get_resp.content.read(2048)
                            sigs = [b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"RIFF"]
                            return any(first_chunk.startswith(sig) for sig in sigs)
            except (asyncio.TimeoutError, aiohttp.ClientError):
                return False
            except Exception:
                return False
            return False

        # Parallel download/verification helper
        async def process_single_image(it: Dict[str, Any], idx: int, aio_session: aiohttp.ClientSession) -> Optional[Dict[str, Any]]:
            """Download, verify, and process a single image. Returns accepted dict or None if skipped."""
            try:
                img_url = it.get("original_url") or it.get("url")
                if not img_url:
                    skipped.append({"reason": "missing_url", "item": it})
                    return None

                # NO MOCK/fallback images - only process real URLs
                # Skip any local/mock files
                if it.get("_local_file") or not img_url.startswith(("http://", "https://")):
                    skipped.append({"reason": "mock_or_local_file", "url": img_url})
                    return None

                # Always verify images are downloadable
                if not await is_image_ok_async(img_url, aio_session):
                    skipped.append({"reason": "verify_failed", "url": img_url})
                    return None

                # Determine extension; if SVG, download as .svg then convert to PNG
                base = re.sub(r"[^a-zA-Z0-9_-]+", "_", (it.get("title") or "image").strip())[:80] or "image"
                url_lower = (img_url or "").lower()
                is_svg = url_lower.endswith(".svg") or ".svg" in url_lower
                filename = f"{base}_{idx+1}.svg" if is_svg else f"{base}_{idx+1}.jpg"
                dl_json = await download_image(img_url, filename, work_dir)
                dl = json.loads(dl_json)
                if dl.get("status") != "success":
                    skipped.append({"reason": "download_error", "url": img_url, "detail": dl})
                    return None

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
                        return None

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
                                return None
                except Exception:
                    pass

                # Compute hash for deduplication (will filter later)
                content_hash = None
                try:
                    if dedup_content and file_path and os.path.exists(file_path):
                        hasher = hashlib.sha256()
                        with open(file_path, "rb") as fh:
                            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                                hasher.update(chunk)
                        content_hash = hasher.hexdigest()
                except Exception:
                    pass

                # Upload if configured, else mark as local only
                azure_conn = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
                if azure_conn:
                    up_json = upload_file_to_azure_blob(file_path)
                    up = json.loads(up_json)
                    if "download_url" in up:
                        return {
                            "title": it.get("title"),
                            "source_page": it.get("host_page_url"),
                            "uploaded_url": up["download_url"],
                            "local_path": file_path,
                            "width": it.get("width"),
                            "height": it.get("height"),
                            "source_host": it.get("_host"),
                            "_content_hash": content_hash,
                        }
                    else:
                        skipped.append({"reason": "upload_error", "file_path": file_path, "detail": up})
                        return None
                else:
                    return {
                        "title": it.get("title"),
                        "source_page": it.get("host_page_url"),
                        "uploaded_url": None,
                        "local_path": file_path,
                        "width": it.get("width"),
                        "height": it.get("height"),
                        "source_host": it.get("_host"),
                        "note": "AZURE_STORAGE_CONNECTION_STRING not set; upload skipped",
                        "_content_hash": content_hash,
                    }
            except Exception as e:
                skipped.append({"reason": "processing_error", "error": str(e)})
                return None

        # Process images in parallel batches with connection pooling
        BATCH_SIZE = 15  # Balanced for connection pool (limit_per_host=10)
        all_results: List[Optional[Dict[str, Any]]] = []

        # Create aiohttp session with connection pooling for performance
        connector = aiohttp.TCPConnector(limit=30, limit_per_host=10)
        timeout = aiohttp.ClientTimeout(total=30, connect=10)

        async with aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            headers={"User-Agent": USER_AGENT, "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
        ) as aio_session:
            for batch_start in range(0, min(len(filtered), count * 3), BATCH_SIZE):  # Over-fetch to handle failures
                batch = filtered[batch_start:batch_start + BATCH_SIZE]
                # Early exit: stop processing new batches once we have enough
                if len(accepted) >= count:
                    logging.info(f"[collect_task_images] Early exit: {len(accepted)} images collected (target: {count})")
                    break

                # Process batch in parallel with shared session
                tasks = [process_single_image(it, batch_start + i, aio_session) for i, it in enumerate(batch)]
                batch_results = await asyncio.gather(*tasks, return_exceptions=True)

                # Filter out exceptions and add successful results
                for result in batch_results:
                    if not isinstance(result, Exception) and result is not None:
                        all_results.append(result)

        # Post-process: deduplicate by hash and limit to count
        seen_hashes: set = set()
        for result in all_results:
            if result is None:
                continue
            # Early exit once we have enough images
            if len(accepted) >= count:
                # Clean up any extra downloaded files beyond what we need
                try:
                    if result.get("local_path") and os.path.exists(result["local_path"]):
                        os.remove(result["local_path"])
                except Exception:
                    pass
                break

            # Deduplication check
            if dedup_content and result.get("_content_hash"):
                if result["_content_hash"] in seen_hashes:
                    skipped.append({"reason": "content_duplicate", "url": result.get("source_page")})
                    # Clean up duplicate file
                    try:
                        if result.get("local_path") and os.path.exists(result["local_path"]):
                            os.remove(result["local_path"])
                    except Exception:
                        pass
                    continue
                seen_hashes.add(result["_content_hash"])

            # Remove internal hash field before adding to accepted
            if "_content_hash" in result:
                del result["_content_hash"]
            accepted.append(result)

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
        # CRITICAL: work_dir MUST be provided - no fallback allowed for parallel request isolation
        if not work_dir:
            raise ValueError(f"work_dir is REQUIRED for request isolation. Cannot use fallback - parallel requests must not interfere with each other.")
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

        # CRITICAL: work_dir MUST be provided - no fallback allowed for parallel request isolation
        if not work_dir:
            raise ValueError(f"work_dir is REQUIRED for request isolation. Cannot use fallback - parallel requests must not interfere with each other.")
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


def _extract_json_path(data: Any, path: str) -> Optional[Any]:
    """
    Extract nested value from JSON using dot notation path.
    Supports array indices like '[0]' and nested paths like 'sprites.other.official-artwork.front_default'.
    Returns None if path is invalid or key doesn't exist.

    Examples:
        >>> _extract_json_path({'a': {'b': [1, 2]}}, 'a.b.[0]')
        1
        >>> _extract_json_path({'x': {'y': {'z': 42}}}, 'x.y.z')
        42
    """
    try:
        current = data
        parts = path.replace('[', '.[').split('.')
        for part in parts:
            if not part:
                continue
            if part.startswith('[') and part.endswith(']'):
                # Array index
                idx = int(part[1:-1])
                current = current[idx]
            else:
                # Dictionary key
                current = current[part]
        return current
    except (KeyError, IndexError, TypeError, ValueError):
        return None


async def fetch_entity_images(
    entities: List[str],
    entity_type: str = "",
    count_per_entity: int = 1,
    work_dir: Optional[str] = None,
    force_web_search: bool = False
) -> str:
    """
    Multi-tier entity image fetcher with automatic fallback:
    1. Try entity API registry (fast, reliable for known types)
    2. Fallback to web search (flexible, works for any entity)

    This generic tool works for ANY structured entity type (Pokemon, countries, movies, etc.)

    Args:
        entities: List of entity names to fetch images for (e.g., ["Gengar", "Mewtwo", "Alakazam"])
        entity_type: Type of entity (e.g., "pokemon", "country", "movie")
        count_per_entity: Number of images to fetch per entity (default: 1)
        work_dir: Directory to save downloaded images
        force_web_search: Skip API registry and go straight to web search fallback

    Returns:
        JSON with fetched entities, images, and fallback status
    """
    try:
        # CRITICAL: work_dir MUST be provided - no fallback allowed for parallel request isolation
        if not work_dir:
            raise ValueError(f"work_dir is REQUIRED for request isolation. Cannot use fallback - parallel requests must not interfere with each other.")
        os.makedirs(work_dir, exist_ok=True)

        from .file_tools import download_image
        from .azure_blob_tools import upload_file_to_azure_blob

        results: List[Dict[str, Any]] = []
        fallback_stats = {"api_success": 0, "api_failed": 0, "web_search_used": 0}

        # Load entity API registry
        registry_path = os.path.join(os.path.dirname(__file__), "entity_api_registry.json")
        registry = {}
        api_config = None

        if not force_web_search and os.path.exists(registry_path):
            try:
                with open(registry_path, 'r') as f:
                    registry = json.load(f)
                api_config = registry.get(entity_type.lower())
                if api_config and not api_config.get("enabled", True):
                    logging.info(f"[fetch_entity_images] API config for '{entity_type}' is disabled, using web search")
                    api_config = None
            except Exception as e:
                logging.warning(f"[fetch_entity_images] Failed to load registry: {e}")

        # Process each entity
        for entity_idx, entity_name in enumerate(entities):
            entity_result = {
                "entity": entity_name,
                "entity_type": entity_type,
                "images": [],
                "method": None,
                "error": None
            }

            # === TIER 1: Try API Registry ===
            if api_config and not force_web_search:
                try:
                    logging.info(f"[fetch_entity_images] Trying API for {entity_name} ({api_config.get('name')})")

                    # Check required env vars
                    if api_config.get("requires_env"):
                        missing_vars = [v for v in api_config["requires_env"] if not os.getenv(v)]
                        if missing_vars:
                            raise Exception(f"Missing required env vars: {missing_vars}")

                    # Transform entity name
                    transform = api_config.get("entity_transform", "none")
                    transformed_entity = entity_name
                    if transform == "lowercase":
                        transformed_entity = entity_name.lower()
                    elif transform == "uppercase":
                        transformed_entity = entity_name.upper()
                    elif transform == "slug":
                        transformed_entity = entity_name.lower().replace(" ", "-")

                    # Build URL
                    url_pattern = api_config["url_pattern"]
                    # Replace env vars in pattern
                    for env_var in re.findall(r'\{([A-Z_]+)\}', url_pattern):
                        if env_var != "entity":
                            url_pattern = url_pattern.replace(f"{{{env_var}}}", os.getenv(env_var, ""))
                    url = url_pattern.replace("{entity}", transformed_entity)

                    # Fetch API data
                    headers = {"User-Agent": USER_AGENT}
                    response = requests.get(url, headers=headers, timeout=15)
                    response.raise_for_status()
                    api_data = response.json()

                    # Extract image URLs using configured paths
                    image_fields = api_config.get("image_fields", [])
                    image_urls = []
                    for field_path in image_fields:
                        img_url = _extract_json_path(api_data, field_path)
                        if img_url and isinstance(img_url, str) and img_url.startswith("http"):
                            image_urls.append(img_url)
                            if len(image_urls) >= count_per_entity:
                                break

                    if not image_urls:
                        raise Exception(f"No valid image URLs found in API response (tried paths: {image_fields})")

                    # Download images from API
                    for img_idx, img_url in enumerate(image_urls[:count_per_entity]):
                        try:
                            # Determine extension
                            ext = "png"
                            if img_url.lower().endswith((".jpg", ".jpeg")):
                                ext = "jpg"
                            elif img_url.lower().endswith(".svg"):
                                ext = "svg"

                            safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "_", entity_name)[:50]
                            filename = f"{entity_type}_{safe_name}_{entity_idx+1}_{img_idx+1}.{ext}"

                            dl_json = await download_image(img_url, filename, work_dir)
                            dl = json.loads(dl_json)

                            if dl.get("status") == "success":
                                file_path = dl.get("file_path")

                                # Upload if Azure configured
                                azure_conn = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
                                uploaded_url = None
                                if azure_conn:
                                    try:
                                        up_json = upload_file_to_azure_blob(file_path)
                                        up = json.loads(up_json)
                                        uploaded_url = up.get("download_url")
                                    except Exception:
                                        pass

                                entity_result["images"].append({
                                    "source_url": img_url,
                                    "local_path": file_path,
                                    "uploaded_url": uploaded_url
                                })
                        except Exception as img_err:
                            logging.warning(f"[fetch_entity_images] Image download failed for {entity_name}: {img_err}")

                    if entity_result["images"]:
                        entity_result["method"] = f"api:{api_config.get('name')}"
                        fallback_stats["api_success"] += 1
                        logging.info(f"[fetch_entity_images] ✓ API success for {entity_name}: {len(entity_result['images'])} images")
                    else:
                        raise Exception("All image downloads failed")

                except Exception as api_error:
                    logging.warning(f"[fetch_entity_images] API failed for {entity_name}: {api_error}")
                    fallback_stats["api_failed"] += 1
                    entity_result["error"] = str(api_error)
                    # Will fall through to web search below

            # === TIER 2: Fallback to Web Search ===
            if not entity_result["images"]:
                try:
                    logging.info(f"[fetch_entity_images] Falling back to web search for {entity_name}")

                    # Use fallback search query if configured, otherwise construct better query
                    if api_config and api_config.get("fallback_search_query"):
                        search_query = api_config["fallback_search_query"].replace("{entity}", entity_name)
                    else:
                        # Create more specific queries that are likely to find relevant images
                        if entity_type == "pokemon":
                            search_query = f"{entity_name} pokemon official artwork character sprite"
                        elif entity_type == "country":
                            search_query = f"{entity_name} country flag official emblem"
                        elif entity_type == "character":
                            search_query = f"{entity_name} character official artwork portrait illustration"
                        elif entity_type == "movie":
                            search_query = f"{entity_name} movie poster official artwork"
                        else:
                            search_query = f"{entity_name} {entity_type} official image artwork"

                    # Use existing collect_task_images function
                    web_result_json = await collect_task_images(
                        query=search_query,
                        count=count_per_entity,
                        verify_download=True,
                        work_dir=work_dir,
                        required_terms=[entity_name.split()[0]],  # At least first word of entity name must match
                        strict_entity=False
                    )

                    web_result = json.loads(web_result_json)
                    accepted = web_result.get("accepted", [])

                    if accepted:
                        # Map web search results to our format
                        for img in accepted[:count_per_entity]:
                            entity_result["images"].append({
                                "source_url": img.get("source_page"),
                                "local_path": img.get("local_path"),
                                "uploaded_url": img.get("uploaded_url")
                            })

                        entity_result["method"] = "web_search_fallback"
                        fallback_stats["web_search_used"] += 1
                        logging.info(f"[fetch_entity_images] ✓ Web search success for {entity_name}: {len(entity_result['images'])} images")
                    else:
                        entity_result["error"] = "Web search found no suitable images"
                        logging.warning(f"[fetch_entity_images] Web search found no images for {entity_name}")

                except Exception as web_error:
                    entity_result["error"] = f"Web search failed: {str(web_error)}"
                    logging.error(f"[fetch_entity_images] Web search failed for {entity_name}: {web_error}")

            results.append(entity_result)

        # Count total images from all entities
        total_images_found = sum(len(entity_res.get("images", [])) for entity_res in results)
        fallback_stats["total_images"] = total_images_found

        # Calculate success - at least one image found
        success = total_images_found > 0 or len(entities) == 0  # Empty list is also "successful"

        return json.dumps({
            "success": success,
            "entity_type": entity_type,
            "total_entities": len(entities),
            "results": results,
            "stats": fallback_stats,
            "registry_available": api_config is not None
        }, indent=2)

    except Exception as exc:
        return json.dumps({"error": f"fetch_entity_images failed: {str(exc)}"}, indent=2) 