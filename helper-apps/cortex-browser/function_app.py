import azure.functions as func
import logging
import json
from playwright.sync_api import sync_playwright
import trafilatura
import base64

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

def scrape_and_screenshot(url: str, should_screenshot: bool = True) -> dict:
    """Scrapes text and takes a screenshot of a given URL, attempting to reject cookies."""
    screenshot_bytes = None
    html_content = None
    extracted_text = None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context()
                page = context.new_page()
                page.goto(url, wait_until='load', timeout=60000) # Increased timeout

                # --- Attempt to reject cookies ---
                # Add more selectors here if needed for different sites
                reject_selectors = [
                    "button:has-text('Reject All')",
                    "button:has-text('Decline')",
                    "button:has-text('Only necessary')",
                    "button:has-text('Tümünü Reddet')", # From your example
                    "button:has-text('Reject')",
                    "[aria-label*='Reject']", # Common aria labels
                    "[id*='reject']",
                    "[class*='reject']",
                    # Add more specific selectors based on common banner frameworks if known
                ]

                cookie_banner_found = False
                for selector in reject_selectors:
                    try:
                        # Wait briefly for the banner element to appear
                        reject_button = page.locator(selector).first
                        if reject_button.is_visible(timeout=2000): # Wait up to 2 seconds
                            logging.info(f"Found potential cookie reject button with selector: {selector}")
                            reject_button.click(timeout=5000) # Click with a timeout
                            logging.info("Clicked cookie reject button.")
                            # Wait a tiny bit for the banner to disappear/page to settle
                            page.wait_for_timeout(500)
                            cookie_banner_found = True
                            break # Stop searching once one is clicked
                    except Exception as e:
                        # Ignore timeout errors if the element doesn't appear or other exceptions
                        # logging.debug(f"Cookie reject selector '{selector}' not found or failed: {e}")
                        pass # Try the next selector

                if not cookie_banner_found:
                     logging.info("No common cookie reject button found or clicked.")
                # ---------------------------------

                html_content = page.content()
                # Take FULL page screenshot before closing
                if should_screenshot:
                    screenshot_bytes = page.screenshot(full_page=True) # Added full_page=True
            finally:
                browser.close()
    except Exception as e:
        logging.error(f"Playwright error accessing {url}: {e}")
        return {"url": url, "error": f"Playwright error: {e}"}

    if html_content:
        try:
            extracted_text = trafilatura.extract(html_content, include_comments=False)
        except Exception as e:
            logging.error(f"Trafilatura error processing {url}: {e}")
            # Still return screenshot if Playwright succeeded
            extracted_text = f"Trafilatura extraction failed: {e}"

    screenshot_base64 = base64.b64encode(screenshot_bytes).decode('utf-8') if screenshot_bytes else None

    response_data = {
        "url": url,
        "text": extracted_text or "",
    }
    if screenshot_base64:
        response_data["screenshot_base64"] = screenshot_base64

    return response_data

@app.route(route="scrape") # Changed route name
def http_scrape_trigger(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP scrape trigger function processed a request.')

    url = None
    take_screenshot = True # Default value

    # 1. Try getting parameters from query string first
    try:
        url = req.params.get('url')
        if url:
            logging.info(f"Found URL in query parameters: {url}")
            # Handle take_screenshot from query params
            ss_param = req.params.get('take_screenshot', 'true') # Query params are strings
            take_screenshot = ss_param.lower() != 'false'
        else:
             logging.info("URL not found in query parameters.")
    except Exception as e:
        # This shouldn't generally happen with req.params, but good practice
        logging.warning(f"Error reading query parameters: {e}")
        url = None # Ensure url is None if error occurs here

    # 2. If URL not found in query, try getting from JSON body
    if not url:
        logging.info("Attempting to read URL from JSON body.")
        try:
            req_body = req.get_json()
            if req_body:
                url = req_body.get('url')
                if url:
                    logging.info(f"Found URL in JSON body: {url}")
                    # Handle take_screenshot from JSON body
                    ss_param = req_body.get('take_screenshot', True)
                    if isinstance(ss_param, str):
                        take_screenshot = ss_param.lower() != 'false'
                    else:
                        take_screenshot = bool(ss_param) # Convert other types
                    logging.info(f"Screenshot parameter from JSON: {take_screenshot}")
                else:
                    logging.info("URL key not found in JSON body.")
            else:
                logging.info("JSON body is empty.")
        except ValueError:
            logging.info("Request body is not valid JSON or missing.")
            # url remains None
        except Exception as e:
            logging.warning(f"Error reading JSON body: {e}")
            url = None # Ensure url is None if error occurs here

    # 3. Process the request if URL was found
    if url:
        try:
            # Validate URL basic structure (optional but recommended)
            if not url.startswith(('http://', 'https://')):
                 raise ValueError("Invalid URL format. Must start with http:// or https://")

            result_data = scrape_and_screenshot(url, should_screenshot=take_screenshot) # Pass the flag
            return func.HttpResponse(
                json.dumps(result_data),
                mimetype="application/json",
                status_code=200
            )
        except ValueError as ve:
             logging.error(f"Invalid URL provided: {ve}")
             return func.HttpResponse(
                  json.dumps({"error": str(ve)}),
                  mimetype="application/json",
                  status_code=400
             )
        except Exception as e:
            logging.error(f"Error processing scrape request for {url}: {e}")
            return func.HttpResponse(
                 json.dumps({"error": f"An internal error occurred: {e}"}),
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

# Keep this if you might have other triggers, otherwise it can be removed
# if the scrape trigger is the only one.
# Example of another potential trigger (e.g., timer)
# @app.timer_trigger(schedule="0 */5 * * * *", arg_name="myTimer", run_on_startup=True,
#                    use_monitor=False)
# def timer_trigger_handler(myTimer: func.TimerRequest) -> None:
#     if myTimer.past_due:
#         logging.info('The timer is past due!')
#     logging.info('Python timer trigger function executed.')