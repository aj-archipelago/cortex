from autogen import AssistantAgent, UserProxyAgent, config_list_from_json
from utils import publish_request_progress, zip_and_upload_tmp_folder
from prompts import *
from data_operations import store_in_mongo
from search import search_index, index_message
from config import *
import os
import logging
import json
import tempfile
import time
from datetime import datetime, timezone
import autogen.coding
from data_operations import check_for_human_input
from agents_extra import process_helper_results
from config import prompts
import queue
import threading
import shutil

human_input_queues = {}
human_input_text_queues = {}
def background_human_input_check(request_id):
    while True:
        human_input = check_for_human_input(request_id)
        if human_input:
            human_input_queues[request_id].put(human_input)
            if human_input in ["TERMINATE", "PAUSE"]:
                break
            else:
                if not human_input_text_queues.get(request_id):
                    human_input_text_queues[request_id] = queue.Queue()
                human_input_text_queues[request_id].put(human_input)
        time.sleep(1)


def get_message_with_user_input(message, request_id):
    human_input_text = ""
    if human_input_text_queues.get(request_id):
        while not human_input_text_queues[request_id].empty():
            human_input_text += " " + human_input_text_queues[request_id].get()
    return message + human_input_text

def get_request_temp_dir(request_id):
    if not request_id:
        logging.warning("No request_id provided!")
        return None
    temp_dir_name = f"cortex_autogen/{request_id}"
    temp_dir = os.path.join(tempfile.gettempdir(), temp_dir_name)
    
    try:
        os.makedirs(temp_dir, exist_ok=True)
    except OSError as e:
        logging.error(f"Error creating temporary directory: {e}")
        return None
    
    return temp_dir

def find_code_message(all_messages):
    if not all_messages or len(all_messages) < 2:
        return ""
    
    failed = False
    code_message = ""
    
    for i in range(len(all_messages)):
        current_message = all_messages[i].get('message') or all_messages[i].get('content', '')
        failed = failed or "(execution failed)\n" in current_message

        if not failed and "(execution failed)\n" in current_message:
            failed = True

        if failed:
            if "exitcode: 0 (execution succeeded)" in current_message:
                #grap 4 messages including the current one
                messages = all_messages[i-4:i+1]
                code_message = "\n".join([(msg['message'] or msg['content']) for msg in messages])
                return code_message
    return ""


def is_termination_msg(m):
    content = m.get("content", "").strip()
    if not content or content.rstrip().endswith("TERMINATE") or content.startswith("exitcode: 0 (execution succeeded)"):
        return True
    return False


