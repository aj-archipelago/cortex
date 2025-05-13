import azure.functions as func
import logging
import json
import base64
import time
import os
import tempfile
import re
import asyncio
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError
import trafilatura
from typing import Union, Dict, Any, Tuple, Optional
import shutil
from aiohttp import web # Added for local server

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

# Get global timeout from environment variable, default to 20
timeout_str = os.environ.get("GLOBAL_TIMEOUT_SECONDS", "20")
try:
    GLOBAL_TIMEOUT_SECONDS = int(timeout_str)
except ValueError:
    logging.warning(f"Invalid GLOBAL_TIMEOUT_SECONDS environment variable '{timeout_str}'. Defaulting to 20.")
    GLOBAL_TIMEOUT_SECONDS = 20

MIN_TIME_FOR_STEP = 0.5  # Minimum time to allow for any single step if budget is very low
BUFFER_FOR_CLEANUP_AND_PROCESSING = 2  # Reserve N seconds for trafilatura, screenshot, and cleanup
SCREENSHOT_DIR_PLAYWRIGHT = "downloaded_files/playwright_screenshots"

def get_remaining_time(start_time: float, budget_for_step: Union[float, None] = None) -> float:
    """Calculates remaining time from the global timeout."""
    elapsed_time = time.time() - start_time
    remaining_global_time = GLOBAL_TIMEOUT_SECONDS - elapsed_time
    if budget_for_step is not None:
        safe_budget = min(budget_for_step, remaining_global_time - BUFFER_FOR_CLEANUP_AND_PROCESSING)
        return max(MIN_TIME_FOR_STEP, safe_budget)
    return max(0, remaining_global_time - BUFFER_FOR_CLEANUP_AND_PROCESSING)

def sanitize_filename(url_or_name: str) -> str:
    """Sanitizes a string to be a valid filename."""
    # Remove http(s)://
    name = re.sub(r'^https?://', '', url_or_name)
    # Replace non-alphanumeric characters (except . - _) with underscores
    name = re.sub(r'[^a-zA-Z0-9._-]', '_', name)
    # Truncate if too long
    return name[:100] 

