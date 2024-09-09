import azure.functions as func
import logging
import json
import autogen
from autogen import AssistantAgent, UserProxyAgent, config_list_from_json
from azure.storage.queue import QueueClient
import os
import tempfile
import redis
import base64
from dotenv import load_dotenv
load_dotenv()

app = func.FunctionApp()

connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
queue_name = os.environ.get("QUEUE_NAME", "autogen-message-queue")
queue_client = QueueClient.from_connection_string(connection_string, queue_name)

redis_client = redis.from_url(os.environ['REDIS_CONNECTION_STRING'])
channel = 'requestProgress'

def connect_redis():
    if not redis_client.ping():
        try:
            redis_client.ping()
        except redis.ConnectionError as e:
            logging.error(f"Error reconnecting to Redis: {e}")
            return False
    return True

def publish_request_progress(data):
    if connect_redis():
        try:
            message = json.dumps(data)
            logging.info(f"Publishing message {message} to channel {channel}")
            redis_client.publish(channel, message)
        except Exception as e:
            logging.error(f"Error publishing message: {e}")

def process_message(message_data):
    logging.info(f"Processing Message: {message_data}")
    try:
        message = message_data['message']
        request_id = message_data.get('requestId') or msg.id

        config_list = config_list_from_json(env_or_file="OAI_CONFIG_LIST")
        base_url = os.environ.get("CORTEX_API_BASE_URL")
        api_key = os.environ.get("CORTEX_API_KEY")
        llm_config = {"config_list": config_list, "base_url": base_url, "api_key": api_key, "cache_seed": None}

        with tempfile.TemporaryDirectory() as temp_dir:
            # code_executor = autogen.coding.DockerCommandLineCodeExecutor(work_dir=temp_dir)
            code_executor = autogen.coding.LocalCommandLineCodeExecutor(work_dir=temp_dir)

            env_context = """YOUR ENV: 
            - You are in default newly installed env, so make sure to install any dependencies first for any code execution, if python e.g. for "requests" package and all packages do imports like this:
            try:
                import requests
            except ImportError:
                import subprocess
                subprocess.check_call(["pip", "install", "requests"])
                import requests
            - You can upload the file to Azure Blob Storage. AZURE_STORAGE_CONNECTION_STRING is environment variable available for azure blob storage, use AccountName information in AZURE_STORAGE_CONNECTION_STRING e.g. ...;AccountName=ACCOUNT_NAME;... and use AZURE_BLOB_CONTAINER env variable as blob container for your file storage. If you upload a file to azure blob you must include the file's azure blob URL in your response, the blob container is private so you need to include a SAS token in url to access the file, SAS tokens should be limited to 30 days, example url: https://ACCOUNT_NAME.blob.core.windows.net/BLOB_CONTAINER/FILE.EXT
            https://ACCOUNT_NAME.blob.core.windows.net/BLOB_CONTAINER/FILE.EXT?sv=DATE&st=DATE&se=DATE&sr=b&sp=r&sig=SIGNATURE, you must include SAS-url in your response.
            - When everything works fine and you complete the users request upload your code files to Azure Storage with a prefix "code"+ "timestamp" and with a nice detailed descriptive filename and return the URLs of the code files. You can use the same azure blob storage connection string to upload the code file. You must include your code files azure blob URL in your response with SAS token.
            - If you need to search web you can use azure bing search api. You can use the AZURE_BING_KEY environment variable, url: "https://api.bing.microsoft.com/v7.0/search", Ocp-Apim-Subscription-Key: "{{AZURE_BING_KEY}}"
            - If you need to use github api, you can use the GITHUB_API_KEY environment variable it is already given as GITHUB_API_KEY, this token has readonly access so use accordingly, usage in headers 'Authorization': f'Bearer {os.environ["GITHUB_API_KEY"]}', e.g.
org = 'ALJAZEERAPLUS'
repo = 'labeeb'
url = f'https://api.github.com/repos/{org}/{repo}/contents/README.md'
headers = {
    'Authorization': f'Bearer {os.environ["GITHUB_API_KEY"]}',
    'Accept': 'application/vnd.github.v3+json'
}

response = requests.get(url, headers=headers)
\n\n""" 


# - If you need to use github api, you can use the GITHUB_API_TOKEN environment variable it is already given as GITHUB_API_TOKEN=github_pat..., this token has readonly access so use accordingly, usage e.g. 'Authorization': f'token {{GITHUB_API_TOKEN}}

            assistant = AssistantAgent("assistant", llm_config=llm_config, system_message=env_context)

            def is_termination_msg(x):
                content = x.get("content", "")
                if message_count == 0:
                    return False
                return (x.get("role") == "assistant" and not content.strip()) or \
                    content.rstrip().endswith("TERMINATE") or \
                    "first message must use the" in content.lower() or \
                    len(content.strip()) == 0

            user_proxy = UserProxyAgent(
                "user_proxy",
                system_message=env_context,
                code_execution_config={"executor": code_executor},
                human_input_mode="NEVER",
                max_consecutive_auto_reply=20,
                is_termination_msg=is_termination_msg,
            )

            message_count = 0
            total_messages = 20 * 2 # Assuming 20 messages for full conversation
            all_messages = []

            original_assistant_send = assistant.send
            original_user_proxy_send = user_proxy.send

            def logged_send(sender, original_send, message, recipient, request_reply=None, silent=True):
                nonlocal message_count, all_messages
                logging.info(f"Message from {sender.name} to {recipient.name}: {message}")
                message_count += 1
                progress = min(message_count / total_messages, 1)
                all_messages.append({"sender": sender.name, "message": message})
                publish_request_progress({
                    "requestId": request_id,
                    "progress": progress,
                    "info": message
                })
                return original_send(message, recipient, request_reply, silent)

            assistant.send = lambda message, recipient, request_reply=None, silent=True: logged_send(assistant, original_assistant_send, message, recipient, request_reply, silent)
            user_proxy.send = lambda message, recipient, request_reply=None, silent=True: logged_send(user_proxy, original_user_proxy_send, message, recipient, request_reply, silent)

            chat_result = user_proxy.initiate_chat(assistant, message=message)
            # logging.info(f"Chat result: {chat_result.summary}")

            # After the chat is finished
            # summary_agent = AssistantAgent("summary_agent", llm_config=llm_config, system_message="You are an expert at summarizing conversations. Provide concise and accurate summaries.")
            # summary_prompt = f"Summarize the following conversation:\n\n{json.dumps(all_messages)}"
            # summary_result = user_proxy.initiate_chat(summary_agent, message=summary_prompt)
            # summary = summary_result.last_message()["content"]
            # logging.info(f"####Summary: {summary}")

            msg = all_messages[-3]["message"] if len(all_messages) >= 3 else ""
            logging.info(f"####Final message: {msg}")            

            # Final message to indicate completion
            publish_request_progress({
                "requestId": request_id,
                "progress": 1,
                "data": msg
                # "data": #json.dumps([x["message"] for x in all_messages]),
            })

    except Exception as e:
        logging.error(f"Error processing message: {str(e)}")
        if request_id:
            publish_request_progress({
                "requestId": request_id,
                "progress": 1,
                "error": str(e)
            })