#use this via chat() function
def chat_with_agents(**kwargs):
    prompt = kwargs.pop("prompt", None)
    message = kwargs.pop("message", None)

    if kwargs.pop("add_python_coder_prompt", True):
        prompt += prompts.get("PYTHON_CODER_SYSTEM_MESSAGE")

    if kwargs.pop("add_never_hallucinate_prompt", True):
        prompt += prompts.get("NEVER_HALLUCINATE_SYSTEM_MESSAGE")

    if kwargs.pop("add_current_datetime_prompt", True):
        current_datetime = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
        CURRENT_DATETIME_PROMPT = f"""
        You know that current date and time is {current_datetime}. 
        """
        prompt += CURRENT_DATETIME_PROMPT

    if not message:
        logging.warning("No message provided! Skipping chat!")
        return
    if not prompt:
        logging.warning("No prompt provided!")

    original_request_message = kwargs.pop("original_request_message", None)
    original_request_message_data = kwargs.pop("original_request_message_data", None)


    llm_config = kwargs.pop("llm_config", None)
    request_id = kwargs.pop("request_id", None)
    chat_publish_progress = kwargs.pop("chat_publish_progress", None)
    
    request_reply = kwargs.pop("request_reply", None)
    silent = kwargs.pop("silent", True)

    recipient = kwargs.pop("recipient", None)

    return_type = kwargs.pop("return_type", "last")

    all_messages = kwargs.pop("all_messages", None)
    if all_messages is None:
        logging.warning("No all_messages list provided!")
        all_messages = []

    # with tempfile.TemporaryDirectory() as temp_dir:
    if True:
        #mark the temp_dir for later upload
        temp_dir = get_request_temp_dir(request_id)
        code_executor = autogen.coding.LocalCommandLineCodeExecutor(work_dir=temp_dir,timeout=300)

        assistant = AssistantAgent("assistant", llm_config=llm_config, system_message=prompt, is_termination_msg=is_termination_msg)
        user_proxy = UserProxyAgent("user_proxy", human_input_mode="NEVER", max_consecutive_auto_reply=20,
                                    code_execution_config={"executor": code_executor},
                                    is_termination_msg=is_termination_msg)
        
        def create_send_function(agent):
            nonlocal request_reply, silent, request_id, chat_publish_progress, all_messages, return_type, message, recipient, user_proxy, assistant
            original_send = agent.send
            def send(message, recipient, request_reply=None, silent=True):
                return logged_send(agent, original_send, message, recipient, request_reply, silent, request_id, chat_publish_progress, all_messages)
            return send

        assistant.send = create_send_function(assistant)
        user_proxy.send = create_send_function(user_proxy)

        message_with_possible_human_input = get_message_with_user_input(message, request_id)

        chat_result = user_proxy.initiate_chat(
            assistant, 
            message=message_with_possible_human_input, 
        )


    code_msg = find_code_message(all_messages)
    if code_msg:
        try:
            corrector = AssistantAgent("code_corrector", llm_config=llm_config, system_message=prompts.get("CODE_CORRECTOR_PROMPTER_SYSTEM_MESSAGE"))
            corrector_result = corrector.generate_reply(messages=[{"content": code_msg, "role":"user"}])

            logging.info(f"Code corrector result: {corrector_result}")

            index_message({
                "requestId": request_id,
                "content":corrector_result, #code_msg,
                "task": get_message_with_user_input(original_request_message,request_id),
                "contextId": original_request_message_data.get("contextId"),
            })
        except Exception as e:
            logging.error(f"Error extracting code corrector result: {e}")

    if return_type == "chat_history":
        return chat_result.chat_history
    if return_type == "chat_result":
        return chat_result
    if return_type == "summary":
        return chat_result.summary
    if return_type == "last":
        return chat_result.chat_history[-1]["content"] or chat_result.chat_history[-2]["content"]
    if return_type == "all_as_str":
        return "\n".join([msg['content'] for msg in chat_result.chat_history])

    return chat_result 


def logged_send(sender, original_send, message, recipient, request_reply=None, silent=True, request_id=None, chat_publish_progress=None, all_messages=None):
    if not message:
        logging.info("Empty message, skipping!")
        return
    if not request_id:
        logging.warning("No request_id provided!")

    all_messages.append({
        "sender": sender.name,
        "message": message
    })

    if chat_publish_progress:
        chat_publish_progress({
            "info": message
        })
    else:
        logging.warning("No chat_publish_progress function provided!")
        logging.log(logging.INFO, message)
    

    if request_id in human_input_queues and not human_input_queues[request_id].empty():
        human_input = human_input_queues[request_id].get()
        if human_input:
            if human_input == "TERMINATE":
                logging.info("Terminating conversation")
                raise Exception("Conversation terminated by user")
            elif human_input == "PAUSE":
                logging.info("Pausing conversation")
                pause_start = time.time()
                while time.time() - pause_start < 60*15:  # 15 minutes pause timeout
                    time.sleep(10)
                    new_input = check_for_human_input(request_id)
                    if new_input:
                        logging.info(f"Resuming conversation with human input: {new_input}")
                        return logged_send(sender, original_send, new_input, recipient, request_reply, silent)
                logging.info("Pause timeout, ending conversation")
                raise Exception("Conversation ended due to pause timeout")

            #if not terminate or pause, then it's text input from human
            logging.info(f"Human input to {recipient.name}: {human_input}")
            #need to update original message with human input
            new_input = message + human_input
            return original_send(new_input, recipient, request_reply, silent)

    logging.info(f"Message from {sender.name} to {recipient.name}: {message}")

    return original_send(message, recipient, request_reply, silent)