# --- Task for Text Extraction ---
async def _task_extract_text(page, start_time: float) -> Tuple[Optional[str], Optional[str]]:
    extracted_text = None
    html_content = None
    error_message = None
    timed_out_early_task = False

    try:
        logging.info("[Text Task] Attempting primary text extraction with body.inner_text()...")
        primary_inner_text_budget_s = get_remaining_time(start_time, budget_for_step=7)
        if primary_inner_text_budget_s < MIN_TIME_FOR_STEP:
            logging.warning(f"[Text Task] Skipping primary body.inner_text() due to insufficient time ({primary_inner_text_budget_s:.2f}s).")
        else:
            logging.info(f"[Text Task] Allocating {primary_inner_text_budget_s:.2f}s for primary body.inner_text().")
            try:
                body_text_pl = await asyncio.wait_for(page.locator('body').inner_text(timeout=primary_inner_text_budget_s * 1000), timeout=primary_inner_text_budget_s + 0.5)
                if body_text_pl:
                    extracted_text = body_text_pl.strip()
                    logging.info(f"[Text Task] Captured primary text via body.inner_text(), length: {len(extracted_text)}.")
                else:
                    logging.warning("[Text Task] Primary body.inner_text() was empty.")
            except asyncio.TimeoutError:
                logging.warning(f"[Text Task] Timeout ({primary_inner_text_budget_s:.2f}s) during primary body.inner_text().")
                timed_out_early_task = True
            except Exception as e_primary_body_text:
                logging.warning(f"[Text Task] Error during primary body.inner_text(): {e_primary_body_text}.")
                error_message = f"Error during inner_text: {e_primary_body_text}"

        if not extracted_text and not timed_out_early_task:
            logging.info("[Text Task] Attempting to fetch page.content() for Trafilatura fallback.")
            page_content_budget_s = get_remaining_time(start_time, budget_for_step=15)
            if page_content_budget_s < MIN_TIME_FOR_STEP * 2:
                logging.warning(f"[Text Task] Skipping page.content() fetch due to insufficient time ({page_content_budget_s:.2f}s).")
            else:
                logging.info(f"[Text Task] Allocating {page_content_budget_s:.2f}s for page.content().")
                try:
                    html_content = await asyncio.wait_for(page.content(), timeout=page_content_budget_s)
                    if html_content:
                        logging.info(f"[Text Task] Successfully fetched page.content(), length: {len(html_content)}.")
                    else:
                        logging.warning("[Text Task] page.content() returned None or empty.")
                        html_content = None
                except asyncio.TimeoutError:
                    logging.warning(f"[Text Task] Timeout ({page_content_budget_s:.2f}s) while getting page.content(). html_content will be None.")
                    html_content = None
                    timed_out_early_task = True
                except Exception as e_final_ps:
                    logging.warning(f"[Text Task] Could not get final page.content(): {e_final_ps}")
                    if not error_message: error_message = f"Failed to get page.content(): {e_final_ps}"
                    html_content = None
        elif not timed_out_early_task:
             logging.info("[Text Task] Skipping page.content() fetch as inner_text succeeded or timed out.")

        if html_content and not extracted_text and not timed_out_early_task:
            try:
                logging.info("[Text Task] Attempting Trafilatura text extraction as fallback...")
                trafilatura_text = trafilatura.extract(html_content, include_comments=False)
                if trafilatura_text:
                    extracted_text = trafilatura_text.strip()
                    logging.info(f"[Text Task] Trafilatura extracted fallback text, length: {len(extracted_text)}. This will be used.")
                else:
                    logging.warning(f"[Text Task] Trafilatura fallback extraction yielded no text.")
            except Exception as e_traf:
                logging.error(f"[Text Task] Trafilatura fallback error: {e_traf}")
                if not error_message: error_message = f"Trafilatura fallback failed: {e_traf}"
        
        if not extracted_text and not error_message:
             logging.warning("[Text Task] Text extraction attempts failed or yielded no text.")

    except Exception as e_task_text:
        logging.error(f"[Text Task] Unexpected error during text extraction: {e_task_text}")
        error_message = error_message or f"Unexpected text task error: {e_task_text}"

    return extracted_text, error_message

