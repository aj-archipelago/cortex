import os
import sys
import tempfile
import json
import pytest
import requests
import logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load .env early so local settings are used
from dotenv import load_dotenv
dotenv_path = os.path.join(os.getcwd(), '.env')
if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path)

# Ensure project root is importable
PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__)) or os.getcwd()
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from tools.azure_blob_tools import upload_file_to_azure_blob


CORTEX_API_BASE_URL = os.getenv("CORTEX_API_BASE_URL")
CORTEX_API_KEY = os.getenv("CORTEX_API_KEY")


@pytest.mark.skipif(not CORTEX_API_BASE_URL or not CORTEX_API_KEY, reason="Requires CORTEX_API_BASE_URL and CORTEX_API_KEY")
def test_cortex_function_call_roundtrip_integration():
    """Integration test that performs a full function-calling roundtrip against Cortex REST API.

    Steps:
    1. Send initial chat completion request with a function schema and ask model to call it.
    2. Assert the model returned a function_call and extract arguments.
    3. Execute the local tool (`upload_file_to_azure_blob`) with the provided arguments.
    4. Send a follow-up request including the tool result as a message with role 'function' and name.
    5. Assert the final assistant response acknowledges the tool result and contains a download URL.
    """
    base = CORTEX_API_BASE_URL.rstrip('/')
    # Build the correct chat completions endpoint path
    if base.endswith('/v1'):
        endpoint = base + '/chat/completions'
    else:
        endpoint = base + '/v1/chat/completions'

    headers = {
        "Authorization": f"Bearer {CORTEX_API_KEY}",
        "Content-Type": "application/json"
    }

    # Use a predictable file path under /tmp for the uploader
    requested_file_path = '/tmp/test_integration_roundtrip.txt'

    # Initial request: ask model to call the function
    initial_messages = [
        {"role": "system", "content": "You are a tool-calling assistant. When asked to call a function, produce a function_call according to provided schema."},
        {"role": "user", "content": f"Upload the file at '{requested_file_path}' using the function 'upload_file_to_azure_blob' and return the download_url and blob_name as JSON."}
    ]

    function_schema = {
        "name": "upload_file_to_azure_blob",
        "description": "Upload a file to Azure Blob Storage and return JSON with download_url and blob_name",
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "blob_name": {"type": ["string", "null"]}
            },
            "required": ["file_path"]
        }
    }

    payload1 = {
        "model": "gpt-4.1",
        "messages": initial_messages,
        "functions": [function_schema],
        "function_call": "auto"
    }

    logger.info("Sending initial request to Cortex: %s", endpoint)
    logger.info("Payload1: %s", json.dumps(payload1, indent=2))
    r1 = requests.post(endpoint, headers=headers, json=payload1, timeout=60)
    logger.info("Initial response status: %s", r1.status_code)
    logger.info("Initial response text: %s", r1.text)
    assert r1.status_code == 200, r1.text
    data1 = r1.json()
    # Robust extraction: try multiple strategies/attempts to get a structured function_call
    attempts = 3
    fc = None
    last_message = None
    for attempt in range(attempts):
        if attempt == 0:
            resp_data = data1
        else:
            # Retry with stronger instruction forcing function_call name
            retry_messages = [
                {"role": "system", "content": "You MUST respond with a function_call for the function named 'upload_file_to_azure_blob' and not prose."},
                {"role": "user", "content": f"Return only a function_call JSON for upload_file_to_azure_blob with file_path='{requested_file_path}'."}
            ]
            payload_retry = {
                "model": "gpt-4.1",
                "messages": retry_messages,
                "functions": [function_schema],
                "function_call": {"name": "upload_file_to_azure_blob"}
            }
            logger.info("Retry attempt %s sending payload: %s", attempt, json.dumps(payload_retry, indent=2))
            rr = requests.post(endpoint, headers=headers, json=payload_retry, timeout=60)
            logger.info("Retry response status: %s", rr.status_code)
            logger.info("Retry response text: %s", rr.text)
            assert rr.status_code == 200, rr.text
            resp_data = rr.json()

        assert "choices" in resp_data and len(resp_data["choices"]) > 0
        message = resp_data["choices"][0].get("message") or {}
        last_message = message

        # 1) structured function_call
        if "function_call" in message:
            fc = message["function_call"]
            break

        # 2) content might be JSON containing function_call or direct function_call dict
        content = message.get("content")
        logger.info("Attempt %s: message content: %s", attempt, content)
        if isinstance(content, str):
            # try to parse whole content as JSON
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict):
                    if "function_call" in parsed:
                        fc = parsed["function_call"]
                        break
                    # maybe content is the function_call itself
                    if "name" in parsed and "arguments" in parsed:
                        fc = parsed
                        break
            except Exception:
                # try to extract JSON substring
                import re
                m = re.search(r'(\{[\s\S]*\})', content)
                if m:
                    try:
                        parsed = json.loads(m.group(1))
                        if isinstance(parsed, dict):
                            if "function_call" in parsed:
                                fc = parsed["function_call"]
                                break
                            if "name" in parsed and "arguments" in parsed:
                                fc = parsed
                                break
                    except Exception:
                        pass

        # 3) content could be a short marker like 'function_call' -> continue to next attempt
        logger.info("No function_call parsed in attempt %s", attempt)

    if fc is None:
        pytest.fail(f"Failed to obtain function_call after {attempts} attempts. Last message: {json.dumps(last_message, indent=2)}")

    # Normalize fc.arguments which may be dict or JSON string
    args_field = fc.get("arguments")
    if isinstance(args_field, str):
        args_obj = json.loads(args_field)
    else:
        args_obj = args_field

    assert fc.get("name") == "upload_file_to_azure_blob"
    args = args_obj
    assert isinstance(args, dict) and "file_path" in args

    file_path = args.get("file_path")
    blob_name = args.get("blob_name") if "blob_name" in args else None

    # Ensure the file exists locally for upload; create if needed
    created_tmp = False
    try:
        if not os.path.exists(file_path):
            parent = os.path.dirname(file_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(file_path, 'wb') as f:
                f.write(b"integration roundtrip test content")
            created_tmp = True

        # Execute the tool locally
        logger.info("Executing local tool upload_file_to_azure_blob(%s, %s)", file_path, blob_name)
        tool_result_json = upload_file_to_azure_blob(file_path, blob_name=blob_name)
        logger.info("Tool raw result: %s", tool_result_json)
        assert tool_result_json is not None
        tool_result = json.loads(tool_result_json)
        assert "download_url" in tool_result and "blob_name" in tool_result

        # Now send follow-up to Cortex with the tool result as a 'function' message
        # Do NOT include 'function_call' on assistant message; send only the function message per function-calling protocol
        followup_messages = initial_messages + [
            {"role": "function", "name": "upload_file_to_azure_blob", "content": json.dumps(tool_result)}
        ]

        payload2 = {
            "model": "gpt-4.1",
            "messages": followup_messages
        }

        logger.info("Sending follow-up request with tool result back to Cortex")
        logger.info("Payload2: %s", json.dumps(payload2, indent=2))
        r2 = requests.post(endpoint, headers=headers, json=payload2, timeout=60)
        logger.info("Follow-up response status: %s", r2.status_code)
        logger.info("Follow-up response text: %s", r2.text)
        assert r2.status_code == 200, r2.text
        data2 = r2.json()

        # Final assistant response should reference download_url or blob_name
        assert "choices" in data2 and len(data2["choices"]) > 0
        final_msg = data2["choices"][0].get("message") or {}
        final_text = final_msg.get("content") or ""
        logger.info("Final assistant content: %s", final_text)
        assert "download_url" in final_text or ".blob.core.windows.net" in final_text or tool_result.get("download_url") in final_text

    finally:
        if created_tmp:
            try:
                os.remove(file_path)
            except Exception:
                pass