def process_message(original_request_message_data, original_request_message_data_obj, first_run=True):    
    try:
        all_messages = []
        started_at = datetime.now()
        request_id = original_request_message_data.get('requestId') or original_request_message_data.id
        original_request_message = original_request_message_data['message']

        human_input_queues[request_id] = queue.Queue()
        human_input_text_queues[request_id] = queue.Queue()

        if first_run:
            thread = threading.Thread(target=background_human_input_check, args=(request_id,))
            thread.daemon = True
            thread.start()

        final_msg = process_message_safe(original_request_message_data, original_request_message_data_obj, original_request_message,  all_messages, request_id, started_at)

        finalData = {
            "requestId": request_id,
            "requestMessage": original_request_message_data.get("message"),
            "progress": 1,
            "data": final_msg,
            "contextId": original_request_message_data.get("contextId"),
            "conversation": all_messages,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "insertionTime": original_request_message_data_obj.insertion_time.astimezone(timezone.utc).isoformat(),
            "startedAt": started_at.astimezone(timezone.utc).isoformat(),
            "tool": "{\"toolUsed\":\"coding\"}"
        }       

        publish_request_progress(finalData)
        store_in_mongo(finalData)

        #wait for any human input before terminating
        #if you receive human input start the conversation again
        for i in range(16*6): # 15+1 minutes
            if human_input_queues[request_id].empty():
                time.sleep(1)
            else:
                human_input = human_input_queues[request_id].get()
                if human_input:
                    logging.info(f"Human input to assistant: {human_input}")
                    #update request with human input
                    new_message_data = original_request_message_data.copy()
                    new_message_data['message'] = human_input
                    new_message_data['keywords'] = ''
                    # new_message_data_obj = original_request_message_data_obj.copy()
                    # new_message_data_obj['message'] = new_message_data['message']

                    process_message(new_message_data, original_request_message_data_obj, first_run=False)
                    return

        logging.info(f"Task completed, task:\n{get_message_with_user_input(original_request_message,request_id)},\nresult: {final_msg}")


    except Exception as e:
        logging.error(f"Error processing message: {str(e)}")
        try:
            if request_id:
                publish_request_progress({
                    "requestId": request_id,
                    "progress": 1,
                    "error": str(e),
                    "data": str(e),
                })
                store_in_mongo({
                    "requestId": request_id,
                    "requestMessage": original_request_message_data.get("message"),
                    "progress": 1,
                    "error": str(e),
                    "data": str(e),
                    "contextId": original_request_message_data.get("contextId"),
                    "conversation": all_messages,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "insertionTime": original_request_message_data_obj.insertion_time.astimezone(timezone.utc).isoformat(),
                    "startedAt": started_at.astimezone(timezone.utc).isoformat(),
                    "tool": "{\"toolUsed\":\"coding\"}"
                })
        except Exception as e:
            logging.error(f"Error processing message finish publish&store: {str(e)}")
    finally:
        try:
            #clean up the temp folder
            temp_dir = get_request_temp_dir(request_id)
            if temp_dir:
                #validate cortex_autogen folder in temp_dir path
                if "/cortex_autogen/" in temp_dir:
                    shutil.rmtree(temp_dir)
                else:
                    logging.warning(f"Invalid temp_dir path: {temp_dir}, not deleting")
        except Exception as e:
            logging.error(f"Error cleaning up: {str(e)}")
            

