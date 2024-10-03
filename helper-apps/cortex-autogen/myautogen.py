import azure.functions as func
import logging
import json
import autogen
from autogen import AssistantAgent, UserProxyAgent, config_list_from_json, register_function
from azure.storage.queue import QueueClient
import os
import tempfile
import redis
from dotenv import load_dotenv
import requests
import pathlib
import pymongo
import logging
from datetime import datetime, timezone
from tools.sasfileuploader import autogen_sas_uploader
import shutil
load_dotenv()

DEFAULT_SUMMARY_PROMPT = "Summarize the takeaway from the conversation. Do not add any introductory phrases."
try:
    with open("prompt_summary.txt", "r") as file:
        summary_prompt = file.read() or DEFAULT_SUMMARY_PROMPT
except FileNotFoundError:
    summary_prompt = DEFAULT_SUMMARY_PROMPT 


def store_in_mongo(data):
    try:
        if 'MONGO_URI' in os.environ:
            client = pymongo.MongoClient(os.environ['MONGO_URI'])
            collection = client.get_default_database()[os.environ.get('MONGO_COLLECTION_NAME', 'autogenruns')]
            collection.insert_one(data)
        else:
            logging.warning("MONGO_URI not found in environment variables")
    except Exception as e:
        logging.error(f"An error occurred while storing data in MongoDB: {str(e)}")

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

def process_message(message_data, original_request_message):
    logging.info(f"Processing Message: {message_data}")
    try:
        started_at = datetime.now()
        message = message_data['message']
        request_id = message_data.get('requestId') or msg.id

        config_list = config_list_from_json(env_or_file="OAI_CONFIG_LIST")
        base_url = os.environ.get("CORTEX_API_BASE_URL")
        api_key = os.environ.get("CORTEX_API_KEY")
        llm_config = {"config_list": config_list, "base_url": base_url, "api_key": api_key, "cache_seed": None, "timeout": 600}

        with tempfile.TemporaryDirectory() as temp_dir:
            #copy /tools directory to temp_dir
            shutil.copytree(os.path.join(os.getcwd(), "tools"), temp_dir, dirs_exist_ok=True)
            
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
                is_termination_msg=is_termination_msg,
            )
            
            user_proxy = UserProxyAgent(
                "user_proxy",
                llm_config=llm_config,
                system_message=system_message_given,
                code_execution_config={"executor": code_executor},
                human_input_mode="NEVER",
                max_consecutive_auto_reply=20,
            )

            # description = "Upload a file to Azure Blob Storage and get URL back with a SAS token. Requires AZURE_STORAGE_CONNECTION_STRING and AZURE_BLOB_CONTAINER environment variables. Input: file_path (str). Output: SAS URL (str) or error message."

            # register_function(
            #     autogen_sas_uploader,
            #     caller=assistant,
            #     executor=user_proxy,
            #     name="autogen_sas_uploader",
            #     description=description,    
            # )

            # register_function(
            #     autogen_sas_uploader,
            #     caller=user_proxy,
            #     executor=assistant,
            #     name="autogen_sas_uploader",
            #     description=description,    
            # )

            original_assistant_send = assistant.send
            original_user_proxy_send = user_proxy.send

            def logged_send(sender, original_send, message, recipient, request_reply=None, silent=True):
                nonlocal message_count, all_messages
                if not message:
                    return
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

            assistant.send = lambda message, recipient, request_reply=None, silent=False: logged_send(assistant, original_assistant_send, message, recipient, request_reply, silent)
            user_proxy.send = lambda message, recipient, request_reply=None, silent=False: logged_send(user_proxy, original_user_proxy_send, message, recipient, request_reply, silent)

            #summary_method="reflection_with_llm", "last_msg"
            chat_result = user_proxy.initiate_chat(assistant, message=message, summary_method="reflection_with_llm", summary_args={"summary_role": "user", "summary_prompt": summary_prompt})

            msg = ""
            try:
                msg = all_messages[-1 if all_messages[-2]["message"] else -3]["message"] 
                logging.info(f"####Final message: {msg}")     
            except Exception as e:
                logging.error(f"Error getting final message: {e}")
                msg = f"Finished, with errors 🤖 ... {e}"

            msg = chat_result.summary if chat_result.summary else msg

            finalData = {
                "requestId": request_id,
                "requestMessage": message_data.get("message"),
                "progress": 1,
                "data": msg,
                "contextId": message_data.get("contextId"),
                "conversation": all_messages,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "insertionTime": original_request_message.insertion_time.astimezone(timezone.utc).isoformat() if original_request_message else None,
                "startedAt": started_at.astimezone(timezone.utc).isoformat(),
            }       

            # Final message to indicate completion
            publish_request_progress(finalData)
            store_in_mongo(finalData)

    except Exception as e:
        logging.error(f"Error processing message: {str(e)}")
        if request_id:
            publish_request_progress({
                "requestId": request_id,
                "progress": 1,
                "error": str(e)
            })