"""
Utilities to call Azure Foundry Agents (Threads / Runs) API as a callable tool.

Provides a single entrypoint `call_azure_foundry_agent` which will:
 - Construct the request payload expected by Azure Foundry Agents
 - POST to create a run
 - Poll the run status until completion (or timeout)
 - Retrieve messages from the thread and return the assistant's final text

Design is intentionally lightweight and dependency-only-on-requests.
Returns JSON strings for easy use by other tools in the project.
"""

from typing import Any, Dict, List, Optional, Union
import requests
import time
import json
import logging
import os
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


def _get_service_principal_creds_from_env() -> Optional[Dict[str, Any]]:
    """Load service principal credentials from AZURE_SERVICE_PRINCIPAL_CREDENTIALS env var
    or from individual AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET vars.
    Supports JSON string or path to a file containing JSON.
    """
    val = os.getenv("AZURE_SERVICE_PRINCIPAL_CREDENTIALS")
    if val:
        # If value looks like a path to a file, try to read it
        try:
            if os.path.exists(val):
                with open(val, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception:
            pass

        # Normalize common wrappers: strip surrounding quotes and unescape
        v = val.strip()
        # If value is surrounded by matching single or double quotes, strip them
        if len(v) >= 2 and ((v[0] == v[-1]) and v[0] in ('"', "'")):
            v = v[1:-1]

        # Unescape common escapes produced by some dotenv serializers
        v = v.replace('\\"', '"').replace("\\'", "'").replace('\\n', '\n')

        # Try parse as JSON
        try:
            return json.loads(v)
        except Exception:
            # Try Python literal eval (handles single-quoted dicts)
            try:
                import ast

                parsed = ast.literal_eval(v)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass

            # Try interpreting as dotenv-style key=value lines
            try:
                lines = [l.strip() for l in v.splitlines() if l.strip() and not l.strip().startswith("#")]
                kv = {}
                for line in lines:
                    if "=" in line:
                        k, vv = line.split("=", 1)
                        k = k.strip()
                        vv = vv.strip().strip('"').strip("'")
                        kv[k] = vv
                # If keys look like tenant/client/secret, return mapped shape
                if any(k.lower() in ("tenant_id", "tenantid", "tenant") for k in kv.keys()) and any(
                    k.lower() in ("client_id", "clientid", "client") for k in kv.keys()
                ):
                    out = {}
                    out["tenant_id"] = kv.get("tenant_id") or kv.get("tenantId") or kv.get("AZURE_TENANT_ID") or kv.get("tenant")
                    out["client_id"] = kv.get("client_id") or kv.get("clientId") or kv.get("AZURE_CLIENT_ID") or kv.get("client")
                    out["client_secret"] = kv.get("client_secret") or kv.get("clientSecret") or kv.get("AZURE_CLIENT_SECRET") or kv.get("clientSecret")
                    if out["tenant_id"] and out["client_id"] and out["client_secret"]:
                        # scope optional
                        out_scope = kv.get("scope") or kv.get("AZURE_SERVICE_PRINCIPAL_SCOPE")
                        if out_scope:
                            out["scope"] = out_scope
                        return out
            except Exception:
                pass

    # Fallback to individual env vars
    tenant = os.getenv("AZURE_TENANT_ID") or os.getenv("AZURE_TENANT")
    client = os.getenv("AZURE_CLIENT_ID") or os.getenv("AZURE_CLIENT")
    secret = os.getenv("AZURE_CLIENT_SECRET") or os.getenv("AZURE_CLIENTKEY")
    scope = os.getenv("AZURE_SERVICE_PRINCIPAL_SCOPE")
    if tenant and client and secret:
        out = {"tenant_id": tenant, "client_id": client, "client_secret": secret}
        if scope:
            out["scope"] = scope
        return out

    return None

# Try to import Azure SDK components if available (optional path)
try:
    from azure.ai.projects import AIProjectClient  # type: ignore
    from azure.identity import ClientSecretCredential, DefaultAzureCredential  # type: ignore
    from azure.ai.agents.models import ListSortOrder  # type: ignore
    _AZURE_SDK_AVAILABLE = True
except Exception:
    _AZURE_SDK_AVAILABLE = False


def _convert_to_azure_foundry_messages(
    context: Optional[str],
    examples: Optional[List[Dict[str, Any]]],
    messages: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    azure_messages: List[Dict[str, Any]] = []

    if context:
        azure_messages.append({"role": "system", "content": context})

    if examples:
        for example in examples:
            try:
                inp = example.get("input", {})
                out = example.get("output", {})
                azure_messages.append({"role": inp.get("author", "user"), "content": inp.get("content")})
                azure_messages.append({"role": out.get("author", "assistant"), "content": out.get("content")})
            except Exception:
                # ignore malformed example
                continue

    for message in messages or []:
        # Expect message to have 'author' and 'content' keys in Palm-like format,
        # or 'role' and 'content' already in Azure format.
        if "role" in message:
            azure_messages.append({"role": message.get("role"), "content": message.get("content")})
        else:
            azure_messages.append({"role": message.get("author"), "content": message.get("content")})

    return azure_messages


def _parse_assistant_text_from_messages(messages_resp: Dict[str, Any]) -> Optional[str]:
    # messages_resp expected shape: {"data": [...] } or {"messages": [...]}
    msgs = None
    if not messages_resp:
        return None

    if isinstance(messages_resp, dict) and "data" in messages_resp and isinstance(messages_resp["data"], list):
        msgs = messages_resp["data"]
    elif isinstance(messages_resp, dict) and "messages" in messages_resp and isinstance(messages_resp["messages"], list):
        msgs = messages_resp["messages"]
    elif isinstance(messages_resp, list):
        msgs = messages_resp
    else:
        return None

    # Iterate from last to first to find the last assistant message
    for message in reversed(msgs):
        try:
            role = message.get("role")
            if role != "assistant":
                continue

            content = message.get("content")
            # content may be an array of parts: [{type: 'text', text: '...'}]
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text":
                        text_val = part.get("text")
                        if isinstance(text_val, str):
                            return text_val
                        if isinstance(text_val, dict) and isinstance(text_val.get("value"), str):
                            return text_val.get("value")

            # If content is string, return it
            if isinstance(content, str):
                return content

            # Some responses embed messages under message.content.text.value
            if isinstance(message.get("content"), dict):
                # try a few common shapes
                c = message.get("content")
                # content.text may be { value: '...' } or string
                text_node = None
                if isinstance(c.get("text"), dict):
                    text_node = c.get("text").get("value")
                elif isinstance(c.get("text"), str):
                    text_node = c.get("text")
                if isinstance(text_node, str):
                    return text_node
        except Exception:
            continue

    return None


class AzureAuthTokenHelper:
    """Helper to obtain and cache an Azure AD service principal access token.

    Expects a dict with keys: tenant_id / tenantId, client_id / clientId,
    client_secret / clientSecret, optional scope.
    """
    def __init__(self, creds: Dict[str, Any]):
        if not creds or not isinstance(creds, dict):
            raise ValueError("Azure credentials must be a dict parsed from AZURE_SERVICE_PRINCIPAL_CREDENTIALS")

        self.tenant_id = creds.get("tenant_id") or creds.get("tenantId")
        self.client_id = creds.get("client_id") or creds.get("clientId")
        self.client_secret = creds.get("client_secret") or creds.get("clientSecret")
        self.scope = creds.get("scope") or "https://ai.azure.com/.default"

        if not (self.tenant_id and self.client_id and self.client_secret):
            raise ValueError("Azure credentials must include tenant_id, client_id, and client_secret")

        self.token: Optional[str] = None
        self.expiry: Optional[datetime] = None
        self.token_url = f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token"

    def is_token_valid(self) -> bool:
        # 5 minute buffer
        if not self.token or not self.expiry:
            return False
        return datetime.utcnow() < (self.expiry - timedelta(minutes=5))

    def refresh_token(self) -> None:
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "scope": self.scope,
            "grant_type": "client_credentials",
        }
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        resp = requests.post(self.token_url, data=data, headers=headers, timeout=10)
        resp.raise_for_status()
        payload = resp.json()
        access_token = payload.get("access_token")
        if not access_token:
            raise RuntimeError("Azure token response missing access_token")
        self.token = access_token
        expires_in = int(payload.get("expires_in", 3600))
        self.expiry = datetime.utcnow() + timedelta(seconds=expires_in)

    def get_access_token(self) -> str:
        if not self.is_token_valid():
            self.refresh_token()
        return self.token


def call_azure_foundry_agent(
    project_url: str,
    agent_id: str,
    messages: List[Dict[str, Any]],
    context: Optional[str] = None,
    examples: Optional[List[Dict[str, Any]]] = None,
    parameters: Optional[Dict[str, Any]] = None,
    auth_token: Optional[str] = None,
    api_version: str = "2025-05-15-preview",
    poll_interval_s: float = 1.0,
    max_poll_attempts: int = 60,
    extra_headers: Optional[Dict[str, str]] = None,
) -> str:
    """
    Call Azure Foundry Agents API to create a run and wait for completion.

    Args:
        project_url: base URL for the Foundry project (e.g. https://foundry.example.com)
        agent_id: assistant/agent id to use (assistant_id)
        messages: list of messages (Palm-like or Azure role format)
        context: optional system context string
        examples: optional examples list
        parameters: optional additional parameters to forward into the request body
        auth_token: optional bearer token for Authorization header
        api_version: version query param
        poll_interval_s: seconds between polls
        max_poll_attempts: maximum number of polls before timeout
        extra_headers: any additional headers to include

    Returns:
        JSON string with result. On success returns {"status":"success","result": <text_or_full_response>}.
        On failure returns {"status":"error","error": "..."}
    """
    try:
        # Prefer using the Azure SDK path if available - it handles auth and endpoints robustly.
        if _AZURE_SDK_AVAILABLE:
            try:
                # Build credential: prefer explicit service principal creds in env var, else DefaultAzureCredential
                cred = None
                if not auth_token:
                    creds_env = os.getenv("AZURE_SERVICE_PRINCIPAL_CREDENTIALS")
                    if creds_env:
                        try:
                            creds = json.loads(creds_env)
                            tenant = creds.get("tenant_id") or creds.get("tenantId")
                            client = creds.get("client_id") or creds.get("clientId")
                            secret = creds.get("client_secret") or creds.get("clientSecret")
                            if tenant and client and secret:
                                cred = ClientSecretCredential(tenant, client, secret)
                        except Exception:
                            cred = None
                if cred is None:
                    # Will try environment-based credentials (AZURE_CLIENT_ID etc.) or managed identity
                    cred = DefaultAzureCredential()

                # Instantiate client with the provided project endpoint
                project_client = AIProjectClient(endpoint=project_url, credential=cred)

                # If thread_id provided, post a simple message
                thread_id_param = parameters.get("thread_id") if parameters else None
                if thread_id_param:
                    last_msg = (messages or [])[-1] if messages else None
                    if not last_msg:
                        return json.dumps({"status": "error", "error": "no_message_to_post"})
                    role = last_msg.get("role") or last_msg.get("author") or "user"
                    content_text = last_msg.get("content")
                    if isinstance(content_text, dict):
                        content_text = content_text.get("text") or content_text.get("value")
                    if not isinstance(content_text, str):
                        content_text = json.dumps(content_text)

                    msg = project_client.agents.messages.create(thread_id=thread_id_param, role=role, content=content_text)
                    return json.dumps({"status": "success", "result": json.loads(json.dumps(msg, default=lambda o: getattr(o, '__dict__', str(o))))})

                # Create thread, post message, and create & process run
                agent = project_client.agents.get_agent(agent_id)
                thread = project_client.agents.threads.create()
                # Post initial user message
                if messages and len(messages) > 0:
                    first = messages[0]
                    content_text = first.get("content")
                    if isinstance(content_text, dict):
                        content_text = content_text.get("text") or content_text.get("value")
                    if not isinstance(content_text, str):
                        content_text = json.dumps(content_text)
                    _ = project_client.agents.messages.create(thread_id=thread.id, role=first.get("role") or first.get("author") or "user", content=content_text)

                run = project_client.agents.runs.create_and_process(thread_id=thread.id, agent_id=agent.id)
                # run may be synchronous; check status
                if getattr(run, "status", None) == "failed":
                    return json.dumps({"status": "error", "error": "run_failed", "detail": getattr(run, "last_error", None)})

                # Retrieve messages
                msgs = project_client.agents.messages.list(thread_id=thread.id, order=ListSortOrder.ASCENDING)
                extracted = []
                for m in msgs:
                    try:
                        # m may have text_messages attribute; extract last text value
                        text_msgs = getattr(m, "text_messages", None)
                        if text_msgs:
                            last_text = text_msgs[-1]
                            text_val = getattr(last_text, "text", None)
                            if isinstance(text_val, dict):
                                val = text_val.get("value")
                            else:
                                val = getattr(text_val, "value", None) if text_val else None
                            extracted.append({"role": getattr(m, "role", None), "text": val})
                        else:
                            # fallback to simple content
                            extracted.append({"role": getattr(m, "role", None), "content": getattr(m, "content", None)})
                    except Exception:
                        continue

                return json.dumps({"status": "success", "result": extracted})
            except Exception as e:
                # If SDK path fails, log and fall back to HTTP implementation below
                logger.warning(f"[AzureFoundry] SDK path failed, falling back to HTTP: {e}")

        # If parameters include a thread_id, prefer posting directly to that thread's messages endpoint.
        # This mirrors a working call pattern: POST /threads/{thread_id}/messages
        thread_id_param = parameters.get("thread_id") if parameters else None
        if thread_id_param:
            # Post the last message in the messages list to the thread
            last_msg = (messages or [])[-1] if messages else None
            if not last_msg:
                return json.dumps({"status": "error", "error": "no_message_to_post"})

            # Determine role and content
            role = last_msg.get("role") or last_msg.get("author") or "user"
            content_text = last_msg.get("content")
            if isinstance(content_text, dict):
                # if structure like {"text": "..."}
                content_text = content_text.get("text") or content_text.get("value")

            if not isinstance(content_text, str):
                # fallback to JSON stringified content
                content_text = json.dumps(content_text)

            # API expects content[0].text to be a string when creating messages
            post_body = {
                "role": role,
                "content": [
                    {"type": "text", "text": content_text}
                ]
            }

            post_url = project_url.rstrip("/") + f"/threads/{thread_id_param}/messages"
            pheaders = {"Content-Type": "application/json"}
            if auth_token:
                pheaders["Authorization"] = f"Bearer {auth_token}"
            # try to obtain token from env if missing
            if not auth_token:
                creds_env = os.getenv("AZURE_SERVICE_PRINCIPAL_CREDENTIALS")
                if creds_env:
                    try:
                        creds = json.loads(creds_env)
                        # infer scope from project_url if missing
                        if not creds.get("scope"):
                            try:
                                from urllib.parse import urlparse

                                parsed = urlparse(project_url)
                                base = f"{parsed.scheme}://{parsed.netloc}"
                                creds["scope"] = base.rstrip("/") + "/.default"
                            except Exception:
                                creds["scope"] = "https://ai.azure.com/.default"
                        helper = AzureAuthTokenHelper(creds)
                        auth_token = helper.get_access_token()
                        pheaders["Authorization"] = f"Bearer {auth_token}"
                    except Exception as e:
                        logger.warning(f"[AzureFoundry] Failed to obtain auth token from AZURE_SERVICE_PRINCIPAL_CREDENTIALS: {e}")

            pparams = {"api-version": api_version}
            logger.info(f"[AzureFoundry] Posting message to thread {thread_id_param} at {post_url}")
            presp = requests.post(post_url, headers=pheaders, params=pparams, json=post_body, timeout=30)
            try:
                presp.raise_for_status()
            except Exception as e:
                logger.error(f"[AzureFoundry] Post message failed: {e} - status: {presp.status_code} - text: {presp.text}")
                return json.dumps({"status": "error", "error": f"Post message failed: {presp.status_code} {presp.text}"})

            return json.dumps({"status": "success", "result": presp.json()})

        # If no explicit auth_token provided, try to obtain one from env AZURE_SERVICE_PRINCIPAL_CREDENTIALS
        if not auth_token:
            creds_env = os.getenv("AZURE_SERVICE_PRINCIPAL_CREDENTIALS")
            if creds_env:
                try:
                    creds = json.loads(creds_env)
                    helper = AzureAuthTokenHelper(creds)
                    auth_token = helper.get_access_token()
                except Exception as e:
                    logger.warning(f"[AzureFoundry] Failed to obtain auth token from AZURE_SERVICE_PRINCIPAL_CREDENTIALS: {e}")

        # Build request messages in Azure format
        request_messages = _convert_to_azure_foundry_messages(context, examples, messages)

        # Build payload
        body: Dict[str, Any] = {
            "assistant_id": agent_id,
            "thread": {"messages": request_messages},
            "stream": bool(parameters.get("stream") if parameters else False),
        }

        # Merge allowed parameter keys into body
        if parameters:
            allowed_keys = [
                "tools",
                "tool_resources",
                "metadata",
                "instructions",
                "model",
                "temperature",
                "max_tokens",
                "top_p",
                "tool_choice",
                "response_format",
                "parallel_tool_calls",
                "truncation_strategy",
            ]
            for k in allowed_keys:
                if k in parameters:
                    body[k] = parameters[k]

        url = project_url.rstrip("/") + "/threads/runs"
        headers = {"Content-Type": "application/json"}
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
        if extra_headers:
            headers.update(extra_headers)

        params = {"api-version": api_version}

        logger.info(f"[AzureFoundry] Creating run at {url} (assistant_id={agent_id})")
        resp = requests.post(url, headers=headers, params=params, json=body, timeout=30)
        try:
            resp.raise_for_status()
        except Exception as e:
            logger.error(f"[AzureFoundry] Create run failed: {e} - status: {resp.status_code} - text: {resp.text}")
            return json.dumps({"status": "error", "error": f"Create run failed: {resp.status_code} {resp.text}"})

        run_resp = resp.json()

        # If the response already contains messages, try to parse them
        if isinstance(run_resp, dict) and (run_resp.get("messages") or run_resp.get("data")):
            parsed = _parse_assistant_text_from_messages(run_resp)
            if parsed:
                return json.dumps({"status": "success", "result": parsed})
            # otherwise return the raw run response
            return json.dumps({"status": "success", "result": run_resp})

        run_id = run_resp.get("id")
        thread_id = run_resp.get("thread_id")

        if not run_id or not thread_id:
            # Nothing to poll; return run response
            return json.dumps({"status": "success", "result": run_resp})

        # Poll for completion
        attempts = 0
        poll_url = project_url.rstrip("/") + f"/threads/{thread_id}/runs/{run_id}"
        while attempts < max_poll_attempts:
            attempts += 1
            time.sleep(poll_interval_s)
            try:
                pheaders = {"Content-Type": "application/json"}
                if auth_token:
                    pheaders["Authorization"] = f"Bearer {auth_token}"
                if extra_headers:
                    pheaders.update(extra_headers)

                presp = requests.get(poll_url, headers=pheaders, params={"api-version": api_version}, timeout=20)
                presp.raise_for_status()
                status_json = presp.json()

                status = status_json.get("status")
                if not status:
                    # keep polling
                    continue

                if status == "completed":
                    logger.info(f"[AzureFoundry] Run completed: {run_id}")
                    # retrieve messages
                    break

                if status in ("failed", "cancelled"):
                    logger.error(f"[AzureFoundry] Run {status}: {run_id}")
                    return json.dumps({"status": "error", "error": f"Run {status}", "detail": status_json})

                # otherwise continue polling
                continue

            except Exception as e:
                logger.warning(f"[AzureFoundry] Polling attempt {attempts} failed: {e}")
                continue

        else:
            logger.error(f"[AzureFoundry] Polling timed out after {max_poll_attempts} attempts for run {run_id}")
            return json.dumps({"status": "error", "error": "polling_timeout"})

        # Retrieve messages from thread
        try:
            messages_url = project_url.rstrip("/") + f"/threads/{thread_id}/messages"
            mheaders = {"Content-Type": "application/json"}
            if auth_token:
                mheaders["Authorization"] = f"Bearer {auth_token}"
            if extra_headers:
                mheaders.update(extra_headers)

            mresp = requests.get(messages_url, headers=mheaders, params={"api-version": api_version, "order": "asc"}, timeout=30)
            mresp.raise_for_status()
            messages_json = mresp.json()

            parsed_text = _parse_assistant_text_from_messages(messages_json)
            if parsed_text:
                return json.dumps({"status": "success", "result": parsed_text})
            # fallback: return whole messages payload
            return json.dumps({"status": "success", "result": messages_json})

        except Exception as e:
            logger.error(f"[AzureFoundry] Failed to retrieve messages: {e}")
            return json.dumps({"status": "error", "error": f"retrieve_messages_failed: {str(e)}"})

    except Exception as exc:
        logger.exception("[AzureFoundry] Unexpected error")
        return json.dumps({"status": "error", "error": str(exc)})


def get_azure_foundry_tool(project_url: str, agent_id: str, auth_token: Optional[str] = None):
    """
    Return a callable suitable as a simple tool wrapper.

    The returned function signature is: (messages, context=None, examples=None, parameters=None) -> str
    """
    def tool(messages: List[Dict[str, Any]], context: Optional[str] = None, examples: Optional[List[Dict[str, Any]]] = None, parameters: Optional[Dict[str, Any]] = None):
        return call_azure_foundry_agent(
            project_url=project_url,
            agent_id=agent_id,
            messages=messages,
            context=context,
            examples=examples,
            parameters=parameters,
            auth_token=auth_token,
        )

    return tool


