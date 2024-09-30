import azure.functions as func
import logging
import json
import autogen
from autogen import AssistantAgent, UserProxyAgent, config_list_from_json
from azure.storage.queue import QueueClient
import os
import tempfile
import redis
from dotenv import load_dotenv
import requests
import pathlib

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


def get_given_system_message():
    env_context = os.environ.get("ENV_SYSTEM_MESSAGE_CONTEXT")
    
    if not env_context:
        return read_local_file("prompt.txt")

    if env_context.startswith(("http://", "https://")):
        return fetch_from_url(env_context)

    if pathlib.Path(env_context).suffix:
        return read_local_file(env_context)

    return env_context

def read_local_file(filename):
    try:
        with open(filename, "r") as file:
            return file.read()
    except FileNotFoundError:
        logging.error(f"{filename} not found")
        return ""

def fetch_from_url(url):
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.text
    except requests.RequestException as e:
        logging.error(f"Error fetching from URL: {e}")
        return ""

def process_message(message_data):
    logging.info(f"Processing Message: {message_data}")
    try:
        message = message_data['message']
        request_id = message_data.get('requestId') or msg.id

        config_list = config_list_from_json(env_or_file="OAI_CONFIG_LIST")
        base_url = os.environ.get("CORTEX_API_BASE_URL")
        api_key = os.environ.get("CORTEX_API_KEY")
        llm_config = {"config_list": config_list, "base_url": base_url, "api_key": api_key, "cache_seed": None, "timeout": 600}

        with tempfile.TemporaryDirectory() as temp_dir:
            code_executor = autogen.coding.LocalCommandLineCodeExecutor(work_dir=temp_dir)

            message_count = 0
            total_messages = 20 * 2
            all_messages = []

            def is_termination_msg(m):
                content = m.get("content", "")
                if message_count == 0:
                    return False
                return (m.get("role") == "assistant" and not content.strip()) or \
                    content.rstrip().endswith("TERMINATE") or \
                    "first message must use the" in content.lower() or \
                    len(content.strip()) == 0

            system_message_given = get_given_system_message()
            system_message_assistant = AssistantAgent.DEFAULT_SYSTEM_MESSAGE 

            if system_message_given:
                system_message_assistant = system_message_given
            else:
                print("No extra system message given for assistant")

            assistant = AssistantAgent("assistant", 
                llm_config=llm_config, 
                system_message=system_message_assistant,
                code_execution_config={"executor": code_executor},
            )

            user_proxy = UserProxyAgent(
                "user_proxy",
                system_message=system_message_given,
                code_execution_config={"executor": code_executor},
                human_input_mode="NEVER",
                max_consecutive_auto_reply=20,
                is_termination_msg=is_termination_msg,
            )

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

            msg = ""
            try:
                msg = all_messages[-1 if all_messages[-2]["message"] else -3]["message"] 
                logging.info(f"####Final message: {msg}")            
            except Exception as e:
                logging.error(f"Error getting final message: {e}")
                msg = f"Finished, with errors 🤖 ... {e}"

            publish_request_progress({
                "requestId": request_id,
                "progress": 1,
                "data": msg
            })

    except Exception as e:
        logging.error(f"Error processing message: {str(e)}")
        if request_id:
            publish_request_progress({
                "requestId": request_id,
                "progress": 1,
                "error": str(e)
            })