# --- Task for Screenshot Capture ---
async def _task_capture_screenshot(page, context, start_time: float) -> Tuple[Optional[bytes], Optional[str]]:
    screenshot_bytes = None
    error_message = None
    cdp_session_ss = None 

    try:
        logging.info("[Screenshot Task] Starting screenshot capture process...")
        try:
            logging.info("[Screenshot Task] Scrolling to top and modifying fixed elements...")
            scroll_modify_budget = get_remaining_time(start_time, budget_for_step=3)
            if scroll_modify_budget < MIN_TIME_FOR_STEP / 2:
                logging.warning(f"[Screenshot Task] Skipping scroll/modify due to time ({scroll_modify_budget:.2f}s)")
            else:
                await asyncio.wait_for(page.evaluate("window.scrollTo(0, 0)"), timeout=scroll_modify_budget / 2)
                modified_count = await asyncio.wait_for(page.evaluate(
                     """() => { 
                        let m_count = 0;
                        const allElements = document.querySelectorAll('*');
                        allElements.forEach(el => {
                            if (el.tagName !== 'BODY' && el.tagName !== 'HTML') {
                                const style = window.getComputedStyle(el);
                                if (style.position === 'fixed') {
                                    el.style.position = 'absolute';
                                    m_count++;
                                }
                            }
                        });
                        return m_count;
                     }"""
                ), timeout=scroll_modify_budget / 2)
                logging.info(f"[Screenshot Task] {modified_count} fixed elements modified.")
                await asyncio.sleep(0.3)
        except Exception as e_scroll_modify:
            logging.warning(f"[Screenshot Task] Error during scroll/modify: {e_scroll_modify}")

        try:
            logging.info("[Screenshot Task] Attempting CDP full page screenshot...")
            metrics_budget = get_remaining_time(start_time, budget_for_step=1)
            cdp_capture_budget = get_remaining_time(start_time, budget_for_step=10)

            if metrics_budget < MIN_TIME_FOR_STEP / 2 or cdp_capture_budget < MIN_TIME_FOR_STEP:
                 raise PlaywrightTimeoutError("Not enough time for CDP screenshot steps.")

            metrics = await asyncio.wait_for(page.evaluate(
                "() => ({ width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) })"
            ), timeout=metrics_budget)
            full_width = metrics['width']
            full_height = metrics['height']
            if not full_width or not full_height: raise ValueError("Invalid page dimensions for CDP.")

            logging.info(f"[Screenshot Task] Allocating {cdp_capture_budget:.2f}s for CDP capture.")
            cdp_session_ss = await asyncio.wait_for(context.new_cdp_session(page), timeout=1.0)
            cdp_result = await asyncio.wait_for(cdp_session_ss.send(
                "Page.captureScreenshot",
                {"format": "jpeg", "quality": 80, "captureBeyondViewport": True, "clip": {"x": 0, "y": 0, "width": full_width, "height": full_height, "scale": 1}, "fromSurface": True }
            ), timeout=cdp_capture_budget)
            screenshot_bytes = base64.b64decode(cdp_result['data'])
            logging.info(f"[Screenshot Task] Captured full page screenshot via CDP (JPEG, {len(screenshot_bytes)} bytes).")

        except Exception as e_ss_cdp:
            logging.warning(f"[Screenshot Task] CDP screenshot failed: {e_ss_cdp}. Falling back.")
            if not error_message or "closed" in str(e_ss_cdp).lower(): error_message = f"CDP Screenshot fail: {e_ss_cdp}"
            screenshot_bytes = None

        finally:
            if cdp_session_ss:
                try: 
                    await asyncio.wait_for(cdp_session_ss.detach(), timeout=1.0)
                    logging.info("[Screenshot Task] CDP session detached.")
                except Exception as e_cdp_detach: logging.warning(f"[Screenshot Task] CDP detach error: {e_cdp_detach}")

        if not screenshot_bytes:
            try:
                pw_full_budget = get_remaining_time(start_time, budget_for_step=8)
                if pw_full_budget < MIN_TIME_FOR_STEP:
                     logging.warning("[Screenshot Task] Skipping PW full page fallback due to time.")
                else:
                    logging.info("[Screenshot Task] Attempting Playwright full_page fallback...")
                    screenshot_bytes = await asyncio.wait_for(page.screenshot(type='jpeg', quality=80, full_page=True), timeout=pw_full_budget)
                    logging.info("[Screenshot Task] Captured Playwright full_page fallback.")
            except Exception as e_ss_pw_full:
                logging.warning(f"[Screenshot Task] PW full_page fallback failed: {e_ss_pw_full}. Trying viewport.")
                if not error_message: error_message = f"PW full fallback fail: {e_ss_pw_full}"

        if not screenshot_bytes:
            try:
                pw_vp_budget = get_remaining_time(start_time, budget_for_step=3)
                if pw_vp_budget < MIN_TIME_FOR_STEP / 2:
                     logging.warning("[Screenshot Task] Skipping PW viewport fallback due to time.")
                else:
                    logging.info("[Screenshot Task] Attempting Playwright viewport fallback...")
                    screenshot_bytes = await asyncio.wait_for(page.screenshot(type='jpeg', quality=80), timeout=pw_vp_budget)
                    logging.info("[Screenshot Task] Captured viewport fallback.")
            except Exception as e_ss_pw_viewport:
                 logging.warning(f"[Screenshot Task] Viewport fallback failed: {e_ss_pw_viewport}")
                 if not error_message: error_message = f"Viewport fallback fail: {e_ss_pw_viewport}"

        if not screenshot_bytes:
            logging.error("[Screenshot Task] All screenshot attempts failed.")
            error_message = error_message or "Screenshot capture failed despite all attempts."

    except Exception as e_task_screenshot:
        logging.error(f"[Screenshot Task] Unexpected error during screenshot capture: {e_task_screenshot}")
        error_message = error_message or f"Unexpected screenshot task error: {e_task_screenshot}"
        screenshot_bytes = None
    
    return screenshot_bytes, error_message


