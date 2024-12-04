from dotenv import load_dotenv
import os
import requests
import logging
import json
import redis
from azure.storage.blob import BlobServiceClient, generate_blob_sas, BlobSasPermissions
from datetime import datetime, timedelta
from config import AZURE_STORAGE_CONNECTION_STRING, AZURE_BLOB_CONTAINER, REDIS_CONNECTION_STRING, REDIS_CHANNEL
import zipfile
from datetime import timezone

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
    
def zip_and_upload_tmp_folder(temp_dir):
    # Check if no files in temp_dir
    if not os.listdir(temp_dir) or len(os.listdir(temp_dir)) == 0:
        logging.info(f"No files in {temp_dir}")
        return ""

    zip_path = os.path.join(temp_dir, "tmp_contents.zip")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, _, files in os.walk(temp_dir):
            for file in files:
                file_path = os.path.join(root, file)

                # Skip adding the zip file itself to the archive
                if file_path == zip_path:
                    continue

                arcname = os.path.relpath(file_path, temp_dir)
                zipf.write(file_path, arcname)

    blob_service_client = BlobServiceClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING)
    blob_name = f"tmp_contents_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}.zip"
    blob_client = blob_service_client.get_blob_client(container=AZURE_BLOB_CONTAINER, blob=blob_name)

    with open(zip_path, "rb") as data:
        blob_client.upload_blob(data)

    account_key = blob_service_client.credential.account_key
    account_name = blob_service_client.account_name
    expiry = datetime.now(timezone.utc) + timedelta(hours=1)

    sas_token = generate_blob_sas(
        account_name,
        AZURE_BLOB_CONTAINER,
        blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry
    )

    return f"{blob_client.url}?{sas_token}"

redis_client = redis.from_url(REDIS_CONNECTION_STRING)

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
            redis_client.publish(REDIS_CHANNEL, message)
        except Exception as e:
            logging.error(f"Error publishing message: {e}")