def process_message_safe(original_request_message_data, original_request_message_data_obj, original_request_message,  all_messages, request_id, started_at):
    config_list = config_list_from_json(env_or_file="OAI_CONFIG_LIST")
    llm_config = {
        "config_list": config_list,
        "base_url": os.environ.get("CORTEX_API_BASE_URL"),
        "api_key": os.environ.get("CORTEX_API_KEY"),
        "cache_seed": None,
        "timeout": 600 * 2
    }

    total_messages = 30 # set this for updates % progress's max just a guess
    message_count = 0 # updates % progress 

    def chat_publish_progress(data):
        nonlocal message_count
        message = data.get("message") or data.get("info") or data.get("content")
        message_count += 1
        progress = min(message_count / total_messages, 1)
        publish_request_progress({
            "requestId": request_id,
            "progress": progress,
            "info": message
        })

    def chat(*args,**kwargs):
        nonlocal llm_config, request_id, chat_publish_progress, all_messages, original_request_message_data, original_request_message_data_obj, original_request_message
        def get_arg_or_kwarg(name, pos, args, kwargs):
            if args and kwargs.get(name): 
                logging.warning(f"Both positional argument and keyword argument given for {name}, using keyword argument")
            if kwargs.get(name):
                return kwargs.get(name)
            if len(args) > pos:
                return args[pos]
            return None

        kwargs["prompt"] = get_arg_or_kwarg("prompt", 0, args, kwargs)
        kwargs["message"] = get_arg_or_kwarg("message", 1, args, kwargs)
        kwargs["llm_config"] = llm_config
        kwargs["request_id"] = request_id
        kwargs["chat_publish_progress"] = chat_publish_progress
        kwargs["all_messages"] = all_messages
        kwargs["original_request_message_data"] = original_request_message_data
        kwargs["original_request_message_data_obj"] = original_request_message_data_obj
        kwargs["original_request_message"] = original_request_message

        return chat_with_agents(**kwargs)


    preparer = AssistantAgent("preparer", llm_config=llm_config, system_message=prompts.get("PLANNER_SYSTEM_MESSAGE"))
    prepared_plan = preparer.generate_reply(messages=[{"content": get_message_with_user_input(original_request_message,request_id), "role":"user"}])

    helper_decider = AssistantAgent("helper_decider", llm_config=llm_config, system_message=prompts.get("HELPER_DECIDER_SYSTEM_MESSAGE"))
    helper_decider_result = helper_decider.generate_reply(messages=[{"content": get_message_with_user_input(original_request_message,request_id), "role":"user"}])

    try:
        helper_decider_result = json.loads(helper_decider_result)
        logging.info(f"Helper decider result: {helper_decider_result}")
    except Exception as e:
        logging.error(f"Error parsing helper decider result: {e}")
        helper_decider_result = {}

    context = ""

    code_keywords = original_request_message_data.get("keywords") or original_request_message_data.get("message")
    if code_keywords:
        context += f"\n#SECTION_OF_OLD_TASK_CODE_INFO_START:\nHere's code/info from old-tasks that might help:\n{search_index(code_keywords)}\n#SECTION_OF_OLD_TASK_CODE_INFO_END\n"

    if helper_decider_result.get("bing_search"):
        bing_search_message = f"Search Bing for more information on the task: {get_message_with_user_input(original_request_message,request_id)}, prepared draft plan to solve task: {prepared_plan}"
        result = chat(prompts.get("BING_SEARCH_PROMPT"), bing_search_message)
        context += f"\n\nBing search results: {result}"

    if helper_decider_result.get("cognitive_search"):
        cognitive_search_message = f"Search cognitive index for more information on the task: {get_message_with_user_input(original_request_message,request_id)}."
        result = chat(prompts.get("COGNITIVE_SEARCH_PROMPT"), cognitive_search_message)
        context += f"\n\nCognitive search results: {result}"


    context = process_helper_results(helper_decider_result, get_message_with_user_input(original_request_message,request_id), context, chat) 

    context_message = ""
    if context:
        context_message = f"\n\nHere is some data from search results and helpful stuff already collected and worked on, use if helpful:\n{context}\n\n"


    check_message = f"""
Task: \n{get_message_with_user_input(original_request_message,request_id)}\n\n
Context to check if task can be considered completed: {context_message}\n\n
    """

    task_completion_checker = AssistantAgent("task_completion_checker", llm_config=llm_config, system_message=TASK_COMPLETE_CHECKER_SYSTEM_MESSAGE)
    check_result = task_completion_checker.generate_reply(messages=[{"content": check_message, "role":"user"}])

    chat_result = None
    if check_result != "DONE":
        message = f"""
Your task is to complete the following: \n{get_message_with_user_input(original_request_message,request_id)}\n\n"
Here is a draft plan to solve the task: \n{prepared_plan}\n\n 
{context_message}
You don't have to follow the plan, it's just a suggestion.
Do your best to complete the task, user expects you to continue original task request conversation.
"""
        chat_result = chat(prompts.get("GENERIC_ASSISTANT_SYSTEM_MESSAGE"), message, return_type="chat_result")

    presenter = AssistantAgent("presenter", llm_config=llm_config, system_message=prompts.get("PRESENTER_SYSTEM_MESSAGE"))
    if chat_result is not None:
        presenter_messages_context = "\n\n".join([msg['content'] for msg in chat_result.chat_history])
    else:
        presenter_messages_context = context_message
    presenter_message = f"""
Here is everything done in order to complete the task: {presenter_messages_context}\n\n 
Original task was: {get_message_with_user_input(original_request_message,request_id)}\n\n
Reply to it with task result, do not forget that user expects you continue original task request conversation:\n\n
"""

    presenter_result = presenter.generate_reply(messages=[{"content": presenter_message, "role":"user"}])
    
    final_msg = presenter_result


    zip_url = zip_and_upload_tmp_folder(get_request_temp_dir(request_id))
    if zip_url and len(zip_url) > 0:
        final_msg += f"\n\n[Download all files of this task]({zip_url})"
    
    
    print(f"Task completed, task:\n{get_message_with_user_input(original_request_message,request_id)},\nresult: {final_msg}")
    logging.info(f"Task completed, task:\n{get_message_with_user_input(original_request_message,request_id)},\nresult: {final_msg}")
    return final_msg