async def scrape_and_screenshot_playwright(url: str, should_screenshot: bool = True) -> dict:
    operation_start_time = time.time()
    logging.info(f"SCRAPE START for {url}") # Log start of function execution

    screenshot_bytes = None
    extracted_text = None
    error_message = None
    timed_out_early = False
    temp_data_dir_obj = None
    playwright_instance = None
    browser = None
    context = None
    page = None

    try:
        temp_data_dir_obj = tempfile.TemporaryDirectory()
        temp_data_dir = temp_data_dir_obj.name
        logging.info(f"Using temporary data directory for Playwright context: {temp_data_dir} for URL: {url}")

        if get_remaining_time(operation_start_time) <= MIN_TIME_FOR_STEP:
            timed_out_early = True
            raise PlaywrightTimeoutError("Not enough time to initialize browser.")

        logging.info("Attempting to start Playwright...")
        playwright_instance = await async_playwright().start()
        logging.info("Playwright started successfully.")

        logging.info("Attempting to launch Chromium browser...")
        browser = await playwright_instance.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--ignore-certificate-errors",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ]
        )
        logging.info("Chromium browser launched successfully.")

        logging.info("Attempting to create browser context...")
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720}, 
            locale="en-US",
        )
        logging.info("Browser context created successfully.")
        
        logging.info("Attempting to create new page...")
        page = await context.new_page()
        logging.info("New page created successfully.")

        await page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        # Page Load
        page_load_budget_s = get_remaining_time(operation_start_time, budget_for_step=10)
        if page_load_budget_s <= MIN_TIME_FOR_STEP:
            timed_out_early = True
            raise PlaywrightTimeoutError("Not enough time for page load.")

        logging.info(f"Setting page load timeout to: {page_load_budget_s:.2f}s (wait_until 'domcontentloaded')")
        try:
            await page.goto(url, timeout=page_load_budget_s * 1000, wait_until="domcontentloaded")
            logging.info(f"Navigation to {url} completed (domcontentloaded).")
        except PlaywrightTimeoutError:
            logging.warning(f"Page load timeout for {url} (domcontentloaded strategy) within the allocated budget.")
            timed_out_early = True
            try: html_content_on_timeout = await page.content()
            except: html_content_on_timeout = None
            if should_screenshot:
                try: 
                    screenshot_bytes = await page.screenshot(type='jpeg', quality=80)
                    logging.info("Captured viewport screenshot after page load timeout.")
                except Exception as e_ss_on_timeout: logging.error(f"Failed viewport screenshot after load timeout: {e_ss_on_timeout}")
            extracted_text = trafilatura.extract(html_content_on_timeout) if html_content_on_timeout else None
            error_message = f"Page load timed out ({page_load_budget_s:.2f}s)"
            raise PlaywrightTimeoutError(error_message)
        except Exception as e_get:
            logging.error(f"Error during page.goto({url}): {e_get}")
            error_message = f"Error navigating to URL: {e_get}"
            raise

        # Scrolling (Sequential while loop)
        scrolled = False
        if not timed_out_early and get_remaining_time(operation_start_time) > MIN_TIME_FOR_STEP * 5: 
            logging.info("Attempting to scroll page (while loop)...")
            try:
                last_height = await page.evaluate("document.body.scrollHeight")
                scroll_pause_time = 1.5 
                scroll_attempts = 0
                max_scroll_attempts = 7
                scroll_loop_start_time = time.time()
                scroll_loop_budget_s = get_remaining_time(scroll_loop_start_time, budget_for_step=max_scroll_attempts * (scroll_pause_time + 0.5))
                
                while scroll_attempts < max_scroll_attempts:
                    if time.time() - scroll_loop_start_time > scroll_loop_budget_s:
                         logging.warning("Scrolling loop timed out.")
                         timed_out_early = True; break
                    if time.time() - operation_start_time > GLOBAL_TIMEOUT_SECONDS - BUFFER_FOR_CLEANUP_AND_PROCESSING:
                         logging.warning("Global timeout reached during scrolling.")
                         timed_out_early = True; break
                    
                    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    await asyncio.sleep(scroll_pause_time)
                    new_height = await page.evaluate("document.body.scrollHeight")
                    if new_height == last_height:
                        scrolled = True; break
                    last_height = new_height
                    scroll_attempts += 1
                
                if scrolled: logging.info(f"Scrolling finished after {scroll_attempts} attempts.")
                elif not timed_out_early: logging.warning(f"Scrolling completed max {max_scroll_attempts} attempts without full scroll.")

            except Exception as e_scroll:
                 logging.warning(f"Error during scrolling: {e_scroll}")

        # Simplified Image Wait (Sequential)
        if not timed_out_early and scrolled:
            logging.info("Attempting simplified dynamic image wait (post-scroll)...")
            await asyncio.sleep(1.0)

        # Cookie Handling (Sequential)
        cookie_banner_handled = False
        if not timed_out_early: 
            logging.info(f"Attempting cookie dismissal (super-fast attempts)...")
            cookie_locator_options = [
                {"role": "button", "name": re.compile(r"(Reject All|Tümünü Reddet|Decline All)", re.IGNORECASE)},
                {"role": "link", "name": re.compile(r"(Reject All|Tümünü Reddet|Decline All)", re.IGNORECASE)},
                {"role": "button", "name": re.compile(r"(Reject|Decline|Only necessary|Essential)", re.IGNORECASE)},
                {"role": "link", "name": re.compile(r"(Reject|Decline|Only necessary|Essential)", re.IGNORECASE)},
                {"locator_str": "button[data-testid='uc-reject-all-button']"},
                {"locator_str": "button#uc-reject-all-button"},
                {"role": "button", "name": re.compile(r"(Accept|Allow|Agree)( all| cookies)?", re.IGNORECASE)},
                {"role": "link", "name": re.compile(r"(Accept|Allow|Agree)( all| cookies)?", re.IGNORECASE)},
            ]
            cookie_check_start_time = time.time()
            for option in cookie_locator_options:
                if get_remaining_time(operation_start_time) < MIN_TIME_FOR_STEP:
                    logging.warning("Global timeout imminent during cookie checks. Halting cookie attempts.")
                    timed_out_early = True 
                    break
                try:
                    target_element = None
                    if "locator_str" in option: target_element = page.locator(option["locator_str"]).first
                    elif "role" in option and "name" in option: target_element = page.get_by_role(option["role"], name=option["name"]).first
                    
                    if target_element:
                        logging.debug(f"Attempting ultra-fast interaction with cookie element: {option}")
                        clicked_successfully_this_attempt = False
                        try:
                            await target_element.click(timeout=200)
                            clicked_successfully_this_attempt = True
                            logging.info(f"Playwright click likely succeeded for cookie element: {option}.")
                        except Exception:
                            bounding_box = None
                            try: bounding_box = await asyncio.wait_for(target_element.bounding_box(), timeout=0.1)
                            except: pass
                            if bounding_box:
                                center_x = bounding_box['x'] + bounding_box['width'] / 2
                                center_y = bounding_box['y'] + bounding_box['height'] / 2
                                cdp_session_cookie = None
                                try:
                                    cdp_session_cookie = await asyncio.wait_for(context.new_cdp_session(page), timeout=0.2)
                                    await asyncio.wait_for(cdp_session_cookie.send("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "clickCount": 1, "x": center_x, "y": center_y }), timeout=0.1)
                                    await asyncio.wait_for(cdp_session_cookie.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "clickCount": 1, "x": center_x, "y": center_y }), timeout=0.1)
                                    clicked_successfully_this_attempt = True
                                    logging.info(f"Ultra-fast CDP click dispatched for cookie element: {option}.")
                                except Exception as e_cdp_click_fast:
                                    logging.debug(f"Ultra-fast CDP click also failed for {option}: {e_cdp_click_fast}")
                                finally:
                                    if cdp_session_cookie:
                                        try:
                                            await asyncio.wait_for(cdp_session_cookie.detach(), timeout=0.1)
                                        except:
                                            pass
                            else: logging.debug(f"No bounding_box for {option} for fast CDP attempt.")
                        
                        if clicked_successfully_this_attempt:
                            cookie_banner_handled = True
                            logging.info("Cookie banner handled, breaking loop.")
                            break
                except Exception as e_cookie_outer: logging.debug(f"Outer error processing cookie option {option}: {e_cookie_outer}")
            
            logging.info(f"Finished cookie attempts. Handled: {cookie_banner_handled}, Timed Out: {timed_out_early}")
            if not cookie_banner_handled and not timed_out_early: logging.warning("Failed to handle cookie banner.")

        # --- Parallel Execution: Text Extraction and Screenshot ---
        if not timed_out_early:
            logging.info("Starting parallel execution of text extraction and screenshot tasks...")
            tasks_to_run = []
            tasks_to_run.append(_task_extract_text(page, operation_start_time))
            if should_screenshot:
                tasks_to_run.append(_task_capture_screenshot(page, context, operation_start_time))
            else:
                 tasks_to_run.append(asyncio.sleep(0, result=(None, None)))

            gather_budget_s = get_remaining_time(operation_start_time)
            if gather_budget_s <= MIN_TIME_FOR_STEP:
                 logging.warning("Not enough time for parallel tasks. Skipping.")
                 timed_out_early = True
            else:
                logging.info(f"Running asyncio.gather with remaining time: {gather_budget_s:.2f}s")
                try:
                    results = await asyncio.wait_for(asyncio.gather(*tasks_to_run, return_exceptions=True), timeout=gather_budget_s)
                    
                    # Process Text Result
                    text_result = results[0]
                    if isinstance(text_result, Exception):
                        logging.error(f"Text extraction task failed with exception: {text_result}")
                        if not error_message: error_message = f"Text task exception: {text_result}"
                    elif text_result is not None:
                        extracted_text, text_error = text_result
                        if text_error and not error_message: error_message = text_error

                    # Process Screenshot Result
                    screenshot_result = results[1]
                    if isinstance(screenshot_result, Exception):
                        logging.error(f"Screenshot task failed with exception: {screenshot_result}")
                        if not error_message: error_message = f"Screenshot task exception: {screenshot_result}"
                        elif should_screenshot: error_message += f"; Screenshot task exception: {screenshot_result}"
                    elif screenshot_result is not None:
                        screenshot_bytes, screenshot_error = screenshot_result
                        if screenshot_error:
                             logging.warning(f"Screenshot task reported an error: {screenshot_error}")
                             if not error_message and should_screenshot: error_message = screenshot_error
                             elif should_screenshot: error_message += f"; {screenshot_error}"

                except asyncio.TimeoutError:
                    logging.warning(f"Parallel tasks timed out (gather level after {gather_budget_s:.2f}s). Partial results may be missing.")
                    timed_out_early = True
                    if not error_message: error_message = "Parallel execution phase timed out."

        # --- End Parallel Execution ---

    except PlaywrightTimeoutError as pte:
        logging.warning(f"Playwright operation timed out for {url}: {pte}")
        error_message = error_message or f"Processing timed out (Playwright): {pte}"
        timed_out_early = True
    except PlaywrightError as pe: 
        logging.error(f"Playwright error for {url}: {pe}")
        error_message = error_message or f"Playwright error: {pe}"
    except Exception as e:
        logging.error(f"General error in scrape_and_screenshot_playwright for {url}: {e}", exc_info=True)
        error_message = error_message or f"General scraping error: {e}"
    finally:
        logging.info("Entering main finally block for cleanup...")
        if page and not page.is_closed():
            try: 
                 await page.close()
                 logging.info("Playwright page closed in finally block.")
            except Exception as e_page_close: logging.warning(f"Error closing Playwright page in finally: {e_page_close}")
        if context:
            try: await context.close()
            except Exception as e_ctx: logging.warning(f"Error closing Playwright context: {e_ctx}")
        if browser:
            try: await browser.close()
            except Exception as e_brws: logging.warning(f"Error closing Playwright browser: {e_brws}")
        if playwright_instance:
            try: await playwright_instance.stop()
            except Exception as e_pw_stop: logging.warning(f"Error stopping Playwright: {e_pw_stop}")
        
        if temp_data_dir_obj:
            time.sleep(0.5)
            try:
                temp_data_dir_obj.cleanup()
                logging.info(f"Successfully cleaned up temporary data directory: {temp_data_dir_obj.name}")
            except Exception as e_cleanup:
                logging.error(f"Error cleaning up temporary data directory {temp_data_dir_obj.name}: {e_cleanup}")
                try: shutil.rmtree(temp_data_dir_obj.name, ignore_errors=True)
                except Exception as e_shutil: logging.error(f"Shutil.rmtree cleanup also failed for {temp_data_dir_obj.name}: {e_shutil}")


    # Combine results and final error message assembly
    final_error_message = None
    if timed_out_early:
        timeout_info = f"Operation timed out within {GLOBAL_TIMEOUT_SECONDS}s budget."
        if error_message and "timed out" not in error_message.lower(): final_error_message = f"{timeout_info} Last error: {error_message}"
        elif error_message: final_error_message = error_message
        else: final_error_message = timeout_info
    elif error_message:
        final_error_message = error_message

    if should_screenshot and not screenshot_bytes:
        capture_failure_message = "Screenshot requested but could not be captured."
        if not final_error_message: final_error_message = capture_failure_message
        elif capture_failure_message not in final_error_message: final_error_message += f"; {capture_failure_message}"
    
    if not extracted_text and not final_error_message:
        final_error_message = "Text could not be extracted from the page."
    elif not extracted_text and final_error_message and "Text could not be extracted" not in final_error_message and "timed out" not in final_error_message.lower():
        final_error_message += "; Text also failed to extract."

    final_response = {
        "url": url,
        "text": extracted_text or "",
        "error": final_error_message
    }
    if screenshot_bytes:
        final_response["screenshot_base64"] = base64.b64encode(screenshot_bytes).decode('utf-8')
        
    elapsed_total = time.time() - operation_start_time
    logging.info(f"Total time for {url} (Playwright): {elapsed_total:.2f}s. Timed out early: {timed_out_early}. Error: {final_response.get('error')}")

    return final_response

