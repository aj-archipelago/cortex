import os
from dotenv import load_dotenv

load_dotenv()

AZURE_STORAGE_CONNECTION_STRING = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
HUMAN_INPUT_QUEUE_NAME = os.environ.get("HUMAN_INPUT_QUEUE_NAME", "autogen-human-input-queue")
REDIS_CONNECTION_STRING = os.environ['REDIS_CONNECTION_STRING']
REDIS_CHANNEL = 'requestProgress'
AZURE_BLOB_CONTAINER = os.environ.get("AZURE_BLOB_CONTAINER", "autogen-uploads")


# Prompts
import prompts
import prompts_extra

prompts = {**prompts.__dict__, **prompts_extra.__dict__}