@app.route(route="scrape")
async def http_scrape_trigger(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP scrape trigger function processed a request.')
    url = None
    take_screenshot = True 

    try:
        url = req.params.get('url')
        if url:
            logging.info(f"Found URL in query parameters: {url}")
            ss_param = req.params.get('take_screenshot', 'true')
            take_screenshot = ss_param.lower() != 'false'
        else:
             logging.info("URL not found in query parameters.")
    except Exception as e:
        logging.warning(f"Error reading query parameters: {e}")
        url = None

    if not url:
        logging.info("Attempting to read URL from JSON body.")
        try:
            req_body = await req.get_json()
            if req_body:
                url = req_body.get('url')
                if url:
                    logging.info(f"Found URL in JSON body: {url}")
                    ss_param = req_body.get('take_screenshot', True)
                    if isinstance(ss_param, str):
                        take_screenshot = ss_param.lower() != 'false'
                    else:
                        take_screenshot = bool(ss_param)
                    logging.info(f"Screenshot parameter from JSON: {take_screenshot}")
                else:
                    logging.info("URL key not found in JSON body.")
            else:
                logging.info("JSON body is empty.")
        except ValueError:
            logging.info("Request body is not valid JSON or missing.")
        except Exception as e:
            logging.warning(f"Error reading JSON body: {e}")
            url = None

    if url:
        try:
            if not url.startswith(('http://', 'https://')):
                 raise ValueError("Invalid URL format. Must start with http:// or https://")

            result_data = await scrape_and_screenshot_playwright(url, should_screenshot=take_screenshot)
            
            status_code = 200
            if result_data.get("error") and "timed out" in result_data.get("error", "").lower():
                 pass 

            return func.HttpResponse(
                json.dumps(result_data),
                mimetype="application/json",
                status_code=status_code 
            )
        except ValueError as ve:
             logging.error(f"Invalid URL provided: {ve}")
             return func.HttpResponse(
                  json.dumps({"url": url, "error": str(ve)}),
                  mimetype="application/json",
                  status_code=400
             )
        except Exception as e:
            logging.error(f"Error in http_scrape_trigger for {url}: {e}")
            return func.HttpResponse(
                 json.dumps({"url": url, "error": f"An internal error occurred in trigger: {e}"}),
                 mimetype="application/json",
                 status_code=500
            )
    else:
        logging.warning("URL not provided in request body or query string.")
        return func.HttpResponse(
             json.dumps({"error": "Please pass a 'url' in the JSON request body or query string"}),
             mimetype="application/json",
             status_code=400
        )


# aiohttp server part
async def handle_aiohttp_request(request: web.Request) -> web.Response:
    logging.info('aiohttp /scrape endpoint hit.')
    url = None
    take_screenshot = True

    url = request.query.get('url')
    if url:
        logging.info(f"Found URL in query parameters: {url}")
        ss_param = request.query.get('take_screenshot', 'true')
        take_screenshot = ss_param.lower() != 'false'
    else:
        logging.info("URL not found in query parameters. Attempting to read from JSON body.")
        try:
            req_body = await request.json()
            if req_body:
                url = req_body.get('url')
                if url:
                    logging.info(f"Found URL in JSON body: {url}")
                    ss_param = req_body.get('take_screenshot', True)
                    if isinstance(ss_param, str):
                        take_screenshot = ss_param.lower() != 'false'
                    else:
                        take_screenshot = bool(ss_param)
                    logging.info(f"Screenshot parameter from JSON: {take_screenshot}")
                else:
                    logging.info("URL key not found in JSON body.")
            else:
                logging.info("JSON body is empty or not provided.")
        except json.JSONDecodeError:
            logging.info("Request body is not valid JSON.")
        except Exception as e:
            logging.warning(f"Error reading JSON body for aiohttp request: {e}")
            url = None

    if url:
        try:
            if not url.startswith(('http://', 'https://')):
                raise ValueError("Invalid URL format. Must start with http:// or https://")

            result_data = await scrape_and_screenshot_playwright(url, should_screenshot=take_screenshot)
            
            status_code = 200
            return web.json_response(result_data, status=status_code)
        except ValueError as ve:
            logging.error(f"Invalid URL provided to aiohttp server: {ve}")
            return web.json_response({"url": url, "error": str(ve)}, status=400)
        except Exception as e:
            logging.error(f"Error in aiohttp_handle_request for {url}: {e}")
            return web.json_response({"url": url, "error": f"An internal server error occurred: {e}"}, status=500)
    else:
        logging.warning("URL not provided in aiohttp request body or query string.")
        return web.json_response({"error": "Please pass a 'url' in the JSON request body or query string"}, status=400)

async def main_server():
    logging.basicConfig(level=logging.INFO)
    port_str = os.environ.get("PORT", "7777")
    try:
        port = int(port_str)
    except ValueError:
        logging.warning(f"Invalid PORT environment variable '{port_str}'. Defaulting to 7777.")
        port = 7777
    
    aiohttp_app = web.Application()
    aiohttp_app.router.add_post('/scrape', handle_aiohttp_request)
    aiohttp_app.router.add_get('/scrape', handle_aiohttp_request)

    runner = web.AppRunner(aiohttp_app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    logging.info(f"aiohttp server started on http://0.0.0.0:{port}/scrape")
    print(f"======== Running on http://0.0.0.0:{port}/scrape ========")
    print("(Press CTRL+C to quit)")
    try:
        while True:
            await asyncio.sleep(3600)
    except KeyboardInterrupt:
        logging.info("Server shutting down...")
    finally:
        await runner.cleanup()
        logging.info("Server stopped.")

if __name__ == "__main__":
    try:
        asyncio.run(main_server())
    except KeyboardInterrupt:
        logging.info("Application shut down by user.")
    except Exception as e:
        logging.critical(f"Application failed to start or crashed: {e}")